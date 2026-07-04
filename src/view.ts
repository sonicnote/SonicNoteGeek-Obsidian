import {
  ItemView, WorkspaceLeaf, Notice, TFile, Setting, MarkdownView, Modal, App,
  setIcon, setTooltip, MarkdownRenderer, requestUrl,
} from "obsidian";
import type { TemplateType, SummaryTemplate, VoiceprintEntry } from "./types";
import { extractMp3Links, findMp3Attachments } from "./utils/mp3-extractor";
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from "./templates";
import { AddModelModal, renderModelList } from "./utils/model-list";
import { AddAsrModelModal, renderAsrModelList } from "./utils/asr-model-list";
import { VoiceprintGuideModal } from "./utils/voiceprint-guide";
import type SonicNoteGeekPlugin from "../main";

export const VIEW_TYPE_SONICNOTE_GEEK = "sonicnote-asr-view";

// ===== 页面状态 =====
interface PageState {
  mp3Urls: string[];
  vaultMp3Files: string[];
  selectedMp3s: Set<string>;
  templateType: TemplateType;
  processing: boolean;
  processingStage: number;
  sourceFile: TFile | null;
  customPrompt: string;
  activeCustomIndex: number;
  chatMessages: Array<{ role: "user" | "assistant"; content: string }>;
  chatHeight: number;
  transcriptionDone: boolean;
  reSummarizing: boolean;
  reTranscribing: boolean;
  detectedDownloadPaths: string[];
  hasTranscript: boolean;
  hasSummary: boolean;
  hasAudio: boolean;
}

function createPageState(): PageState {
  return {
    mp3Urls: [],
    vaultMp3Files: [],
    selectedMp3s: new Set(),
    templateType: "business-meeting",
    processing: false,
    processingStage: -1,
    sourceFile: null,
    customPrompt: "",
    activeCustomIndex: 0,
    chatMessages: [],
    chatHeight: 300,
    transcriptionDone: false,
    reSummarizing: false,
    reTranscribing: false,
    detectedDownloadPaths: [],
    hasTranscript: false,
    hasSummary: false,
    hasAudio: false,
  };
}

// ===== 声纹采样弹窗 =====
class VoiceprintSamplingModal extends Modal {
  private plugin: SonicNoteGeekPlugin;
  private afterClose: () => void;
  private samples: Array<{
    speakerId: string;
    displayName: string;
    candidates: Array<{
      audioPath: string;
      relPath: string;
      duration: number;
    }>;
    activeCandidateIndex: number;
    kept: boolean;
  }> = [];
  private state: "loading" | "ready" | "sampling" | "done" = "loading";
  private sourceFile: TFile | null = null;
  private errorMsg = "";
  private currentAudio: HTMLAudioElement | null = null;
  private currentPlayingRelPath = "";

  constructor(app: App, plugin: SonicNoteGeekPlugin, afterClose?: () => void) {
    super(app);
    this.plugin = plugin;
    this.afterClose = afterClose || (() => {});
  }

  close() {
    if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
    super.close();
    this.afterClose();
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-sampling-modal");

    contentEl.createEl("h3", { text: "声纹采样" });

    if (this.state === "loading") {
      await this.initSampling();
    }

    this.render(contentEl);
  }

  private async initSampling() {
    this.state = "loading";
    this.samples = [];
    this.errorMsg = "";

    // 1. 获取当前 MD 文件（优先激活视图，回退遍历所有 markdown 叶子）
    let mdFile: TFile | null =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    if (!mdFile) {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const f = leaf.view instanceof MarkdownView ? leaf.view.file : null;
        if (f) { mdFile = f; break; }
      }
    }
    if (!mdFile) {
      this.errorMsg = "请先打开一个包含逐字稿的 Markdown 文件";
      this.state = "ready";
      return;
    }
    this.sourceFile = mdFile;

    // 2. 读取内容并解析逐字稿段落
    const content = await this.app.vault.read(this.sourceFile);
    const segmentPattern = /\*\*\[(\d{2}:\d{2}(?::\d{2})?)\]\s*(.+?)[：:]\*\*\s*(.+)/g;
    const speakerSegments = new Map<string, Array<{ startSec: number; endSec: number; text: string }>>();
    let match: RegExpExecArray | null;

    while ((match = segmentPattern.exec(content)) !== null) {
      const startSec = this.parseTimestamp(match[1]);
      const speaker = match[2].trim();
      const text = match[3].trim();
      const estimatedDuration = Math.max(1, text.length / 3);
      const endSec = startSec + estimatedDuration;

      if (!speakerSegments.has(speaker)) {
        speakerSegments.set(speaker, []);
      }
      speakerSegments.get(speaker)!.push({ startSec, endSec, text });
    }

    if (speakerSegments.size === 0) {
      this.errorMsg = "未在文档中找到逐字稿段落。请先完成语音转写后再使用此功能。";
      this.state = "ready";
      return;
    }

    // 3. 查找或下载音频文件（优先 audio_url 字段 → 文档内链接 → 嵌入音频 → SonicNoteSync/Audio/{doc} → 缓存）
    let audioPath = await this.findAudioFile(this.sourceFile, content);

    if (!audioPath) {
      this.errorMsg = "未找到关联的音频文件。请在文档 frontmatter 中添加 audio_url 字段，或确保音频文件存在于 vault 中。";
      this.state = "ready";
      return;
    }

    const vaultBase = (this.app.vault.adapter as any).basePath || "";
    const absoluteAudio = audioPath.startsWith("/") ? audioPath : `${vaultBase}/${audioPath}`;

    // 4. 为每个说话人选取最佳采样片段（最长段落，最多10秒）
    const sampleDuration = 10;
    const { tmpdir } = require("os");
    const outDir = `${tmpdir()}/voiceprint_samples_${Date.now()}`;

    // 确保临时输出目录存在，并预先在 vault 中创建 voiceprints 文件夹
    try {
      const { mkdirSync } = require("fs");
      mkdirSync(outDir, { recursive: true });
    } catch {}
    try { await this.app.vault.createFolder("SonicNoteSync"); } catch {}
	    try { await this.app.vault.createFolder("SonicNoteSync/voiceprints"); } catch {}

    for (const [speakerId, segs] of speakerSegments) {
      // 多样性选择：将时间范围均分 count 个区段，每区段选最长段落，保证不重叠不重复
      const pickDiverseSegments = (
        allSegs: Array<{ startSec: number; endSec: number; text: string }>,
        count: number,
      ) => {
        if (allSegs.length <= count) return allSegs;
        const minTime = Math.min(...allSegs.map((s) => s.startSec));
        const maxTime = Math.max(...allSegs.map((s) => s.endSec));
        const zoneWidth = (maxTime - minTime) / count;

        const picked: Array<{ startSec: number; endSec: number; text: string }> = [];
        const used = new Set<number>();

        for (let z = 0; z < count; z++) {
          const zoneStart = minTime + z * zoneWidth;
          const zoneEnd = minTime + (z + 1) * zoneWidth;
          // 找该时区内最长的段落
          let bestIdx = -1;
          let bestDur = -1;
          for (let i = 0; i < allSegs.length; i++) {
            if (used.has(i)) continue;
            const s = allSegs[i];
            // 段落的中点落在该时区内
            const mid = (s.startSec + s.endSec) / 2;
            if (mid >= zoneStart && mid < zoneEnd) {
              const dur = s.endSec - s.startSec;
              if (dur > bestDur) { bestDur = dur; bestIdx = i; }
            }
          }
          // 如果该区段没找到，放宽到整个时间范围找最长未使用的
          if (bestIdx < 0) {
            for (let i = 0; i < allSegs.length; i++) {
              if (used.has(i)) continue;
              const dur = allSegs[i].endSec - allSegs[i].startSec;
              if (dur > bestDur) { bestDur = dur; bestIdx = i; }
            }
          }
          if (bestIdx >= 0) {
            picked.push(allSegs[bestIdx]);
            used.add(bestIdx);
          }
        }
        return picked;
      };

      const topSegments = pickDiverseSegments(segs, 3);

      const safeName = speakerId.replace(/[\/\\:*?"<>|]/g, "_");
      const candidates: Array<{ audioPath: string; relPath: string; duration: number }> = [];

      for (let idx = 0; idx < topSegments.length; idx++) {
        const seg = topSegments[idx];
        const clipDuration = Math.min(sampleDuration, seg.endSec - seg.startSec);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
        const fileName = `sample_${safeName}_${idx}_${timestamp}.wav`;
        const outPath = `${outDir}/${fileName}`;

        try {
          this.plugin.processor.cutAudioSegment(absoluteAudio, seg.startSec, clipDuration, outPath);
          candidates.push({
            audioPath: outPath,
            relPath: `SonicNoteSync/voiceprints/${fileName}`,
            duration: clipDuration,
          });
        } catch (e) {
          console.warn(`声纹采样失败 [${speakerId} #${idx}]:`, e);
        }
      }

      if (candidates.length > 0) {
        this.samples.push({
          speakerId,
          displayName: speakerId,
          candidates,
          activeCandidateIndex: 0,
          kept: true,
        });
      }
    }

    if (this.samples.length === 0) {
      this.errorMsg = "采样失败：未能从音频中截取任何片段。请检查 ffmpeg 是否已安装。";
    } else {
      // 将截取的音频文件注册到 vault 索引（失败不影响采样结果）
      for (const s of this.samples) {
        for (const c of s.candidates) {
          try {
            const existing = this.app.vault.getAbstractFileByPath(c.relPath);
            if (!existing) {
              const { readFileSync } = require("fs");
              const buf = readFileSync(c.audioPath);
              await this.app.vault.createBinary(c.relPath, buf);
            }
          } catch {
            // vault 注册失败不影响采样
          }
        }
      }
    }

    this.state = "done";
  }

  private render(container: HTMLElement) {
    // 提示文本
    if (this.sourceFile) {
      container.createEl("p", {
        text: `源文档: ${this.sourceFile.name}`,
        cls: "sonicnote-sampling-source",
      });
    }

    if (this.state === "loading") {
      container.createEl("div", {
        text: "正在分析文档并截取音频样本...",
        cls: "sonicnote-sampling-loading",
      });
      return;
    }

    if (this.errorMsg) {
      container.createEl("div", {
        text: this.errorMsg,
        cls: "sonicnote-info-text sonicnote-warning-text",
      });
      return;
    }

    if (this.samples.length === 0) {
      container.createEl("div", {
        text: "未检测到可采样的说话人段落。",
        cls: "sonicnote-info-text",
      });
      return;
    }

    // 样本列表
    container.createEl("h4", {
      text: `检测到 ${this.samples.length} 个说话人`,
    });
    const listContainer = container.createDiv({ cls: "sonicnote-sampling-list" });

    const renderList = () => {
      listContainer.empty();
      for (let i = 0; i < this.samples.length; i++) {
        const s = this.samples[i];
        if (!s.kept) continue;

        const candidate = s.candidates[s.activeCandidateIndex];
        const totalCandidates = s.candidates.length;

        const row = listContainer.createDiv({ cls: "sonicnote-sampling-row" });

        // 说话人名称（双击编辑）
        const nameEl = row.createEl("span", {
          text: s.displayName,
          cls: "sonicnote-sampling-name",
        });
        nameEl.addEventListener("dblclick", () => {
          const input = row.createEl("input", {
            type: "text",
            value: s.displayName,
            cls: "sonicnote-list-input",
          });
          input.style.flex = "1";
          nameEl.replaceWith(input);
          input.focus();
          const save = () => {
            s.displayName = input.value.trim() || s.speakerId;
            renderList();
          };
          input.addEventListener("blur", save);
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); save(); }
          });
        });

