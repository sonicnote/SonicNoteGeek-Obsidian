import { Plugin, Notice, TFile, MarkdownView, WorkspaceLeaf, addIcon } from "obsidian";
import type { TemplateType, TranscriptionTask, TranscriptSegment } from "./src/types";
import { SonicNoteGeekSettingTab, DEFAULT_SETTINGS } from "./src/settings";
import { SonicNoteGeekView, VIEW_TYPE_SONICNOTE_GEEK } from "./src/view";
import { AudioProcessor } from "./src/processor";
import { getTemplate } from "./src/templates";
import { generateOutput } from "./src/utils/output-generator";
import { SonicNoteApiClient } from "./src/sync/api";
import { SyncService } from "./src/sync/sync";

export default class SonicNoteGeekPlugin extends Plugin {
  settings = DEFAULT_SETTINGS;
  processor: AudioProcessor = new AudioProcessor();

  // Sync
  syncApi!: SonicNoteApiClient;
  syncService!: SyncService;
  private syncStatusBarEl!: HTMLElement;
  private syncTimer: number | null = null;
  private syncing = false;

  async onload() {
    await this.loadSettings();

    // 注册自定义 "聆" 字图标
    addIcon("sonicnote-listen", `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><text x="12" y="17" text-anchor="middle" font-size="14" stroke="none" fill="currentColor">聆</text></svg>`);

    // ===== 初始化文件同步 =====
    this.syncApi = new SonicNoteApiClient(() => this.settings.sync);
    this.syncService = new SyncService(
      this.app,
      this.syncApi,
      () => this.settings.sync,
      () => this.saveSettings()
    );

    // 同步状态栏
    this.syncStatusBarEl = this.addStatusBarItem();
    this.updateSyncStatusBar();

    // 注册设置 Tab（合并了同步设置）
    this.addSettingTab(new SonicNoteGeekSettingTab(this.app, this));

    // 注册右侧面板视图
    this.registerView(
      VIEW_TYPE_SONICNOTE_GEEK,
      (leaf) => new SonicNoteGeekView(leaf, this),
    );

    // 左栏图标 → 打开右侧面板
    this.addRibbonIcon("sonicnote-listen", "SonicNoteGeek 音频转写", () => {
      this.activateView();
    });

    // 命令面板
    this.addCommand({
      id: "open-sonicnote-asr",
      name: "打开音频转写面板",
      icon: "sonicnote-listen",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "quick-transcribe",
      name: "快速转写 (使用默认设置)",
      icon: "zap",
      callback: () => this.quickTranscribe(),
    });

    this.addCommand({
      id: "sonicnote-sync-files",
      name: "同步妙记录音文件",
      icon: "cloud-download",
      callback: () => this.triggerSync(),
    });

    this.addCommand({
      id: "extract-voiceprint",
      name: "从当前行提取声纹样本",
      icon: "mic",
      callback: () => this.extractVoiceprintFromLine(),
    });

    // 文件右键菜单
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("SonicNoteGeek 音频转写")
              .setIcon("sonicnote-listen")
              .onClick(() => this.activateView());
          });
        }
      }),
    );

    // 编辑器右键菜单
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem((item) => {
          item
            .setTitle("SonicNoteGeek 音频转写")
            .setIcon("sonicnote-listen")
            .onClick(() => this.activateView());
        });

        // 当前行是逐字稿段落 → 显示"提取声纹样本"菜单
        const line = editor.getLine(editor.getCursor().line);
        if (/^\*\*\[\d{2}:\d{2}(?::\d{2})?\]\s*.+[：:]\*\*/.test(line)) {
          menu.addItem((item) => {
            item
              .setTitle("提取声纹样本")
              .setIcon("mic")
              .onClick(() => this.extractVoiceprintFromLine());
          });
        }
      }),
    );

    console.log('SonicNoteGeek plugin loaded');

    // 启动时自动同步
    if (this.settings.sync.autoSyncOnOpen && this.syncApi.isAuthenticated()) {
      setTimeout(() => this.triggerSync(), 5000);
    }

    // 定时自动重同步
    this.startAutoSync();
  }

  onunload() {
    this.stopAutoSync();
    console.log('SonicNoteGeek plugin unloaded');
  }

  async triggerSync() {
    if (!this.syncApi.isAuthenticated()) {
      new Notice('请先登录 SonicNote（设置 → SonicNoteGeek → 文件同步）');
      return;
    }

    if (this.syncing) return;
    this.syncing = true;
    this.stopAutoSync();

    this.syncStatusBarEl.setText('SonicNote: 同步中...');

    try {
      const result = await this.syncService.syncAll((msg) => {
        this.syncStatusBarEl.setText(`SonicNote: ${msg}`);
      });

      let message = `同步完成: ${result.synced} 条新/更新`;
      if (result.skipped > 0) message += `, ${result.skipped} 条跳过`;
      if (result.errors > 0) message += `, ${result.errors} 条失败`;

      new Notice(message, 5000);
      this.updateSyncStatusBar();
    } catch (e) {
      new Notice(`同步失败: ${e instanceof Error ? e.message : '未知错误'}`);
      this.updateSyncStatusBar();
    } finally {
      this.syncing = false;
      this.startAutoSync();
    }
  }

  updateSyncStatusBar() {
    if (this.syncApi.isAuthenticated()) {
      const lastSync = this.settings.sync.lastSyncTime
        ? `上次同步: ${this.settings.sync.lastSyncTime}`
        : '未同步';
      this.syncStatusBarEl.setText(`SonicNote: ${lastSync}`);
    } else {
      this.syncStatusBarEl.setText('SonicNote: 未登录');
    }
  }

  startAutoSync() {
    this.stopAutoSync();
    const minutes = this.settings.sync.resyncIntervalMinutes;
    if (minutes > 0 && this.syncApi.isAuthenticated()) {
      this.syncTimer = window.setInterval(() => {
        this.triggerSync();
      }, minutes * 60 * 1000);
    }
  }

  stopAutoSync() {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  // ===== 激活右侧面板 =====
  async activateView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(VIEW_TYPE_SONICNOTE_GEEK)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_SONICNOTE_GEEK, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  // ===== 快速转写 =====
  private async quickTranscribe() {
    const sourceFile = this.getActiveFile();
    if (!sourceFile) {
      new Notice("请先打开一个 Markdown 文件");
      return;
    }

    const { extractMp3Links, findMp3Attachments } = await import("./src/utils/mp3-extractor");
    const content = await this.app.vault.read(sourceFile);
    const links = extractMp3Links(content);
    const attachments = await findMp3Attachments(this.app.vault, sourceFile);
    const allMp3s = [...links, ...attachments];

    if (allMp3s.length === 0) {
      new Notice("当前文档中未检测到 MP3 链接");
      return;
    }

    const progressNotice = new Notice("正在快速处理...", 0);

    try {
      await this.runProcessing(
        allMp3s, this.getActiveASRConfig(), this.settings.speakerDiarization,
        this.getActiveLLMConfig(), "business-meeting", this.settings.hotWords,
        this.settings.voiceprintLibrary, sourceFile,
        (stageIndex, label) => { progressNotice.setMessage(`${label}...`); },
      );
      progressNotice.hide();
    } catch (error) {
      progressNotice.hide();
      new Notice(`快速处理失败: ${error instanceof Error ? error.message : "未知错误"}`);
      console.error("SonicNoteGeek error:", error);
    }
  }

  // ===== 从当前编辑器行提取声纹样本 =====
  private async extractVoiceprintFromLine() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("请先打开一个 Markdown 文件"); return; }

    const editor = view.editor;
    const line = editor.getLine(editor.getCursor().line);
    const match = line.match(/^\*\*\[(\d{2}:\d{2}(?::\d{2})?)\]\s*(.+?)[：:]\*\*/);
    if (!match) { new Notice("当前行不是逐字稿段落"); return; }

    const startSec = this.parseTimestamp(match[1]);
    const speakerName = match[2].trim();
    const duration = 6; // 截取6秒

    // 查找音频文件
    const sourceFile = view.file;
    if (!sourceFile) { new Notice("未找到关联文件"); return; }
    const audioPath = await this.findAudioForFile(sourceFile);
    if (!audioPath) { new Notice("未找到关联的音频文件，请在文档中添加音频链接或确保音频已下载"); return; }

    // 输出路径
    const vaultBase = (this.app.vault.adapter as any).basePath || "";
    const safeName = speakerName.replace(/[\/\\:*?"<>|]/g, "_");
    const timeStr = match[1].replace(/:/g, "");
    const outDir = `${vaultBase}/SonicNoteSync/voiceprints`;
    const outFile = `${outDir}/${safeName}_${timeStr}.wav`;

    try {
      // 创建目录
      const { mkdirSync } = require("fs");
      mkdirSync(outDir, { recursive: true });

      // 截取音频
      this.processor.cutAudioSegment(audioPath, startSec, duration, outFile);

      // 注册到声纹库
      const vpRelPath = `SonicNoteSync/voiceprints/${safeName}_${timeStr}.wav`;
      this.settings.voiceprintLibrary.push({
        id: `vp_${Date.now()}`,
        name: speakerName,
        audioSamplePath: vpRelPath,
        description: `从 "${sourceFile.basename}" 提取，时间 ${match[1]}`,
      });
      await this.saveSettings();

      new Notice(`已提取声纹样本: ${speakerName} → ${vpRelPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`提取失败: ${msg}`);
      console.error("extractVoiceprint error:", e);
    }
  }

  /** 查找 MD 文件关联的音频文件 (返回绝对路径) */
  private async findAudioForFile(sourceFile: TFile): Promise<string | null> {
    const content = await this.app.vault.read(sourceFile);
    const vaultBase = (this.app.vault.adapter as any).basePath || "";

    // 1. 文档中的 MP3 链接
    const { extractMp3Links } = await import("./src/utils/mp3-extractor");
    const links = extractMp3Links(content);
    for (const link of links) {
      if (link.startsWith("http")) continue;
      const f = this.app.vault.getAbstractFileByPath(link);
      if (f) return `${vaultBase}/${link}`;
    }

    // 2. 文档中嵌入的音频 ![[audio.mp3]]
    const embedMatch = content.match(/!\[\[([^\]]+\.(mp3|wav|m4a|flac))\]\]/i);
    if (embedMatch) {
      const f = this.app.vault.getAbstractFileByPath(embedMatch[1]);
      if (f) return `${vaultBase}/${embedMatch[1]}`;
    }

    // 3. SonicNoteSync/Audio/{文档名} 目录
    const audioDir = `SonicNoteSync/Audio/${sourceFile.basename}`;
    try {
      const listing = await (this.app.vault.adapter as any).list?.(audioDir);
      for (const fPath of (listing?.files || [])) {
        if (/\.(mp3|wav|m4a|flac)$/i.test(fPath)) {
          return `${vaultBase}/${fPath}`;
        }
      }
    } catch {}

    // 4. processor 缓存路径
    for (const p of this.processor.lastDownloadedPaths) {
      if (!p.startsWith("http")) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) return `${vaultBase}/${p}`;
      }
    }

    return null;
  }

  /** 解析 HH:MM:SS 或 MM:SS 为秒数 */
  private parseTimestamp(ts: string): number {
    const parts = ts.split(":");
    if (parts.length === 3) {
      return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }

  // ===== 获取当前激活的 ASR 模型名称 =====
  getActiveASRModelName(): string {
    const activeModel = this.settings.asrModels.find(
      (m) => m.id === this.settings.activeAsrModelId,
    );
    if (activeModel) {
      return activeModel.displayName || activeModel.preset;
    }
    return "默认配置";
  }

  // ===== 获取当前激活的 LLM 模型名称 =====
  getActiveLLMModelName(): string {
    const activeModel = this.settings.llmModels.find(
      (m) => m.id === this.settings.activeModelId,
    );
    if (activeModel) {
      return activeModel.displayName || activeModel.provider;
    }
    return this.settings.llm.provider;
  }

  // ===== 获取当前激活的 ASR 配置 =====
  getActiveASRConfig(): typeof this.settings.asr {
    const activeModel = this.settings.asrModels.find(
      (m) => m.id === this.settings.activeAsrModelId,
    );
    if (activeModel) {
      return {
        protocol: activeModel.protocol,
        apiKey: activeModel.apiKey,
        secretKey: activeModel.secretKey,
        apiUrl: activeModel.apiUrl,
        resourceId: activeModel.resourceId,
        appId: activeModel.appId,
        model: activeModel.model,
        localEndpoint: activeModel.localEndpoint,
        language: activeModel.language,
        enableSpeakerDiarization: activeModel.enableSpeakerDiarization,
      };
    }
    return this.settings.asr;
  }

  // ===== 获取当前激活的 LLM 配置 =====
  getActiveLLMConfig(): typeof this.settings.llm {
    const activeModel = this.settings.llmModels.find(
      (m) => m.id === this.settings.activeModelId,
    );
    if (activeModel) {
      return {
        provider: activeModel.provider,
        apiFormat: activeModel.apiFormat,
        apiKey: activeModel.apiKey,
        apiUrl: activeModel.apiUrl,
        model: activeModel.model,
        maxTokens: activeModel.maxTokens || 4096,
        temperature: activeModel.temperature ?? 0.7,
      };
    }
    return this.settings.llm;
  }

  // ===== 核心处理流程 =====
  async runProcessing(
    mp3Urls: string[],
    asrConfig: typeof this.settings.asr,
    speakerConfig: typeof this.settings.speakerDiarization,
    llmConfig: typeof this.settings.llm,
    templateType: TemplateType,
    hotWords: typeof this.settings.hotWords,
    voiceprintLibrary: typeof this.settings.voiceprintLibrary,
    sourceFile: TFile,
    progressCallback: (stageIndex: number, label: string) => void,
    customPrompt?: string,
  ): Promise<string> {
    const task: TranscriptionTask = {
      id: `task_${Date.now()}`,
      mp3Urls, asrConfig, speakerConfig, llmConfig,
      template: templateType, hotWords, voiceprintLibrary,
      customPrompt,
      createdAt: Date.now(),
    };

    const output = await this.processor.process(
      task, this.app.vault, sourceFile.basename, progressCallback,
      this.getActiveASRModelName(),
    );

    // 拆分输出: 总结→文档开头(YAML后) | 转录原文→文档末尾
    const splitMarker = "\n\n---\n\n## 转录信息";
    const splitIdx = output.indexOf(splitMarker);
    const summaryPart = splitIdx !== -1 ? output.substring(0, splitIdx) : "";
    const transcriptPart = splitIdx !== -1 ? output.substring(splitIdx) : output;

    const existingContent = await this.app.vault.read(sourceFile);
    // 删除旧输出
    const oldCutIdx = this.findOldOutputStart(existingContent);
    let cleaned = oldCutIdx !== -1
      ? existingContent.substring(0, oldCutIdx)
      : existingContent;

    // 总结部分插入到文档开头（跳过 YAML frontmatter）
    if (summaryPart) {
      let insertIdx = 0;
      if (cleaned.startsWith("---\n")) {
        const closeIdx = cleaned.indexOf("\n---\n", 4);
        if (closeIdx !== -1) insertIdx = closeIdx + 5;
      }
      cleaned = cleaned.substring(0, insertIdx) + "\n\n" + summaryPart + cleaned.substring(insertIdx);
    }

    // 转录原文追加到文档末尾
    await this.app.vault.modify(sourceFile, cleaned + transcriptPart);

    new Notice("转写完成!");
    return output;
  }

  // ===== 重新转写: 删除旧转录原文(文档末尾)，写入新的 =====
  async reTranscribe(
    sourceFile: TFile,
    templateType: TemplateType,
    customPrompt?: string,
  ): Promise<string> {
    const asrConfig = this.getActiveASRConfig();
    const isCloudASR = !asrConfig.protocol.startsWith("local-") && asrConfig.protocol !== "xunfei";

    let audioPaths: string[] = [];
    if (isCloudASR) {
      audioPaths = this.processor.lastOriginalUrls.length > 0
        ? this.processor.lastOriginalUrls
        : await this.findOriginalUrls(sourceFile);
      // 如果没找到 HTTP URL，回退到本地已下载的音频文件
      if (audioPaths.length === 0) {
        audioPaths = await this.findDownloadedAudio(sourceFile);
      }
    } else {
      audioPaths = await this.findDownloadedAudio(sourceFile);
    }

    if (audioPaths.length === 0) {
      throw new Error("未找到音频文件，请先执行「开始转写总结」下载音频");
    }
    const speakerConfig = this.settings.speakerDiarization;
    const voiceprintLibrary = this.settings.voiceprintLibrary;
    const hotWords = this.settings.hotWords;
    const asrModelName = this.getActiveASRModelName();

    // 确保 vaultBasePath 已设置（xunfei/tencent/baidu/huawei 需要读取本地音频文件）
    this.processor.vaultBasePath = (this.app.vault.adapter as any).basePath || "";

    const transcript = await this.processor.transcribeOnly(
      audioPaths, asrConfig, speakerConfig, voiceprintLibrary, hotWords,
    );

    const template = getTemplate(templateType)
      || (templateType === "custom" && customPrompt
        ? { type: "custom" as const, name: "自定义", description: "", systemPrompt: customPrompt, outputFormat: "" }
        : null);
    if (!template) throw new Error("未找到指定的总结模板");

    const output = generateOutput(
      { taskId: `retask_${Date.now()}`, transcript, summary: "", keywords: [], actionItems: [], duration: 0, language: asrConfig.language, speakerCount: new Set(transcript.map((s) => s.speaker)).size },
      template, sourceFile.basename, asrModelName, audioPaths,
    );

    // 删除旧转录信息+转录原文（连同上方 --- 分隔线一起删，新输出自带 ---）
    const existingContent = await this.app.vault.read(sourceFile);
    const cutIdx = this.findOldOutputStart(existingContent);
    const cleanedContent = cutIdx !== -1
      ? existingContent.substring(0, cutIdx)
      : existingContent;

    // 去掉 generateOutput 结果开头的多余 --- 行，新输出已有 --- 分隔线
    const trimmedOutput = output.replace(/^(?:\n\n---)+/, "").trimStart();

    // 新转录原文写入文档末尾
    await this.app.vault.modify(sourceFile, cleanedContent + "\n\n---\n\n" + trimmedOutput);

    new Notice("重新转写完成! 已覆盖旧转录原文");
    return output;
  }

  // ===== 重新总结: 基于转录原文总结，新总结插入到转录原文之前 =====
  async reSummarize(
    sourceFile: TFile,
    templateType: TemplateType,
    customPrompt?: string,
  ): Promise<string> {
    const content = await this.app.vault.read(sourceFile);
    const transcript = this.parseTranscriptFromContent(content);

    if (transcript.length === 0) {
      throw new Error("未在文档中找到转录原文，请先执行「开始转写总结」或「重新转写」");
    }

    const llmConfig = this.getActiveLLMConfig();

    const result = await this.processor.summarizeOnly(
      transcript, llmConfig, templateType, customPrompt,
    );

    let summaryMd = `\n\n---\n## 重新总结\n\n${result.summary}`;
    if (result.keywords.length > 0) {
      summaryMd += `\n\n**关键词**: ${result.keywords.join("、")}`;
    }
    if (result.actionItems.length > 0) {
      summaryMd += `\n\n**行动项**:\n${result.actionItems.map((a) => `- [ ] ${a}`).join("\n")}`;
    }

    const existingContent = await this.app.vault.read(sourceFile);

    // 新总结追加到文档最开头（跳过 YAML frontmatter）
    let insertIdx = 0;
    if (existingContent.startsWith("---\n")) {
      const closeIdx = existingContent.indexOf("\n---\n", 4);
      if (closeIdx !== -1) {
        insertIdx = closeIdx + 5; // 跳过 "---\n"
      }
    }

    const before = existingContent.substring(0, insertIdx);
    const after = existingContent.substring(insertIdx);
    await this.app.vault.modify(sourceFile, before + summaryMd + after);

    new Notice("重新总结完成!");
    return result.summary;
  }

  /** 找到旧输出开始位置（含 --- 分隔线），无匹配返回 -1 */
  private findOldOutputStart(content: string): number {
    // 按优先级: --- + ## 转录信息 → --- + ## 转录原文 → ## 转录信息 → ## 转录原文
    const markers = [
      "\n\n---\n\n## 转录信息",
      "\n\n---\n\n## 转录原文",
      "\n\n## 转录信息",
      "\n\n## 转录原文",
    ];
    let bestIdx = -1;
    for (const m of markers) {
      const idx = content.indexOf(m);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
      }
    }
    return bestIdx;
  }

  /** 查找已下载到 vault 的音频文件 */
  private async findDownloadedAudio(sourceFile: TFile): Promise<string[]> {
    const paths: string[] = [];

    // 1. processor 缓存路径
    for (const p of this.processor.lastDownloadedPaths) {
      if (!p.startsWith("http")) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) paths.push(p);
      }
    }

    // 2. SonicNoteSync/Audio 目录
    const audioDir = `SonicNoteSync/Audio/${sourceFile.basename}`;
    try {
      const listing = await (this.app.vault.adapter as any).list?.(audioDir);
      for (const fPath of (listing?.files || [])) {
        if (/\.(mp3|wav|m4a|flac)$/i.test(fPath) && !paths.includes(fPath)) {
          paths.push(fPath);
        }
      }
    } catch {}

    return paths;
  }

  /** 从文档中提取原始音频 URL（供云端 ASR 重新转写使用） */
  private async findOriginalUrls(sourceFile: TFile): Promise<string[]> {
    const urls: string[] = [];
    const content = await this.app.vault.read(sourceFile);

    // 转录输出中的"原始音频"字段 (generateOutput 生成)
    const origAudioMatch = content.match(/\*\*原始音频\*\*[：:]\s*(https?:\/\/[^\s\n]+)/g);
    if (origAudioMatch) {
      for (const m of origAudioMatch) {
        const u = m.replace(/\*\*原始音频\*\*[：:]\s*/, "").trim();
        if (u.startsWith("http") && !urls.includes(u)) urls.push(u);
      }
    }

    // audio_url 字段
    const audioUrlMatch = content.match(/audio_url[：:]\s*["']?([^"'\s]+)["']?/m);
    if (audioUrlMatch) {
      const u = audioUrlMatch[1].trim().replace(/["']$/, "");
      if (u.startsWith("http")) urls.push(u);
    }

    // MP3 链接
    const { extractMp3Links } = await import("./src/utils/mp3-extractor");
    for (const link of extractMp3Links(content)) {
      if (link.startsWith("http") && !urls.includes(link)) urls.push(link);
    }

    return urls;
  }

  /** 从 MD 文档中解析逐字稿段落 */
  private parseTranscriptFromContent(content: string): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    const pattern = /\*\*\[(\d{2}:\d{2}(?::\d{2})?)\]\s*(.+?)[：:]\*\*\s*(.+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const startTime = match[1];
      const speaker = match[2].trim();
      const text = match[3].trim();
      const parts = startTime.split(":");
      let endSec = 0;
      if (parts.length === 3) {
        endSec = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
      } else {
        endSec = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
      }
      endSec += Math.max(1, text.length / 3);
      const h = Math.floor(endSec / 3600);
      const m = Math.floor((endSec % 3600) / 60);
      const s = Math.floor(endSec % 60);
      segments.push({
        startTime,
        endTime: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`,
        speaker,
        text,
      });
    }
    return segments;
  }

  private getActiveFile(): TFile | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