        // 候选编号 / 时长
        row.createEl("span", {
          text: totalCandidates > 1
            ? `#${s.activeCandidateIndex + 1}/${totalCandidates} ${candidate.duration.toFixed(1)}s`
            : `${candidate.duration.toFixed(1)}s`,
          cls: "sonicnote-sampling-duration",
        });

        // 播放/停止按钮
        const playBtn = row.createEl("button", {
          cls: "sonicnote-icon-btn",
          attr: { title: "播放" },
        });
        const isPlayingThis = this.currentPlayingRelPath === candidate.relPath && this.currentAudio && !this.currentAudio.paused;
        setIcon(playBtn, isPlayingThis ? "square" : "play");
        playBtn.setAttr("aria-label", isPlayingThis ? "停止" : "播放");
        playBtn.addEventListener("click", () => {
          // 同一个音频正在播放 → 停止
          if (this.currentPlayingRelPath === candidate.relPath && this.currentAudio && !this.currentAudio.paused) {
            this.currentAudio.pause();
            this.currentAudio = null;
            this.currentPlayingRelPath = "";
            renderList();
            return;
          }
          // 停止之前的音频
          if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
          // 刷新所有播放按钮图标
          this.currentPlayingRelPath = candidate.relPath;
          renderList();
          (async () => {
            try {
              let url: string;
              const audioFile = this.app.vault.getAbstractFileByPath(candidate.relPath);
              if (audioFile) {
                url = this.app.vault.getResourcePath(audioFile as import("obsidian").TFile);
              } else {
                // 回退：通过 vault adapter 读取二进制
                const buf = await this.app.vault.adapter.readBinary(candidate.relPath);
                const blob = new Blob([buf], { type: "audio/wav" });
                url = URL.createObjectURL(blob);
              }
              const audio = new Audio(url);
              this.currentAudio = audio;
              await audio.play();
              renderList();
              audio.addEventListener("ended", () => {
                this.currentAudio = null;
                this.currentPlayingRelPath = "";
                renderList();
              });
            } catch {
              this.currentAudio = null;
              this.currentPlayingRelPath = "";
              renderList();
              new Notice("无法播放音频文件");
            }
          })();
        });

        // 切换候选按钮（仅当有多个候选时显示）
        if (totalCandidates > 1) {
          const swapBtn = row.createEl("button", {
            cls: "sonicnote-icon-btn",
            attr: { title: "切换" },
          });
          setIcon(swapBtn, "refresh-cw");
          swapBtn.setAttr("aria-label", "切换");
          swapBtn.addEventListener("click", () => {
            if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
            s.activeCandidateIndex = (s.activeCandidateIndex + 1) % totalCandidates;
            renderList();
          });
        }

        // 单独添加到声纹库按钮
        const addOneBtn = row.createEl("button", {
          cls: "sonicnote-icon-btn sonicnote-icon-btn-add",
          attr: { title: "添加声纹库" },
        });
        setIcon(addOneBtn, "plus");
        addOneBtn.setAttr("aria-label", "添加声纹库");
        addOneBtn.addEventListener("click", async () => {
          const candidate = s.candidates[s.activeCandidateIndex];
          const vp = this.plugin.settings.voiceprintLibrary;
          vp.push({
            id: `vp_${Date.now()}`,
            name: s.displayName,
            audioSamplePath: candidate.relPath,
            description: `从 "${this.sourceFile?.basename || "unknown"}" 采样`,
          });
          await this.plugin.saveSettings();
          new Notice(`已添加 "${s.displayName}" 到声纹库`);
          // 移除已添加的样本
          s.kept = false;
          for (const c of s.candidates) {
            try {
              const { unlinkSync } = require("fs");
              unlinkSync(c.audioPath);
            } catch {}
          }
          renderList();
        });

        // 删除按钮
        const delBtn = row.createEl("button", {
          cls: "sonicnote-icon-btn sonicnote-icon-btn-danger",
          attr: { title: "删除" },
        });
        setIcon(delBtn, "trash-2");
        delBtn.setAttr("aria-label", "删除");
        delBtn.addEventListener("click", () => {
          s.kept = false;
          // 删除所有候选临时文件
          for (const c of s.candidates) {
            try {
              const { unlinkSync } = require("fs");
              unlinkSync(c.audioPath);
            } catch {}
          }
          renderList();
        });
      }

      const keptCount = this.samples.filter((s) => s.kept).length;
      if (keptCount === 0) {
        listContainer.createEl("div", {
          text: "所有样本已删除。可关闭窗口或点击下方按钮重新采样。",
          cls: "sonicnote-info-text",
        });
      }
    };
    renderList();

    // 底部按钮
    const footer = container.createDiv({ cls: "sonicnote-sampling-footer" });

    const resampleBtn = footer.createEl("button", {
      text: "重新采样",
      cls: "sonicnote-resample-btn",
    });
    resampleBtn.addEventListener("click", async () => {
      for (const s of this.samples) {
        for (const c of s.candidates) {
          try {
            const { unlinkSync } = require("fs");
            unlinkSync(c.audioPath);
          } catch {}
        }
      }
      this.samples = [];
      this.errorMsg = "";
      this.state = "loading";
      await this.initSampling();
      const el = this.contentEl;
      el.empty();
      el.addClass("sonicnote-sampling-modal");
      el.createEl("h3", { text: "声纹采样" });
      this.render(el);
    });
  }

  /** 解析 HH:MM:SS 或 MM:SS 为秒数 */
  private parseTimestamp(ts: string): number {
    const parts = ts.split(":");
    if (parts.length === 3) {
      return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }

  /** 查找与当前 MD 关联的音频文件（优先 audio_url 字段） */
  private async findAudioFile(sourceFile: TFile, content?: string): Promise<string | null> {
    const docContent = content || await this.app.vault.read(sourceFile);

    // 0. audio_url 字段（frontmatter / 文档头部）
    const audioUrlMatch = docContent.match(/audio_url[：:]\s*["']?([^"'\s]+)["']?/m);
    if (audioUrlMatch) {
      let url = audioUrlMatch[1].trim();
      // 去除尾部可能残留的引号
      url = url.replace(/["']$/, "");
      if (url.startsWith("http://") || url.startsWith("https://")) {
        try {
          const localPath = await this.downloadAudioFile(sourceFile, url);
          return localPath;
        } catch (e) {
          console.warn("audio_url 下载失败:", e);
        }
      } else {
        const f = this.app.vault.getAbstractFileByPath(url);
        if (f) return url;
      }
    }

    // 1. 文档中的 MP3 链接
    const mp3Links = extractMp3Links(docContent);
    if (mp3Links.length > 0) {
      for (const link of mp3Links) {
        if (link.startsWith("http")) continue;
        const f = this.app.vault.getAbstractFileByPath(link);
        if (f) return link;
      }
    }

    // 2. 文档中嵌入的音频 ![[audio.mp3]]
    const embedMatch = docContent.match(/!\[\[([^\]]+\.(mp3|wav|m4a|flac))\]\]/i);
    if (embedMatch) {
      const f = this.app.vault.getAbstractFileByPath(embedMatch[1]);
      if (f) return embedMatch[1];
    }

    // 3. SonicNoteSync/Audio 目录
    const audioDir = `SonicNoteSync/Audio/${sourceFile.basename}`;
    try {
      const dir = this.app.vault.getAbstractFileByPath(audioDir);
      if (dir) {
        const listing = await (this.app.vault.adapter as any).list?.(audioDir);
        for (const fPath of (listing?.files || [])) {
          if (/\.(mp3|wav|m4a|flac)$/i.test(fPath)) {
            return fPath;
          }
        }
      }
    } catch {}

    // 4. processor 缓存路径
    const dlPaths = this.plugin.processor.lastDownloadedPaths || [];
    for (const p of dlPaths) {
      if (!p.startsWith("http")) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) return p;
      }
    }

    return null;
  }

  /** 下载远程音频到 vault */
  private async downloadAudioFile(sourceFile: TFile, url: string): Promise<string> {
    const fileName = url.split("/").pop()?.split("?")[0] || `audio_${Date.now()}.mp3`;
    const dirPath = `SonicNoteSync/Audio/${sourceFile.basename}`;
    const savePath = `${dirPath}/${fileName}`;

    // 已存在则直接返回
    const existing = this.app.vault.getAbstractFileByPath(savePath);
    if (existing) return savePath;

    try {
      await this.app.vault.createFolder(dirPath);
    } catch {
      // 目录已存在
    }

    const resp = await requestUrl({ url, method: "GET", throw: false });
    if (resp.status !== 200) {
      throw new Error(`下载失败 HTTP ${resp.status}`);
    }

    await this.app.vault.createBinary(savePath, resp.arrayBuffer);
    return savePath;
  }
}

// ===== 配置弹窗 =====
type ConfigModalType = "asr" | "llm" | "hotwords" | "voiceprint";

class ConfigModal extends Modal {
  private plugin: SonicNoteGeekPlugin;
  private modalType: ConfigModalType;
  private afterClose: () => void;
  private currentAudio: HTMLAudioElement | null = null;
  private currentPlayingRelPath = "";

  constructor(app: App, plugin: SonicNoteGeekPlugin, type: ConfigModalType, afterClose?: () => void) {
    super(app);
    this.plugin = plugin;
    this.modalType = type;
    this.afterClose = afterClose || (() => {});
  }

  close() {
    if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
    super.close();
    this.afterClose();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-config-modal");

    const titles: Record<ConfigModalType, string> = {
      asr: "ASR 配置",
      llm: "LLM 配置",
      hotwords: "热词管理",
      voiceprint: "声纹识别",
    };
    contentEl.createEl("h3", { text: titles[this.modalType] });

    switch (this.modalType) {
      case "asr": this.renderASR(contentEl); break;
      case "llm": this.renderLLM(contentEl); break;
      case "hotwords": this.renderHotWords(contentEl); break;
      case "voiceprint": this.renderVoiceprint(contentEl); break;
    }
  }

  private renderASR(container: HTMLElement) {
    renderAsrModelList(
      container,
      this.plugin.settings.asrModels,
      this.plugin.settings.activeAsrModelId,
      async (id) => {
        this.plugin.settings.activeAsrModelId = id;
        await this.plugin.saveSettings();
        this.onOpen();
      },
      (model) => {
        new AddAsrModelModal(
          this.app, this.plugin,
          () => this.onOpen(),
          model,
        ).open();
      },
      async (id) => {
        const models = this.plugin.settings.asrModels;
        const idx = models.findIndex((m) => m.id === id);
        if (idx >= 0) {
          models.splice(idx, 1);
          if (this.plugin.settings.activeAsrModelId === id) {
            this.plugin.settings.activeAsrModelId = models[0]?.id || "";
          }
          await this.plugin.saveSettings();
          this.onOpen();
        }
      },
      () => {
        new AddAsrModelModal(
          this.app, this.plugin,
          () => this.onOpen(),
        ).open();
      },
      false,
    );

    this.renderSaveBtn(container);
  }

  private renderLLM(container: HTMLElement) {
    renderModelList(
      container,
      this.plugin.settings.llmModels,
      this.plugin.settings.activeModelId,
      async (id) => {
        this.plugin.settings.activeModelId = id;
        await this.plugin.saveSettings();
        this.onOpen();
      },
      (model) => {
        new AddModelModal(
          this.app, this.plugin,
          () => this.onOpen(),
          model,
        ).open();
      },
      async (id) => {
        const models = this.plugin.settings.llmModels;
        const idx = models.findIndex((m) => m.id === id);
        if (idx >= 0) {
          models.splice(idx, 1);
          if (this.plugin.settings.activeModelId === id) {
            this.plugin.settings.activeModelId = models[0]?.id || "";
          }
          await this.plugin.saveSettings();
          this.onOpen();
        }
      },
      () => {
        new AddModelModal(
          this.app, this.plugin,
          () => this.onOpen(),
        ).open();
      },
      false,
    );

    this.renderSaveBtn(container);
  }

  private renderHotWords(container: HTMLElement) {
    const hw = this.plugin.settings.hotWords;

    // ---- 我的词库 ----
    container.createEl("h4", { text: "我的词库" });
    container.createEl("p", {
      text: "当前仅 火山引擎 / 讯飞 / 腾讯云 支持热词。本地 OpenAI 兼容模型及其他云服务商不支持。",
      cls: "setting-item-description",
    });

    const keywordsContainer = container.createDiv({ cls: "sonicnote-keywords-container" });

    const renderKeywords = () => {
      keywordsContainer.empty();
      for (let i = 0; i < hw.length; i++) {
        const tag = keywordsContainer.createDiv({ cls: "sonicnote-keyword-tag" });
        tag.createSpan({ text: hw[i].word });
        const xBtn = tag.createEl("button", { cls: "sonicnote-keyword-x" });
        xBtn.setText("×");
        xBtn.addEventListener("click", () => { hw.splice(i, 1); renderKeywords(); });
      }
    };
    renderKeywords();

    const inputRow = container.createDiv({ cls: "sonicnote-input-row" });
    const wordInput = inputRow.createEl("input", {
      type: "text",
      placeholder: "请输入词汇",
      cls: "sonicnote-url-input",
    });
    const addBtn = inputRow.createEl("button", {
      text: "添加",
      cls: "sonicnote-btn-primary",
    });
    addBtn.addEventListener("click", () => {
      const v = wordInput.value.trim();
      if (v && !hw.some((h) => h.word === v)) {
        hw.push({ word: v, weight: 5 });
        renderKeywords();
        wordInput.value = "";
      }
    });
    wordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addBtn.click();
      }
    });

    // ---- 行业偏好 ----
    container.createEl("h4", { text: "行业偏好" });

    const industries: Record<string, string> = {
      "": "不指定",
      "信息技术与工程": "信息技术与工程",
      "能源与环境": "能源与环境",
      "金融与法律": "金融与法律",
      "教育与研究": "教育与研究",
      "公共服务": "公共服务",
      "医疗与健康": "医疗与健康",
      "创新与传媒": "创新与传媒",
      "建筑与房地产": "建筑与房地产",
      "人力资源与行政": "人力资源与行政",
      "零售与消费": "零售与消费",
      "旅游与物流": "旅游与物流",
    };

    const industryWrap = container.createDiv({ cls: "sonicnote-field-wrap" });
    const select = industryWrap.createEl("select", { cls: "sonicnote-field-input" });
    for (const [k, v] of Object.entries(industries)) {
      const opt = select.createEl("option", { text: v, attr: { value: k } });
      if (k === this.plugin.settings.industry) opt.selected = true;
    }
    select.addEventListener("change", () => {
      this.plugin.settings.industry = select.value;
    });

    this.renderSaveBtn(container);
  }

  private renderVoiceprint(container: HTMLElement) {
    const sd = this.plugin.settings.speakerDiarization;
    const vp = this.plugin.settings.voiceprintLibrary;

    // ---- 声纹服务配置 ----
    const headerRow = container.createDiv({ cls: "sonicnote-voiceprint-header" });
    headerRow.createEl("h4", { text: "声纹识别服务" });
    const guideBtn = headerRow.createEl("button", { text: "查看接入文档", cls: "sonicnote-btn-secondary" });
    guideBtn.addEventListener("click", () => {
      new VoiceprintGuideModal(this.app as App).open();
    });

    // 服务地址
    container.createEl("label", { text: "服务地址", cls: "setting-item-name" });
    const urlInput = container.createEl("input", {
      type: "text",
      placeholder: "http://localhost:8100",
      cls: "sonicnote-wide-input",
    });
    urlInput.value = sd.customEndpoint || "";
    urlInput.addEventListener("change", async () => {
      sd.customEndpoint = urlInput.value.trim();
      await this.plugin.saveSettings();
    });

    // API Key
    container.createEl("label", { text: "API Key（可选）", cls: "setting-item-name" });
    const keyInput = container.createEl("input", {
      type: "password",
      placeholder: "sk-...",
      cls: "sonicnote-wide-input",
    });
    keyInput.value = sd.apiKey || "";
    keyInput.addEventListener("change", async () => {
      sd.apiKey = keyInput.value.trim();
      await this.plugin.saveSettings();
    });

    // 检测服务 + 状态
    const checkRow = container.createDiv({ cls: "sonicnote-voiceprint-check-row" });
    const checkBtn = checkRow.createEl("button", { text: "检测服务", cls: "sonicnote-btn-secondary" });
    const statusEl = checkRow.createSpan({ cls: "sonicnote-voiceprint-status", text: "" });

    const updateServiceStatus = (ok: boolean) => {
      statusEl.empty();
      if (ok) {
        statusEl.createSpan({ text: "✓ 已连接", cls: "sonicnote-status-ok" });
      } else {
        statusEl.createSpan({ text: "✗ 未连接", cls: "sonicnote-status-fail" });
      }
    };

    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkBtn.setText("检测中...");
      statusEl.empty();
      statusEl.createSpan({ text: "⏳", cls: "sonicnote-status-checking" });
      const ok = await this.plugin.processor.checkVoiceprintService(sd.customEndpoint || "");
      updateServiceStatus(ok);
      checkBtn.disabled = false;
      checkBtn.setText("检测服务");
    });

    // 初次检测
    this.plugin.processor.checkVoiceprintService(sd.customEndpoint || "").then(updateServiceStatus);

    const autoVpSetting = new Setting(container)
      .setName("自动声纹识别")
      .setDesc("开启后，转写时自动调用声纹识别服务替换说话人姓名，LLM 总结将包含真实人名")
      .addToggle((toggle) => {
        toggle.setValue(sd.autoVoiceprint);
        toggle.onChange(async (v) => {
          sd.autoVoiceprint = v;
          await this.plugin.saveSettings();
        });
      });

    // ---- 声纹库 ----
    container.createEl("h4", { text: "声纹库" });
    container.createEl("p", {
      text: "添加说话人的声纹样本。需要提供姓名和一段该说话人的清晰单人音频（3-10秒即可）。",
      cls: "setting-item-description",
    });

    const vpContainer = container.createDiv({ cls: "sonicnote-list-container" });

    const renderList = () => {
      vpContainer.empty();
      for (let i = 0; i < vp.length; i++) {
        const item = vp[i];
        const row = vpContainer.createDiv({ cls: "sonicnote-list-row" });

        // 人名 (双击编辑)
        const nameEl = row.createEl("span", {
          text: item.name || "(未命名)",
          cls: "sonicnote-voiceprint-name",
        });
        nameEl.addEventListener("dblclick", () => {
          const input = row.createEl("input", {
            type: "text",
            value: item.name,
            cls: "sonicnote-list-input",
          });
          input.style.flex = "1";
          nameEl.replaceWith(input);
          input.focus();
          const save = () => { item.name = input.value.trim(); renderList(); };
          input.addEventListener("blur", save);
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
        });

        // 样本路径 (点击选择音频文件)
        const pathEl = row.createEl("span", {
          text: item.audioSamplePath || "(点击选择音频)",
          cls: "sonicnote-voiceprint-path",
        });
        pathEl.style.cursor = "pointer";
        pathEl.addEventListener("click", async () => {
          const fileInput = document.body.createEl("input", {
            type: "file",
            attr: { accept: ".wav,.mp3,.m4a,.flac" },
          });
          fileInput.style.display = "none";
          fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            fileInput.remove();
            if (!file) return;

            // 校验格式
            const ext = file.name.split(".").pop()?.toLowerCase();
            const allowed = ["wav", "mp3", "m4a", "flac"];
            if (!ext || !allowed.includes(ext)) {
              new Notice("不支持的音频格式: " + (ext || "未知") + "。支持: wav, mp3, m4a, flac");
              return;
            }

            // 校验时长 (5-20秒)
            try {
              const duration = await this.getAudioDuration(file);
              if (duration < 5) {
                new Notice(`音频太短 (${duration.toFixed(1)}秒)，需要 5-20 秒的单人语音片段`);
                return;
              }
              if (duration > 20) {
                new Notice(`音频太长 (${duration.toFixed(1)}秒)，需要 5-20 秒的单人语音片段`);
                return;
              }
            } catch {
              new Notice("无法读取音频时长，请检查文件是否损坏");
              return;
            }

            // 复制到 SonicNoteSync/voiceprints/
            try {
              const safeName = (item.name || "unknown").replace(/[\/\\:*?"<>|]/g, "_");
              const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
              const destName = `vp_${safeName}_${ts}.${ext}`;
              const destPath = `SonicNoteSync/voiceprints/${destName}`;

              // 确保目录存在
              try { await this.app.vault.createFolder("SonicNoteSync"); } catch {}
              try { await this.app.vault.createFolder("SonicNoteSync/voiceprints"); } catch {}

              const buf = await file.arrayBuffer();
              await this.app.vault.createBinary(destPath, buf);
              item.audioSamplePath = destPath;
              renderList();
              new Notice(`声纹样本已导入: ${destName}`);
            } catch (e) {
              new Notice("音频文件保存失败: " + (e instanceof Error ? e.message : String(e)));
            }
          });
          fileInput.click();
        });

        // 播放/停止按钮
        const isPlayingThis = this.currentPlayingRelPath === item.audioSamplePath && this.currentAudio && !this.currentAudio.paused;
        const playBtn = row.createEl("button", { cls: "sonicnote-icon-btn", attr: { title: isPlayingThis ? "停止" : "播放" } });
        setIcon(playBtn, isPlayingThis ? "square" : "play");
        playBtn.addEventListener("click", () => {
          // 同一个音频正在播放 → 停止
          if (this.currentPlayingRelPath === item.audioSamplePath && this.currentAudio && !this.currentAudio.paused) {
            this.currentAudio.pause();
            this.currentAudio = null;
            this.currentPlayingRelPath = "";
            setIcon(playBtn, "play");
            playBtn.setAttr("title", "播放");
            return;
          }
          // 停止之前的音频
          if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
          const samplePath = item.audioSamplePath;
          if (!samplePath) {
            new Notice("未设置音频样本路径");
            return;
          }
          (async () => {
            try {
              let url: string;
              const audioFile = this.app.vault.getAbstractFileByPath(samplePath);
              if (audioFile) {
                url = this.app.vault.getResourcePath(audioFile as import("obsidian").TFile);
              } else {
                // 回退：通过 vault adapter 读取二进制
                const buf = await this.app.vault.adapter.readBinary(samplePath);
                const blob = new Blob([buf], { type: "audio/wav" });
                url = URL.createObjectURL(blob);
              }
              const audio = new Audio(url);
              this.currentAudio = audio;
              this.currentPlayingRelPath = samplePath;
              audio.play();
              audio.addEventListener("ended", () => {
                this.currentAudio = null;
                this.currentPlayingRelPath = "";
                renderList();
              });
              renderList();
            } catch (e) {
              console.warn("声纹库播放失败:", e);
              new Notice("找不到音频文件");
            }
          })();
        });

        // 删除按钮
        const delBtn = row.createEl("button", { cls: "sonicnote-icon-btn sonicnote-icon-btn-danger", attr: { title: "删除" } });
        setIcon(delBtn, "trash-2");
        delBtn.addEventListener("click", () => { vp.splice(i, 1); renderList(); });
      }
    };
    renderList();

    const addBtn = container.createEl("button", { text: "+ 添加声纹", cls: "sonicnote-add-btn" });
    addBtn.addEventListener("click", () => {
      vp.push({ id: `vp_${Date.now()}`, name: "", audioSamplePath: "", description: "" });
      renderList();
    });

    this.renderSaveBtn(container);
  }

  /** 一键比对: 提取当前 MD 的逐字稿 → 声纹识别 → 更新说话人名 */
  private async runVoiceprintMatch() {
    const sd = this.plugin.settings.speakerDiarization;
    const vp = this.plugin.settings.voiceprintLibrary;

    if (!sd.customEndpoint) {
      new Notice("请先配置声纹识别服务地址");
      return;
    }
    if (vp.length === 0 || !vp.some((v) => v.audioSamplePath)) {
      new Notice("请先在声纹库中添加至少一个带音频样本的说话人");
      return;
    }

    // 优先激活视图，回退遍历所有 markdown 叶子
    let sourceFile: TFile | null =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    if (!sourceFile) {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const f = leaf.view instanceof MarkdownView ? leaf.view.file : null;
        if (f) { sourceFile = f; break; }
      }
    }
    if (!sourceFile) {
      new Notice("请先打开一个包含逐字稿的 Markdown 文件");
      return;
    }

    const content = await this.app.vault.read(sourceFile);

    // 解析逐字稿区域: **[00:01] 说话人1：** text
    const segmentPattern = /\*\*\[(\d{2}:\d{2}(?::\d{2})?)\]\s*(.+?)[：:]\*\*\s*(.+)/g;
    const speakerSegments = new Map<string, { starts: number[]; ends: number[] }>();
    let match: RegExpExecArray | null;
    let lastEndSec = 0;

    while ((match = segmentPattern.exec(content)) !== null) {
      const startSec = this.parseTimestamp(match[1]);
      const speaker = match[2].trim();
      const text = match[3].trim();

      // 估算结束时间：按字数估算 (中文约 3 字/秒)
      const estimatedDuration = Math.max(1, text.length / 3);
      const endSec = startSec + estimatedDuration;
      lastEndSec = Math.max(lastEndSec, endSec);

      if (!speakerSegments.has(speaker)) {
        speakerSegments.set(speaker, { starts: [], ends: [] });
      }
      const sg = speakerSegments.get(speaker)!;
      sg.starts.push(startSec);
      sg.ends.push(endSec);
    }

    if (speakerSegments.size === 0) {
      new Notice("未在文档中找到逐字稿段落。请先完成语音转写后再使用此功能。");
      return;
    }

    // 查找音频文件
    const audioPath = await this.findAudioFile(sourceFile);
    if (!audioPath) {
      new Notice("未找到关联的音频文件。请确保音频文件存在于 vault 中。");
      return;
    }

    // 构建请求并调用声纹服务
    const vaultBase = (this.app.vault.adapter as any).basePath || "";
    const absoluteAudio = audioPath.startsWith("/") ? audioPath : `${vaultBase}/${audioPath}`;

    const speakerArray = Array.from(speakerSegments.entries()).map(([id, segs]) => ({
      speaker_id: id,
      starts: segs.starts,
      ends: segs.ends,
    }));

    try {
      const labels = await this.plugin.processor.matchVoiceprints(
        absoluteAudio, speakerArray, vp, sd.customEndpoint, sd.apiKey,
      );

      const changed: string[] = [];

      // 替换文档中的说话人名称
      let updatedContent = content;
      for (const [speaker, name] of Object.entries(labels)) {
        if (name && name !== "未知说话人" && speaker !== name) {
          // 替换逐字稿中的说话人标签
          const escapedSpeaker = speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = new RegExp(
            `(\\*\\*\\[\\d{2}:\\d{2}(?::\\d{2})?\\]\\s*)${escapedSpeaker}([：:]\\*\\*)`,
            "g",
          );
          const before = updatedContent;
          updatedContent = updatedContent.replace(pattern, `$1${name}$2`);
          if (updatedContent !== before) changed.push(`${speaker} → ${name}`);
        }
      }

      if (changed.length > 0) {
        await this.app.vault.modify(sourceFile, updatedContent);
        new Notice(`声纹比对完成！已更新: ${changed.join(", ")}`);
      } else {
        new Notice("声纹比对完成，但未找到可更新的匹配项。");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("声纹比对失败:", e);
      new Notice(`声纹比对失败: ${msg}`);
    }
  }

  /** 查找与当前 MD 关联的音频文件 */
  private async findAudioFile(sourceFile: TFile): Promise<string | null> {
    const content = await this.app.vault.read(sourceFile);

    // 0. audio_url 字段（frontmatter / 文档头部）
    const audioUrlMatch = content.match(/audio_url[：:]\s*["']?([^"'\s]+)["']?/m);
    if (audioUrlMatch) {
      let url = audioUrlMatch[1].trim();
      url = url.replace(/["']$/, "");
      if (url.startsWith("http://") || url.startsWith("https://")) {
        // 远程 URL：下载到 SonicNoteSync/Audio/ 目录
        try {
          const fileName = url.split("/").pop()?.split("?")[0] || `audio_${Date.now()}.mp3`;
          const dirPath = `SonicNoteSync/Audio/${sourceFile.basename}`;
          const savePath = `${dirPath}/${fileName}`;
          const existing = this.app.vault.getAbstractFileByPath(savePath);
          if (existing) return savePath;
          try { await this.app.vault.createFolder(dirPath); } catch {}
          const resp = await requestUrl({ url, method: "GET", throw: false });
          if (resp.status === 200) {
            await this.app.vault.createBinary(savePath, resp.arrayBuffer);
            return savePath;
          }
        } catch (e) {
          console.warn("audio_url 下载失败:", e);
        }
      } else {
        const f = this.app.vault.getAbstractFileByPath(url);
        if (f) return url;
      }
    }

    // 1. 文档中的 MP3 链接
    const mp3Links = extractMp3Links(content);
    if (mp3Links.length > 0) {
      for (const link of mp3Links) {
        if (link.startsWith("http")) continue;
        const f = this.app.vault.getAbstractFileByPath(link);
        if (f) return link;
      }
    }

    // 2. 文档中嵌入的音频 ![[audio.mp3]]
    const embedMatch = content.match(/!\[\[([^\]]+\.(mp3|wav|m4a|flac))\]\]/i);
    if (embedMatch) {
      const f = this.app.vault.getAbstractFileByPath(embedMatch[1]);
      if (f) return embedMatch[1];
    }

    // 3. SonicNoteSync/Audio 目录
    const audioDir = `SonicNoteSync/Audio/${sourceFile.basename}`;
    try {
      const dir = this.app.vault.getAbstractFileByPath(audioDir);
      if (dir) {
        const listing = await (this.app.vault.adapter as any).list?.(audioDir);
        for (const fPath of (listing?.files || [])) {
          if (/\.(mp3|wav|m4a|flac)$/i.test(fPath)) {
            return fPath;
          }
        }
      }
    } catch {}

    // 4. processor 缓存的下载路径
    const dlPaths = this.plugin.processor.lastDownloadedPaths || [];
    for (const p of dlPaths) {
      if (!p.startsWith("http")) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) return p;
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

  private renderSaveBtn(container: HTMLElement) {
    const row = container.createDiv({ cls: "sonicnote-button-row" });
    const btn = row.createEl("button", { text: "保存并关闭", cls: "sonicnote-btn-primary" });
    btn.addEventListener("click", async () => {
      await this.plugin.saveSettings();
      this.close();
    });
  }

  /** 读取音频文件时长 (秒) */
  private getAudioDuration(file: File): Promise<number> {
    return new Promise((resolve, reject) => {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const buffer = await audioCtx.decodeAudioData(reader.result as ArrayBuffer);
          audioCtx.close();
          resolve(buffer.duration);
        } catch {
          audioCtx.close();
          reject(new Error("decode failed"));
        }
      };
      reader.onerror = () => { audioCtx.close(); reject(new Error("read failed")); };
      reader.readAsArrayBuffer(file);
    });
  }
}

// ===== 自定义模版弹窗 =====
class CustomTemplateModal extends Modal {
  private plugin: SonicNoteGeekPlugin;
  private templateName: string;
  private templatePrompt: string;
  private onSave: (() => void) | null;
  private editingIndex: number | undefined;

  constructor(app: App, plugin: SonicNoteGeekPlugin, onSave?: () => void, editingIndex?: number) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave || null;
    this.editingIndex = editingIndex;
    if (editingIndex !== undefined) {
      const existing = plugin.settings.customTemplates?.[editingIndex];
      this.templateName = existing?.name || "";
      this.templatePrompt = existing?.systemPrompt || "";
    } else {
      this.templateName = "";
      this.templatePrompt = "";
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-config-modal");
    contentEl.createEl("h3", { text: "我的自定义模版" });

    const wrap = contentEl.createDiv({ cls: "sonicnote-field-wrap" });

    // 模版名称
    wrap.createEl("label", { text: "模版名称", cls: "sonicnote-field-label" });
    const nameInput = wrap.createEl("input", {
      type: "text",
      placeholder: "给你的模版起个名字",
      cls: "sonicnote-field-input",
    });
    nameInput.value = this.templateName;
    nameInput.addEventListener("change", () => { this.templateName = nameInput.value; });

    // 提示词
    wrap.createEl("label", { text: "提示词", cls: "sonicnote-field-label" });
    const promptArea = wrap.createEl("textarea", {
      attr: {
        rows: "10",
        placeholder: "自定义 System Prompt，指导 LLM 如何总结转写内容…",
      },
      cls: "sonicnote-field-input sonicnote-prompt-textarea",
    });
    promptArea.value = this.templatePrompt;
    promptArea.addEventListener("change", () => { this.templatePrompt = promptArea.value; });

    // 提交按钮
    const btnRow = contentEl.createDiv({ cls: "sonicnote-button-row" });
    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const submitBtn = btnRow.createEl("button", { text: "提交", cls: "sonicnote-btn-primary" });
    submitBtn.addEventListener("click", async () => {
      const name = this.templateName.trim();
      const prompt = this.templatePrompt.trim();
      if (!name || !prompt) {
        new Notice("请填写模版名称和提示词");
        return;
      }
      // 编辑模式: 替换已有; 新建模式: 追加
      const entry: SummaryTemplate = {
        type: "custom",
        name,
        description: "用户自定义模版",
        systemPrompt: prompt,
        outputFormat: "",
      };
      if (this.editingIndex !== undefined) {
        this.plugin.settings.customTemplates[this.editingIndex] = entry;
      } else {
        if (!this.plugin.settings.customTemplates) this.plugin.settings.customTemplates = [];
        this.plugin.settings.customTemplates.push(entry);
      }
      await this.plugin.saveSettings();
      new Notice("自定义模版已保存");
      this.onSave?.();
      this.close();
    });
  }
}

// ===== 更多模版弹窗 =====
class TemplatePickerModal extends Modal {
  private plugin: SonicNoteGeekPlugin;
  private selectedType: TemplateType;
  private selectedCustomIndex: number;
  private activeCategory: string;
  private onConfirm: (type: TemplateType, customIndex?: number) => void;

  constructor(
    app: App,
    plugin: SonicNoteGeekPlugin,
    currentType: TemplateType,
    currentCustomIndex: number,
    onConfirm: (type: TemplateType, customIndex?: number) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.selectedType = currentType;
    this.selectedCustomIndex = currentCustomIndex;

    // 确定初始分类
    if (currentType === "custom") {
      this.activeCategory = "custom";
    } else {
      const cat = TEMPLATE_CATEGORIES.find((c) => c.types.includes(currentType));
      this.activeCategory = cat?.key || "general";
    }
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-tpl-modal");
    contentEl.createEl("h3", { text: "选择模版" });

    // 分类按钮行
    this.renderCategoryBar(contentEl);

    // 模版卡片区域
    const cardsContainer = contentEl.createDiv({ cls: "sonicnote-tpl-cards" });
    this.renderCategoryCards(cardsContainer);

    // 底部按钮
    const footer = contentEl.createDiv({ cls: "sonicnote-tpl-footer" });
    const cancelBtn = footer.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const confirmBtn = footer.createEl("button", { text: "确认", cls: "sonicnote-btn-primary" });
    confirmBtn.addEventListener("click", () => {
      this.onConfirm(this.selectedType, this.selectedType === "custom" ? this.selectedCustomIndex : undefined);
      this.close();
    });
  }

  private renderCategoryBar(container: HTMLElement) {
    const bar = container.createDiv({ cls: "sonicnote-tpl-categories" });

    // 自定义排第一
    const allCategories = [
      { key: "custom", label: "自定义" },
      ...TEMPLATE_CATEGORIES.map((c) => ({ key: c.key, label: c.label })),
    ];

    for (const cat of allCategories) {
      const btn = bar.createEl("button", {
        text: cat.label,
        cls: `sonicnote-tpl-cat-btn ${this.activeCategory === cat.key ? "sonicnote-tpl-cat-active" : ""}`,
      });
      btn.addEventListener("click", () => {
        this.activeCategory = cat.key;
        this.onOpen();
      });
    }
  }

  private renderCategoryCards(container: HTMLElement) {
    if (this.activeCategory === "custom") {
      this.renderCustomCards(container);
      return;
    }

    const cat = TEMPLATE_CATEGORIES.find((c) => c.key === this.activeCategory);
    if (!cat) return;

    const grid = container.createDiv({ cls: "sonicnote-tpl-grid" });

    for (const tType of cat.types) {
      const tpl = (BUILTIN_TEMPLATES as Record<string, SummaryTemplate>)[tType];
      if (!tpl) continue;
      const isActive = this.selectedType === tType;
      const card = grid.createDiv({
        cls: `sonicnote-template-card ${isActive ? "sonicnote-template-active" : ""}`,
      });
      card.createEl("div", { text: tpl.name, cls: "sonicnote-template-name" });
      card.createEl("div", { text: tpl.description, cls: "sonicnote-template-desc" });
      card.addEventListener("click", () => {
        this.selectedType = tType;
        this.onOpen();
      });
    }
  }

  private renderCustomCards(container: HTMLElement) {
    const customTemplates = this.plugin.settings.customTemplates || [];
    const grid = container.createDiv({ cls: "sonicnote-tpl-grid" });

    // "创建自定义模版" 卡片
    const createCard = grid.createDiv({ cls: "sonicnote-template-card sonicnote-template-custom" });
    createCard.createEl("div", { text: "+ 创建自定义模版", cls: "sonicnote-template-name" });
    createCard.createEl("div", { text: "设置你自己的 System Prompt", cls: "sonicnote-template-desc" });
    createCard.addEventListener("click", () => {
      new CustomTemplateModal(
        this.app as App, this.plugin,
        () => {
          // 创建后选中新模版并刷新弹窗
          const updated = this.plugin.settings.customTemplates;
          if (updated && updated.length > 0) {
            this.selectedType = "custom";
            this.selectedCustomIndex = updated.length - 1;
          }
          this.onOpen();
        },
      ).open();
    });

    if (customTemplates.length === 0) {
      return;
    }

    for (let i = 0; i < customTemplates.length; i++) {
      const tpl = customTemplates[i];
      const isActive = this.selectedType === "custom" && this.selectedCustomIndex === i;
      const card = grid.createDiv({
        cls: `sonicnote-template-card sonicnote-custom-card ${isActive ? "sonicnote-template-active" : ""}`,
      });
      card.createEl("div", { text: tpl.name, cls: "sonicnote-template-name" });
      card.createEl("div", { text: tpl.description, cls: "sonicnote-template-desc" });

      // 选中
      card.addEventListener("click", (e) => {
        // 排除垃圾桶按钮点击
        if ((e.target as HTMLElement).closest(".sonicnote-card-delete")) return;
        this.selectedType = "custom";
        this.selectedCustomIndex = i;
        this.onOpen();
      });

      // 双击编辑
      card.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        new CustomTemplateModal(
          this.app as App, this.plugin,
          () => this.onOpen(),
          i,
        ).open();
      });

      // 右下角垃圾桶删除按钮
      const delBtn = card.createEl("button", {
        cls: "sonicnote-card-delete",
        attr: { title: "删除模版" },
      });
      setIcon(delBtn, "trash-2");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ct = this.plugin.settings.customTemplates;
        if (ct) {
          ct.splice(i, 1);
          this.plugin.saveSettings();
          if (this.selectedType === "custom" && this.selectedCustomIndex === i) {
            this.selectedCustomIndex = 0;
            if (ct.length === 0) this.selectedType = "business-meeting";
          }
          this.onOpen();
        }
      });
    }
  }
}

// ===== 主视图 =====
export class SonicNoteGeekView extends ItemView {
  private plugin: SonicNoteGeekPlugin;

  // 三个独立页面状态
  private pages: PageState[] = [createPageState(), createPageState(), createPageState()];
  private activePageIndex = 0;
  private get currentPage(): PageState { return this.pages[this.activePageIndex]; }

  private menuOpen: boolean = false;
  private lastActiveMdFile: TFile | null = null;  // 追踪最后激活的 md 文件

  // 快捷访问 plugin.settings
  private get asrConfig() { return this.plugin.getActiveASRConfig(); }
  private get speakerConfig() { return this.plugin.settings.speakerDiarization; }
  private get llmConfig() { return this.plugin.getActiveLLMConfig(); }
  private get hotWords() { return this.plugin.settings.hotWords; }
  private get voiceprintLibrary() { return this.plugin.settings.voiceprintLibrary; }

  constructor(leaf: WorkspaceLeaf, plugin: SonicNoteGeekPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_SONICNOTE_GEEK; }
  getDisplayText(): string { return "SonicNoteGeek"; }
  getIcon(): string { return "sonicnote-listen"; }

  async onOpen() {
    this.contentEl.addClass("sonicnote-asr-view");
    this.contentEl.empty();

    // 追踪最后激活的 md 文件（解决侧栏聚焦时 getActiveViewOfType 返回 null 的问题）
    this.lastActiveMdFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const f = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (f) this.lastActiveMdFile = f;
      }),
    );

    // 页面 1 自动关联当前激活的 md 文件
    this.pages[0].sourceFile = this.lastActiveMdFile;
    await this.autoExtractMp3s();

    // 智能检测文档状态（文件打开时也要检测）
    if (this.pages[0].sourceFile) {
      const state = await this.detectDocumentState(this.pages[0].sourceFile);
      this.pages[0].detectedDownloadPaths = state.downloadedPaths;
      this.pages[0].transcriptionDone = state.hasTranscript && state.hasSummary;
      this.pages[0].hasTranscript = state.hasTranscript;
      this.pages[0].hasSummary = state.hasSummary;
      this.pages[0].hasAudio = state.downloadedPaths.length > 0
        || this.pages[0].mp3Urls.length > 0
        || this.pages[0].vaultMp3Files.length > 0;
    }

    this.render();
  }

  async onClose() {
    await this.plugin.saveSettings();
    this.contentEl.empty();
  }

  private async saveState() {
    await this.plugin.saveSettings();
  }

  private findMarkdownFile(): TFile | null {
    // 优先使用追踪到的最后激活 md 文件（解决侧栏聚焦问题）
    if (this.lastActiveMdFile) return this.lastActiveMdFile;
    // 回退: 遍历所有 markdown leaf
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = leaf.view instanceof MarkdownView ? leaf.view.file : null;
      if (file) return file;
    }
    return null;
  }

  // ---- MP3 提取 ----
  private async autoExtractMp3s() {
    if (!this.currentPage.sourceFile) return;

    this.currentPage.mp3Urls = [];
    this.currentPage.selectedMp3s.clear();

    const content = await this.app.vault.read(this.currentPage.sourceFile);
    const links = extractMp3Links(content);
    // 收集已引用文件名用于去重
    const referencedNames = new Set<string>();
    for (const link of links) {
      this.currentPage.mp3Urls.push(link);
      this.currentPage.selectedMp3s.add(link);
      // 提取文件名用于与 vault 文件去重
      const name = link.split("/").pop()?.split("?")[0];
      if (name) referencedNames.add(name);
    }

    this.currentPage.vaultMp3Files = [];
    const attachments = await findMp3Attachments(this.app.vault, this.currentPage.sourceFile);
    for (const f of attachments) {
      // 跳过已在文档链接中引用的文件
      const fName = f.split("/").pop();
      if (fName && referencedNames.has(fName)) continue;
      // 跳过 SonicNoteSync 目录下的文件（属于同步/下载缓存，非用户原始音频）
      if (f.startsWith("SonicNoteSync/")) continue;
      this.currentPage.vaultMp3Files.push(f);
      this.currentPage.selectedMp3s.add(f);
    }
  }

  // ---- 智能检测文档状态 ----
  private async detectDocumentState(f: TFile): Promise<{
    downloadedPaths: string[];
    hasTranscript: boolean;
    hasSummary: boolean;
  }> {
    const content = await this.app.vault.read(f);
    const hasTranscript = content.includes("## 转录原文") || content.includes("## 转录内容") || content.includes("## 转录信息");
    const hasSummary = /^##\s+(总结|智能总结|重新总结|AI 总结|学习总结|笔记)/m.test(content);

    // 检测当前文档对应的已下载音频文件：
    // 只查找 Audio/{文档名}/ 目录 + 文档中 MP3 链接对应的下载路径
    const downloadedPaths: string[] = [];
    const vaultBase = (this.app.vault.adapter as any).basePath || "";

    // 1. 收集当前文档的 MP3 链接中提取的文件名
    const links = extractMp3Links(content);
    const expectedFiles = new Set<string>();
    for (const link of links) {
      const name = link.split("/").pop()?.split("?")[0];
      if (name) expectedFiles.add(name);
    }

    // 2. 只检查 Audio/{当前文档名}/ 目录
    const audioDir = `SonicNoteSync/Audio/${f.basename}`;
    try {
      const listing = await (this.app.vault.adapter as any).list?.(audioDir);
      for (const fp of listing?.files || []) {
        if (/\.(mp3|wav|m4a|flac)$/i.test(fp)) {
          const absPath = vaultBase ? `${vaultBase}/${fp}` : fp;
          downloadedPaths.push(absPath);
        }
      }
    } catch {}

    // 3. processor 缓存的路径中，仅保留文件名匹配当前文档 MP3 链接的
    for (const p of this.plugin.processor.lastDownloadedPaths || []) {
      if (p.startsWith("http")) continue;
      const fName = p.split("/").pop();
      if (!fName || !expectedFiles.has(fName)) continue;
      const absPath = vaultBase ? `${vaultBase}/${p}` : p;
      if (!downloadedPaths.includes(absPath)) {
        const exists = this.app.vault.getAbstractFileByPath(p);
        if (exists) downloadedPaths.push(absPath);
      }
    }

    return { downloadedPaths, hasTranscript, hasSummary };
  }

  // ---- 主渲染 ----
  private render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("sonicnote-asr-view");

    // 标题行
    const headerRow = container.createDiv({ cls: "sonicnote-header-row" });
    headerRow.createEl("div", {
      text: "SonicNoteGeek",
      cls: "sonicnote-page-title",
    });

    // 工具栏: [文件同步] [设置] [刷新] ... [1] [2] [3]
    const toolbarRow = container.createDiv({ cls: "sonicnote-toolbar-row" });
    const toolbarLeft = toolbarRow.createDiv({ cls: "sonicnote-toolbar-left" });

    // 文件同步
    const syncBtn = toolbarLeft.createEl("button", { cls: "sonicnote-toolbar-btn" });
    setIcon(syncBtn, "cloud-download");
    setTooltip(syncBtn, "文件同步");
    syncBtn.addEventListener("click", () => {
      this.plugin.triggerSync();
    });

    // 设置
    const settingsBtn = toolbarLeft.createEl("button", { cls: "sonicnote-toolbar-btn" });
    setIcon(settingsBtn, "settings");
    setTooltip(settingsBtn, "设置");
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.menuOpen = !this.menuOpen;
      if (this.menuOpen) {
        this.renderDropdown(settingsBtn);
      } else {
        const existing = document.body.querySelector(".sonicnote-menu-dropdown");
        if (existing) existing.remove();
      }
    });
    if (this.menuOpen) {
      this.renderDropdown(settingsBtn);
    }

    // 刷新
    const refreshBtn = toolbarLeft.createEl("button", { cls: "sonicnote-toolbar-btn" });
    setIcon(refreshBtn, "refresh-cw");
    setTooltip(refreshBtn, "刷新");
    refreshBtn.addEventListener("click", async () => {
      const f = this.findMarkdownFile();
      if (!f) {
        new Notice("请先打开一个 Markdown 文件");
        return;
      }
      this.currentPage.sourceFile = f;
      await this.autoExtractMp3s();

      // 智能检测: 已下载音频 + 文档是否有转录/总结
      const state = await this.detectDocumentState(f);
      this.currentPage.detectedDownloadPaths = state.downloadedPaths;
      this.currentPage.transcriptionDone = state.hasTranscript && state.hasSummary;
      this.currentPage.hasTranscript = state.hasTranscript;
      this.currentPage.hasSummary = state.hasSummary;
      this.currentPage.hasAudio = state.downloadedPaths.length > 0
        || this.currentPage.mp3Urls.length > 0
        || this.currentPage.vaultMp3Files.length > 0;

      this.render();

      const mp3Count = this.currentPage.mp3Urls.length + this.currentPage.vaultMp3Files.length;
      const parts: string[] = [`已刷新: ${f.name}`];
      if (mp3Count > 0) parts.push(`检测到 ${mp3Count} 个音频`);
      if (state.downloadedPaths.length > 0) parts.push(`已下载 ${state.downloadedPaths.length} 个`);
      if (this.currentPage.hasTranscript) parts.push("已有转录原文");
      if (this.currentPage.hasSummary) parts.push("已有总结");
      new Notice(parts.join(" | "));
    });

    // 页面切换标签 (右侧)
    const toolbarRight = toolbarRow.createDiv({ cls: "sonicnote-toolbar-right" });
    for (let i = 0; i < 3; i++) {
      const tabBtn = toolbarRight.createEl("button", {
        text: `${i + 1}`,
        cls: `sonicnote-page-tab ${this.activePageIndex === i ? "sonicnote-page-tab-active" : ""}`,
      });
      tabBtn.addEventListener("click", () => {
        this.activePageIndex = i;
        this.render();
      });
    }

    // 可滚动主体区域
    const bodyEl = container.createDiv({ cls: "sonicnote-body" });

    // 1. 音频文件选择
    if (this.currentPage.sourceFile) {
      bodyEl.createDiv({ cls: "sonicnote-file-row" }).createEl("span", {
        text: this.currentPage.sourceFile.name,
        cls: "sonicnote-doc-name",
      });
    }
    this.renderAudioSection(bodyEl);

    // 进度指示器
    this.renderProgressIndicator(bodyEl);

    // 2. 模板选择
    const hr = bodyEl.createEl("hr");
    hr.addClass("sonicnote-section-hr");
    this.renderTemplateSection(bodyEl);

    // 3. 开始处理 (包裹在居中容器中)
    const startWrap = bodyEl.createDiv({ cls: "sonicnote-start-wrap" });
    const hr2 = startWrap.createEl("hr");
    hr2.addClass("sonicnote-section-hr");
    this.renderStartButton(startWrap);

    // 4. AI 对话 (固定在底部)
    this.renderChatArea(container);
  }

  // ---- 右上角菜单 ----
  private renderDropdown(anchorBtn: HTMLElement) {
    // 移除已有下拉
    const existing = document.body.querySelector(".sonicnote-menu-dropdown");
    if (existing) existing.remove();

    const rect = anchorBtn.getBoundingClientRect();
    const dropdown = document.body.createDiv({ cls: "sonicnote-menu-dropdown" });
    dropdown.style.position = "fixed";
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.left = `${rect.left}px`;

    const items: { key: ConfigModalType; label: string }[] = [
      { key: "asr", label: "ASR 配置" },
      { key: "llm", label: "LLM 配置" },
      { key: "hotwords", label: "热词管理" },
      { key: "voiceprint", label: "声纹识别" },
    ];

    for (const item of items) {
      const el = dropdown.createDiv({ cls: "sonicnote-menu-item", text: item.label });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.menuOpen = false;
        dropdown.remove();
        new ConfigModal(this.app as App, this.plugin, item.key, () => this.render()).open();
      });
    }

    // 分隔线 + 帮助文档
    dropdown.createDiv({ cls: "sonicnote-menu-separator" });
    const helpItem = dropdown.createDiv({ cls: "sonicnote-menu-item", text: "帮助文档" });
    helpItem.addEventListener("click", (e) => {
      e.stopPropagation();
      this.menuOpen = false;
      dropdown.remove();
      window.open("https://linkaip.easylinkin.com/public/sonicnotegeek-docs.html", "_blank");
    });

    // 点击页面其他位置关闭菜单
    const closeHandler = (ev: MouseEvent) => {
      if (!dropdown.contains(ev.target as Node) && ev.target !== anchorBtn) {
        this.menuOpen = false;
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 0);
  }

  // ============================================================
  // 音频文件区域
  // ============================================================
  private renderAudioSection(container: HTMLElement) {
    // 提取的链接
    if (this.currentPage.mp3Urls.length > 0) {
      container.createEl("h4", { text: "音频链接:" });
      for (const url of this.currentPage.mp3Urls) {
        const checked = this.currentPage.selectedMp3s.has(url);
        const row = container.createDiv({ cls: "sonicnote-checkbox-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        if (checked) cb.setAttribute("checked", "checked");
        cb.addEventListener("change", () => {
          if (cb.checked) this.currentPage.selectedMp3s.add(url);
          else this.currentPage.selectedMp3s.delete(url);
        });
        row.createEl("span", { text: url, cls: "sonicnote-url-text" });
      }
    }

    if (this.currentPage.mp3Urls.length === 0) {
      container.createEl("div", {
        text: "⚠ 未检测到 MP3 链接。请在文档中添加音频链接或放入 MP3 文件后点击刷新按钮。",
        cls: "sonicnote-info-text sonicnote-warning-text",
      });
    }
  }

  // ============================================================
  // 模板选择区域 — 2×2 精选卡片 + 自定义模版 + 更多模版
  // ============================================================
  private renderTemplateSection(container: HTMLElement) {
    container.createEl("h4", { text: "选择模版" });

    const customTemplates = this.plugin.settings.customTemplates || [];

    // 2×2 精选模版卡片
    const grid = container.createDiv({ cls: "sonicnote-template-grid" });

    const featuredInfo: { type: TemplateType; label: string }[] = [
      { type: "business-meeting", label: "详细纪要" },
      { type: "general", label: "通用模版" },
      { type: "class-summary", label: "学习笔记" },
      { type: "interview", label: "访谈记录" },
    ];

    for (const fi of featuredInfo) {
      const tpl = (BUILTIN_TEMPLATES as Record<string, SummaryTemplate>)[fi.type] || customTemplates.find((t) => t.type === fi.type);
      if (!tpl) continue;
      const isActive = this.currentPage.templateType === fi.type;
      const card = grid.createDiv({
        cls: `sonicnote-template-card ${isActive ? "sonicnote-template-active" : ""}`,
      });
      card.createEl("div", { text: fi.label, cls: "sonicnote-template-name" });
      card.createEl("div", { text: tpl.description, cls: "sonicnote-template-desc" });
      card.addEventListener("click", async () => {
        this.currentPage.templateType = fi.type;
        this.currentPage.activeCustomIndex = 0;
        await this.saveState();
        this.render();
      });
    }

    // "更多模版" 按钮
    const moreRow = container.createDiv({ cls: "sonicnote-more-row" });
    const moreBtn = moreRow.createEl("button", { text: "更多模版...", cls: "sonicnote-more-btn" });
    moreBtn.addEventListener("click", () => {
      new TemplatePickerModal(
        this.app as App, this.plugin,
        this.currentPage.templateType, this.currentPage.activeCustomIndex,
        (type, customIndex) => {
          this.currentPage.templateType = type;
          if (customIndex !== undefined) this.currentPage.activeCustomIndex = customIndex;
          this.render();
        },
      ).open();
    });
  }

  // ============================================================
  // 转写总结按钮
  // ============================================================
  private renderStartButton(container: HTMLElement) {
    const urls = Array.from(this.currentPage.selectedMp3s);

    // 显示当前激活的 ASR 和 LLM 模型
    const asrName = this.plugin.getActiveASRModelName();
    const llmName = this.plugin.getActiveLLMModelName();
    const infoRow = container.createDiv({ cls: "sonicnote-asr-active-info" });
    infoRow.createEl("span", { text: `ASR: ${asrName}`, cls: "sonicnote-asr-active-label" });
    infoRow.createEl("span", { text: `LLM: ${llmName}`, cls: "sonicnote-llm-active-label" });
    if (this.speakerConfig.autoVoiceprint) {
      infoRow.createEl("span", { text: "自动声纹识别", cls: "sonicnote-voiceprint-active-label" });
    }

    // 开始转写总结 按钮
    const isBusy = this.currentPage.processing
      || this.currentPage.reTranscribing
      || this.currentPage.reSummarizing;
    const btn = container.createEl("button", {
      text: isBusy ? "处理中..." : "开始转写总结",
      cls: "sonicnote-start-btn",
    });
    if (isBusy) btn.disabled = true;

    btn.addEventListener("click", async () => {
      if (isBusy) return;
      if (urls.length === 0) { new Notice("请选择至少一个音频文件"); return; }
      if (!this.llmConfig.apiKey) { new Notice("请配置 LLM API Key"); return; }
      if (!this.currentPage.sourceFile) { new Notice("未找到关联的 Markdown 文件，请先打开一个文件后再打开面板"); return; }

      const sourceFile = this.currentPage.sourceFile;
      this.currentPage.processing = true;
      this.currentPage.processingStage = -1;
      btn.disabled = true;
      btn.setText("处理中...");
      this.render();

      try {
        await this.plugin.runProcessing(
          urls, this.asrConfig, this.speakerConfig, this.llmConfig,
          this.currentPage.templateType, this.hotWords, this.voiceprintLibrary,
          sourceFile,
          (stageIndex, label) => {
            this.currentPage.processingStage = stageIndex;
            btn.setText(`${label}...`);
            // 直接更新进度圆点
            const dots = this.contentEl.querySelectorAll(".sonicnote-progress-dot");
            dots.forEach((dot, i) => {
              if (i <= stageIndex) {
                dot.classList.add("sonicnote-progress-dot-active");
                dot.classList.remove("sonicnote-progress-dot-current");
              }
              if (i === stageIndex) {
                dot.classList.add("sonicnote-progress-dot-current");
              }
            });
            const labels = this.contentEl.querySelectorAll(".sonicnote-progress-label");
            labels.forEach((lbl, i) => {
              if (i <= stageIndex) lbl.classList.add("sonicnote-progress-label-active");
            });
            const lines = this.contentEl.querySelectorAll(".sonicnote-progress-line");
            lines.forEach((line, i) => {
              if (i < stageIndex) line.classList.add("sonicnote-progress-line-active");
            });

            // 下载完成后显示本地路径 — 只显示当前文档对应的路径
            if (stageIndex >= 1) {
              const paths = this.plugin.processor.lastDownloadedPaths || [];
              const errors = this.plugin.processor.lastDownloadErrors || [];
              const dlEl = this.contentEl.querySelector(".sonicnote-download-paths");
              if (dlEl && paths.length > 0) {
                (dlEl as HTMLElement).empty();
                (dlEl as HTMLElement).style.display = "block";

                // 只显示当前文档 MP3 链接对应的本地路径
                const refNames = new Set<string>();
                for (const url of this.currentPage.mp3Urls) {
                  const fn = url.split("/").pop()?.split("?")[0];
                  if (fn) refNames.add(fn);
                }
                const seen = new Set<string>();
                const localPaths: string[] = [];
                for (const p of paths) {
                  if (p.startsWith("http")) continue;
                  const fn = p.split("/").pop();
                  if (!fn || !refNames.has(fn)) continue;
                  if (seen.has(fn)) continue;
                  seen.add(fn);
                  const vaultBase = (this.app.vault.adapter as any).basePath || "";
                  const abs = p.startsWith("/") ? p : `${vaultBase}/${p}`;
                  localPaths.push(abs);
                }

                if (localPaths.length > 0) {
                  (dlEl as HTMLElement).createEl("div", { text: "音频下载:", cls: "sonicnote-dl-heading" });
                  for (const absPath of localPaths) {
                    (dlEl as HTMLElement).createEl("span", { text: absPath, cls: "sonicnote-dl-url" });
                  }
                }

                if (errors.length > 0) {
                  for (const err of errors) {
                    (dlEl as HTMLElement).createEl("div", {
                      text: `下载失败: ${err.error}`,
                      cls: "sonicnote-dl-error",
                    });
                  }
                } else if (localPaths.length === 0 && paths.length > 0) {
                  (dlEl as HTMLElement).createEl("span", { text: "文件未下载 (远程引用)", cls: "sonicnote-dl-label" });
                }
              }
            }
          },
          this.currentPage.customPrompt || undefined,
        );
        this.currentPage.processing = false;
        this.currentPage.processingStage = 3;
        this.currentPage.transcriptionDone = true;
        this.render();
      } catch (error) {
        this.currentPage.processing = false;
        this.currentPage.processingStage = -1;
        new Notice(`处理失败: ${error instanceof Error ? error.message : "未知错误"}`);
        console.error("SonicNoteGeek error:", error);
        this.render();
      }
    });

    // ---- 四个功能按钮 ----
    const notBusy = !this.currentPage.processing
      && !this.currentPage.reSummarizing
      && !this.currentPage.reTranscribing;

    const canReTranscribe = notBusy && this.currentPage.hasAudio;
    const canReSummarize = notBusy && this.currentPage.hasTranscript;
    const canVoiceprint = notBusy && this.currentPage.hasTranscript && this.currentPage.hasAudio;

    const actionRow = container.createDiv({ cls: "sonicnote-action-row" });

    const createActionBtn = (label: string, icon: string, enabled: boolean, onClick: () => Promise<void>) => {
      const ab = actionRow.createEl("button", { cls: "sonicnote-action-btn" });
      if (!enabled) ab.disabled = true;
      const iconSpan = ab.createSpan({});
      setIcon(iconSpan, icon);
      ab.createSpan({ text: label });
      ab.addEventListener("click", async () => {
        if (!enabled) return;
        ab.disabled = true;
        ab.addClass("sonicnote-action-btn-loading");
        try { await onClick(); }
        catch (e) { new Notice(`${label}失败: ${e instanceof Error ? e.message : "未知错误"}`); }
        finally {
          ab.disabled = false;
          ab.removeClass("sonicnote-action-btn-loading");
        }
      });
    };

    createActionBtn("重新转写", "refresh-cw", canReTranscribe, async () => {
      if (!this.currentPage.sourceFile) return;
      this.currentPage.reTranscribing = true;
      this.render();
      try {
        await this.plugin.reTranscribe(
          this.currentPage.sourceFile,
          this.currentPage.templateType,
          this.currentPage.customPrompt || undefined,
        );
      } finally {
        this.currentPage.reTranscribing = false;
        this.currentPage.hasTranscript = true;
        this.render();
      }
    });

    createActionBtn("重新总结", "file-text", canReSummarize, async () => {
      if (!this.currentPage.sourceFile) return;
      new TemplatePickerModal(
        this.app as App, this.plugin,
        this.currentPage.templateType, this.currentPage.activeCustomIndex,
        async (type, customIndex) => {
          let customPrompt: string | undefined;
          if (type === "custom" && customIndex !== undefined) {
            customPrompt = this.plugin.settings.customTemplates?.[customIndex]?.systemPrompt;
          }
          this.currentPage.reSummarizing = true;
          this.render();
          try {
            await this.plugin.reSummarize(
              this.currentPage.sourceFile!,
              type,
              customPrompt,
            );
          } finally {
            this.currentPage.reSummarizing = false;
            this.currentPage.hasSummary = true;
            this.render();
          }
        },
      ).open();
    });

    createActionBtn("人声勘正", "mic", canVoiceprint, async () => {
      await this.runVoiceprintMatch();
    });

    createActionBtn("声纹采样", "fingerprint", canVoiceprint, async () => {
      new VoiceprintSamplingModal(
        this.app as App, this.plugin,
        () => this.render(),
      ).open();
    });
  }

  // ============================================================
  // 进度指示器: 四个阶段圆点
  // ============================================================
  private renderProgressIndicator(container: HTMLElement) {
    const stages = [
      { key: 0, label: "音频下载" },
      { key: 1, label: "语音转写" },
      { key: 2, label: "分析总结" },
      { key: 3, label: "文档写入" },
    ];

    const wrapper = container.createDiv({ cls: "sonicnote-progress" });
    const dlPaths = wrapper.createDiv({ cls: "sonicnote-download-paths" });
    const dotsRow = wrapper.createDiv({ cls: "sonicnote-progress-dots" });

    // 显示下载路径（仅显示当前文档对应的路径）
    const detectedPaths = this.currentPage.detectedDownloadPaths || [];
    const savedErrors = this.plugin.processor.lastDownloadErrors || [];

    if (detectedPaths.length > 0) {
      dlPaths.style.display = "block";
      dlPaths.createEl("div", { text: "音频下载:", cls: "sonicnote-dl-heading" });
      for (const absPath of detectedPaths) {
        dlPaths.createEl("span", { text: absPath, cls: "sonicnote-dl-url" });
      }
      if (savedErrors.length > 0) {
        for (const err of savedErrors) {
          dlPaths.createEl("div", { text: `下载失败: ${err.error}`, cls: "sonicnote-dl-error" });
        }
      }
    } else {
      dlPaths.style.display = "none";
    }

    for (let i = 0; i < stages.length; i++) {
      const item = dotsRow.createDiv({ cls: "sonicnote-progress-item" });

      // 连线 (非第一个)
      if (i > 0) {
        const line = item.createDiv({ cls: "sonicnote-progress-line" });
        if (this.currentPage.processingStage >= i) {
          line.addClass("sonicnote-progress-line-active");
        }
      }

      // 圆点
      const dot = item.createDiv({
        cls: `sonicnote-progress-dot ${this.currentPage.processingStage >= stages[i].key ? "sonicnote-progress-dot-active" : ""}`,
      });

      // 当前阶段用脉冲动画
      if (this.currentPage.processing && this.currentPage.processingStage === stages[i].key) {
        dot.addClass("sonicnote-progress-dot-current");
      }

      // 标签
      item.createEl("span", {
        text: stages[i].label,
        cls: `sonicnote-progress-label ${this.currentPage.processingStage >= stages[i].key ? "sonicnote-progress-label-active" : ""}`,
      });
    }
  }

  // ============================================================
  // 人声勘正：提取逐字稿 → 声纹识别 → 更新说话人名
  // ============================================================
  private async runVoiceprintMatch() {
    const sd = this.plugin.settings.speakerDiarization;
    const vp = this.plugin.settings.voiceprintLibrary;

    if (!sd.customEndpoint) {
      new Notice("请先在声纹识别配置中设置服务地址");
      return;
    }
    if (vp.length === 0 || !vp.some((v) => v.audioSamplePath)) {
      new Notice("请先在声纹库中添加至少一个带音频样本的说话人");
      return;
    }

    // 获取当前关联的 MD 文件
    let sourceFile = this.currentPage.sourceFile;
    if (!sourceFile) {
      sourceFile = this.findMarkdownFile();
    }
    if (!sourceFile) {
      new Notice("请先打开一个包含逐字稿的 Markdown 文件");
      return;
    }

    const content = await this.app.vault.read(sourceFile);

    // 解析逐字稿区域 — 兼容两种格式:
    // 格式A (插件): **[HH:MM:SS] SpeakerName：** text
    // 格式B (FunASR): **[start -> end] [Speaker N]**: text
    const patternA = /\*\*\[(\d{2}:\d{2}(?::\d{2})?)\]\s*(.+?)[：:]\*\*\s*(.+)/g;
    const patternB = /\*\*\[([\d:.]+) -> [\d:.]+\]\s*\[([^\]]+)\]\*\*[：:]\s*(.+)/g;
    const speakerSegments = new Map<string, { starts: number[]; ends: number[] }>();
    let match: RegExpExecArray | null;

    // 先尝试格式A
    while ((match = patternA.exec(content)) !== null) {
      const startSec = this.parseTimestampHelper(match[1]);
      const speaker = match[2].trim();
      const text = match[3].trim();
      const estimatedDuration = Math.max(1, text.length / 3);
      const endSec = startSec + estimatedDuration;

      if (!speakerSegments.has(speaker)) {
        speakerSegments.set(speaker, { starts: [], ends: [] });
      }
      const sg = speakerSegments.get(speaker)!;
      sg.starts.push(startSec);
      sg.ends.push(endSec);
    }

    // 再尝试格式B (FunASR 等外部转写工具)
    if (speakerSegments.size === 0) {
      while ((match = patternB.exec(content)) !== null) {
        const startSec = this.parseTimestampHelper(match[1]);
        const speaker = match[2].trim();
        const text = match[3].trim();
        const estimatedDuration = Math.max(1, text.length / 3);
        const endSec = startSec + estimatedDuration;

        if (!speakerSegments.has(speaker)) {
          speakerSegments.set(speaker, { starts: [], ends: [] });
        }
        const sg = speakerSegments.get(speaker)!;
        sg.starts.push(startSec);
        sg.ends.push(endSec);
      }
    }

    if (speakerSegments.size === 0) {
      new Notice("未在文档中找到逐字稿段落。请先完成语音转写后再使用此功能。");
      return;
    }

    // 查找音频文件
    const audioPath = await this.findAudioFileHelper(sourceFile);
    if (!audioPath) {
      new Notice("未找到关联的音频文件。请确保音频文件存在于 vault 中。");
      return;
    }

    const vaultBase = (this.app.vault.adapter as any).basePath || "";
    const absoluteAudio = audioPath.startsWith("/") ? audioPath : `${vaultBase}/${audioPath}`;

    const speakerArray = Array.from(speakerSegments.entries()).map(([id, segs]) => ({
      speaker_id: id,
      starts: segs.starts,
      ends: segs.ends,
    }));

    try {
      const labels = await this.plugin.processor.matchVoiceprints(
        absoluteAudio, speakerArray, vp, sd.customEndpoint, sd.apiKey,
      );

      const changed: string[] = [];
      let updatedContent = content;
      for (const [speaker, name] of Object.entries(labels)) {
        if (name && name !== "未知说话人" && speaker !== name) {
          const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // 格式A: **[HH:MM:SS] SpeakerName：**
          const patternA = new RegExp(
            `(\\*\\*\\[\\d{2}:\\d{2}(?::\\d{2})?\\]\\s*)${escaped}([：:]\\*\\*)`,
            "g",
          );
          // 格式B: **[start -> end] [Speaker N]**
          const patternB = new RegExp(
            `(\\*\\*\\[[\\d:.]+ -> [\\d:.]+\\]\\s*\\[)${escaped}(\\]\\*\\*)`,
            "g",
          );
          const before = updatedContent;
          updatedContent = updatedContent.replace(patternA, `$1${name}$2`);
          updatedContent = updatedContent.replace(patternB, `$1${name}$2`);
          if (updatedContent !== before) changed.push(`${speaker} → ${name}`);
        }
      }

      if (changed.length > 0) {
        await this.app.vault.modify(sourceFile, updatedContent);
        new Notice(`人声勘正完成！已更新: ${changed.join(", ")}`);
      } else {
        new Notice("人声勘正完成，但未找到可更新的匹配项。");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("人声勘正失败:", e);
      new Notice(`人声勘正失败: ${msg}`);
    }
  }

  private parseTimestampHelper(ts: string): number {
    const parts = ts.split(":");
    if (parts.length === 3) {
      return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }

  private async findAudioFileHelper(sourceFile: TFile): Promise<string | null> {
    const content = await this.app.vault.read(sourceFile);

    // audio_url 字段
    const audioUrlMatch = content.match(/audio_url[：:]\s*["']?([^"'\s]+)["']?/m);
    if (audioUrlMatch) {
      let url = audioUrlMatch[1].trim().replace(/["']$/, "");
      if (url.startsWith("http://") || url.startsWith("https://")) {
        try {
          const fileName = url.split("/").pop()?.split("?")[0] || `audio_${Date.now()}.mp3`;
          const dirPath = `SonicNoteSync/Audio/${sourceFile.basename}`;
          const savePath = `${dirPath}/${fileName}`;
          const existing = this.app.vault.getAbstractFileByPath(savePath);
          if (existing) return savePath;
          try { await this.app.vault.createFolder(dirPath); } catch {}
          const resp = await requestUrl({ url, method: "GET", throw: false });
          if (resp.status === 200) {
            await this.app.vault.createBinary(savePath, resp.arrayBuffer);
            return savePath;
          }
        } catch {}
      } else {
        const f = this.app.vault.getAbstractFileByPath(url);
        if (f) return url;
      }
    }

    // MP3 链接
    const mp3Links = extractMp3Links(content);
    for (const link of mp3Links) {
      if (link.startsWith("http")) continue;
      const f = this.app.vault.getAbstractFileByPath(link);
      if (f) return link;
    }

    // 嵌入音频
    const embedMatch = content.match(/!\[\[([^\]]+\.(mp3|wav|m4a|flac))\]\]/i);
    if (embedMatch) {
      const f = this.app.vault.getAbstractFileByPath(embedMatch[1]);
      if (f) return embedMatch[1];
    }

    // SonicNoteSync/Audio 目录
    const audioDir = `SonicNoteSync/Audio/${sourceFile.basename}`;
    try {
      const dir = this.app.vault.getAbstractFileByPath(audioDir);
      if (dir) {
        const listing = await (this.app.vault.adapter as any).list?.(audioDir);
        for (const fPath of (listing?.files || [])) {
          if (/\.(mp3|wav|m4a|flac)$/i.test(fPath)) return fPath;
        }
      }
    } catch {}

    // processor 缓存
    for (const p of this.plugin.processor.lastDownloadedPaths || []) {
      if (!p.startsWith("http")) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f) return p;
      }
    }

    return null;
  }

  // ============================================================
  // AI 对话区域
  // ============================================================
  private renderChatArea(container: HTMLElement) {
    const chatContainer = container.createDiv({ cls: "sonicnote-chat-container" });
    chatContainer.style.height = `${this.currentPage.chatHeight}px`;

    // 拖拽调整高度的把手
    const resizeHandle = chatContainer.createDiv({ cls: "sonicnote-chat-resize" });
    this.setupResizeDrag(resizeHandle, chatContainer);

    chatContainer.createEl("h4", { text: "AI小录" });

    // 消息列表
    const messagesEl = chatContainer.createDiv({ cls: "sonicnote-chat-messages" });
    for (const msg of this.currentPage.chatMessages) {
      const wrapper = messagesEl.createDiv({
        cls: `sonicnote-chat-row sonicnote-chat-row-${msg.role}`,
      });
      const bubble = wrapper.createDiv({
        cls: `sonicnote-chat-message sonicnote-chat-message-${msg.role}`,
      });

      if (msg.role === "assistant" && msg.content !== "思考中...") {
        MarkdownRenderer.renderMarkdown(msg.content, bubble, "", this);
      } else {
        bubble.setText(msg.content);
      }

      // 复制按钮 (仅 AI 回复显示)
      if (msg.role === "assistant" && msg.content !== "思考中...") {
        const copyBtn = wrapper.createEl("button", {
          cls: "sonicnote-chat-copy-btn",
          attr: { title: "复制" },
        });
        setIcon(copyBtn, "copy");
        copyBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(msg.content);
          new Notice("已复制到剪贴板");
        });
      }
    }

    if (this.currentPage.chatMessages.length === 0) {
      messagesEl.createEl("div", {
        text: "基于当前 Markdown 文档内容进行 AI 问答。",
        cls: "sonicnote-chat-placeholder",
      });
    }

    // 文本输入 (带内嵌工具栏)
    const inputWrap = chatContainer.createDiv({ cls: "sonicnote-chat-input-wrap" });
    const input = inputWrap.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder: "输入问题... (Enter 发送, Shift+Enter 换行)",
      },
      cls: "sonicnote-chat-input",
    });

    const doSend = () => {
      const text = input.value.trim();
      if (text) {
        this.sendChatMessage(text);
        input.value = "";
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
  }

  private async sendChatMessage(message: string) {
    this.currentPage.chatMessages.push({ role: "user", content: message });

    const sourceFile = this.currentPage.sourceFile;
    if (!sourceFile) {
      this.currentPage.chatMessages.push({
        role: "assistant",
        content: "请先绑定一个 Markdown 文档到此页面（点击刷新按钮）。",
      });
      this.render();
      return;
    }

    const llmCfg = this.llmConfig;
    if (!llmCfg.apiKey) {
      this.currentPage.chatMessages.push({
        role: "assistant",
        content: "请先在设置中配置 LLM 模型的 API Key。",
      });
      this.render();
      return;
    }

    let docContent: string;
    try {
      docContent = await this.app.vault.read(sourceFile);
    } catch {
      this.currentPage.chatMessages.push({
        role: "assistant",
        content: "无法读取当前文档内容。",
      });
      this.render();
      return;
    }

    const systemPrompt = `你是一个文档分析助手。用户正在编写/阅读一篇 Markdown 文档，请根据文档内容回答用户的问题。文档标题: ${sourceFile.basename}`;
    const contextPrompt = `以下是我正在编辑的 Markdown 文档的完整内容:\n\n${docContent}\n\n---\n\n我的问题: ${message}`;

    // 临时添加一个 "思考中..." 消息
    const thinkingIdx = this.currentPage.chatMessages.length;
    this.currentPage.chatMessages.push({ role: "assistant", content: "思考中..." });
    this.render();

    try {
      const response = await this.plugin.processor.callLLM(
        llmCfg, systemPrompt, contextPrompt,
      );
      this.currentPage.chatMessages[thinkingIdx] = { role: "assistant", content: response };
    } catch (error) {
      this.currentPage.chatMessages[thinkingIdx] = {
        role: "assistant",
        content: `调用 LLM 失败: ${error instanceof Error ? error.message : "未知错误"}`,
      };
    }

    this.render();
  }

  // ---- 聊天窗口拖拽调整高度 ----
  private setupResizeDrag(handle: HTMLElement, chatContainer: HTMLElement) {
    let startY = 0;
    let startHeight = 0;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = chatContainer.offsetHeight;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    };

    const onMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY; // 向上拖动增大高度
      const newHeight = Math.max(120, Math.min(800, startHeight + delta));
      chatContainer.style.height = `${newHeight}px`;
      this.currentPage.chatHeight = newHeight;
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    handle.addEventListener("mousedown", onMouseDown);
  }
}
