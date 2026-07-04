import { App, Modal, Notice, TFile, Setting, TextComponent, DropdownComponent } from "obsidian";
import type {
  ASRProtocol, ASRConfig, SpeakerDiarizationConfig, LLMConfig,
  LLMProviderType, TemplateType, HotWord, VoiceprintEntry,
} from "./types";
import { extractMp3Links, findMp3Attachments } from "./utils/mp3-extractor";
import { getAllTemplateOptions } from "./templates";

type WizardStep = "extract" | "asr" | "speaker" | "llm" | "template" | "hotwords" | "confirm";

const ASR_LABELS: Record<ASRProtocol, string> = {
  "openai-whisper": "OpenAI Whisper 兼容",
  "volcengine": "火山引擎 (豆包 ASR)",
  "aliyun-dashscope": "阿里云 DashScope (Fun-ASR)",
  "xunfei": "讯飞 (上传/轮询)",
  "tencent": "腾讯云 (提交/轮询)",
  "baidu": "百度云 (OAuth/轮询)",
  "huawei": "华为云 (SDK签名/轮询)",
  "local-openai": "OpenAI 兼容 (通用)",
};

const LLM_LABELS: Record<LLMProviderType, string> = {
  "anthropic": "Anthropic Claude",
  "openai": "OpenAI (GPT-4o)",
  "zhipu": "智谱 (GLM)",
  "deepseek": "DeepSeek",
  "minimax": "MiniMax",
  "google": "Google Gemini",
  "aliyun": "阿里云 (通义千问)",
  "baidu": "百度 (文心一言)",
  "bytedance": "字节跳动 (豆包)",
  "tencent": "腾讯 (混元)",
  "huawei": "华为 (盘古)",
  "moonshot": "月之暗面 (Kimi)",
  "xunfei": "讯飞 (星火)",
  "mistral": "Mistral AI",
  "meta": "Meta (Llama)",
  "custom": "自定义 LLM",
};

const LANGUAGE_OPTIONS: Record<string, string> = {
  "zh": "中文", "en": "英文", "ja": "日语", "ko": "韩语",
  "auto": "自动检测", "yue": "粤语", "fr": "法语", "de": "德语", "es": "西班牙语",
};

type ProcessingProgressCallback = (stage: string, percent: number) => void;

export class SonicNoteAsrModal extends Modal {
  // 源文件
  private sourceFile: TFile | null = null;

  // Step 1: MP3 链接
  private mp3Urls: string[] = [];
  private vaultMp3Files: string[] = [];
  private selectedMp3s: Set<string> = new Set();

  // Step 2: ASR 配置
  private asrConfig: ASRConfig;

  // Step 3: 说话人配置
  private speakerConfig: SpeakerDiarizationConfig;

  // Step 4: LLM 配置
  private llmConfig: LLMConfig;

  // Step 5: 模板
  private templateType: TemplateType = "business-meeting";

  // Step 6: 热词 & 声纹
  private hotWords: HotWord[] = [];
  private voiceprintLibrary: VoiceprintEntry[] = [];

  private currentStep: WizardStep = "extract";

  // 回调
  private onConfirmCallback?: (
    mp3Urls: string[],
    asrConfig: ASRConfig,
    speakerConfig: SpeakerDiarizationConfig,
    llmConfig: LLMConfig,
    templateType: TemplateType,
    hotWords: HotWord[],
    voiceprintLibrary: VoiceprintEntry[],
    sourceFile: TFile,
    progressCallback: ProcessingProgressCallback,
  ) => Promise<string>;

  // UI 状态
  private stepContentEl!: HTMLElement;

  constructor(
    app: App,
    sourceFile: TFile | null,
    defaultAsr: ASRConfig,
    defaultSpeaker: SpeakerDiarizationConfig,
    defaultLlm: LLMConfig,
    defaultHotWords: HotWord[],
    defaultVoiceprints: VoiceprintEntry[],
  ) {
    super(app);
    this.sourceFile = sourceFile;
    this.asrConfig = { ...defaultAsr };
    this.speakerConfig = { ...defaultSpeaker };
    this.llmConfig = { ...defaultLlm };
    this.hotWords = [...defaultHotWords];
    this.voiceprintLibrary = [...defaultVoiceprints];
  }

  setOnConfirm(
    callback: (
      mp3Urls: string[],
      asrConfig: ASRConfig,
      speakerConfig: SpeakerDiarizationConfig,
      llmConfig: LLMConfig,
      templateType: TemplateType,
      hotWords: HotWord[],
      voiceprintLibrary: VoiceprintEntry[],
      sourceFile: TFile,
      progressCallback: ProcessingProgressCallback,
    ) => Promise<string>,
  ) {
    this.onConfirmCallback = callback;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("音频转写与总结");
    this.stepContentEl = contentEl;
    contentEl.addClass("sonicnote-asr-modal");

    // 自动提取当前文件的 MP3 链接
    this.autoExtractMp3s();

    this.renderCurrentStep();
  }

  // ===== 自动提取 MP3 =====
  private async autoExtractMp3s() {
    if (!this.sourceFile) return;

    // 从 Markdown 内容提取
    const content = await this.app.vault.read(this.sourceFile);
    const links = extractMp3Links(content);
    for (const link of links) {
      if (!this.mp3Urls.includes(link)) {
        this.mp3Urls.push(link);
        this.selectedMp3s.add(link);
      }
    }

    // 查找 vault 中的附件
    const attachments = await findMp3Attachments(this.app.vault, this.sourceFile);
    for (const f of attachments) {
      if (!this.vaultMp3Files.includes(f)) {
        this.vaultMp3Files.push(f);
      }
    }
  }

  // ===== 步骤渲染 =====
  private renderCurrentStep() {
    this.stepContentEl.empty();
    this.renderStepIndicator();
    this.stepContentEl.createDiv({ cls: "modal-step-divider" });

    switch (this.currentStep) {
      case "extract": this.renderExtractStep(); break;
      case "asr": this.renderASRStep(); break;
      case "speaker": this.renderSpeakerStep(); break;
      case "llm": this.renderLLMStep(); break;
      case "template": this.renderTemplateStep(); break;
      case "hotwords": this.renderHotWordsStep(); break;
      case "confirm": this.renderConfirmStep(); break;
    }
  }

  private renderStepIndicator() {
    const steps: { key: WizardStep; label: string }[] = [
      { key: "extract", label: "1.音频文件" },
      { key: "asr", label: "2.ASR转写" },
      { key: "speaker", label: "3.说话人识别" },
      { key: "llm", label: "4.LLM配置" },
      { key: "template", label: "5.模板" },
      { key: "hotwords", label: "6.热词/声纹" },
      { key: "confirm", label: "7.确认" },
    ];

    const indicator = this.stepContentEl.createDiv({ cls: "modal-step-indicator" });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepEl = indicator.createDiv({ cls: "modal-step-item" });
      if (step.key === this.currentStep) {
        stepEl.addClass("modal-step-active");
      } else if (steps.findIndex((s) => s.key === this.currentStep) > i) {
        stepEl.addClass("modal-step-done");
      }
      stepEl.setText(step.label);
    }
  }

  // ===== Step 1: 提取音频链接 =====
  private renderExtractStep() {
    this.stepContentEl.createEl("h3", { text: "音频文件选择" });

    // 说明
    if (this.mp3Urls.length === 0 && this.vaultMp3Files.length === 0) {
      this.stepContentEl.createEl("div", {
        text: "当前文档中未检测到 MP3 链接。你可以手动粘贴 MP3 链接，或选择 vault 中的 MP3 文件。",
        cls: "modal-info-text",
      });
    }

    // 已提取的链接
    if (this.mp3Urls.length > 0) {
      this.stepContentEl.createEl("h4", { text: "从文档中提取的链接:" });
      for (const url of this.mp3Urls) {
        const checked = this.selectedMp3s.has(url);
        const row = this.stepContentEl.createDiv({ cls: "modal-checkbox-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        if (checked) cb.setAttribute("checked", "checked");
        cb.addEventListener("change", () => {
          if (cb.checked) this.selectedMp3s.add(url);
          else this.selectedMp3s.delete(url);
        });
        row.createEl("span", { text: url, cls: "modal-url-text" });
      }
    }

    // Vault 中的 MP3 文件
    if (this.vaultMp3Files.length > 0) {
      this.stepContentEl.createEl("h4", { text: "Vault 中的 MP3 文件:" });
      for (const filePath of this.vaultMp3Files) {
        const checked = this.selectedMp3s.has(filePath);
        const row = this.stepContentEl.createDiv({ cls: "modal-checkbox-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        if (checked) cb.setAttribute("checked", "checked");
        cb.addEventListener("change", () => {
          if (cb.checked) this.selectedMp3s.add(filePath);
          else this.selectedMp3s.delete(filePath);
        });
        row.createEl("span", { text: filePath, cls: "modal-url-text" });
      }
    }

    // 手动添加链接
    this.stepContentEl.createEl("h4", { text: "手动添加 MP3 链接:" });
    const inputRow = this.stepContentEl.createDiv({ cls: "modal-input-row" });
    const input = inputRow.createEl("input", {
      type: "text",
      placeholder: "输入 MP3 文件 URL 或 vault 路径...",
      cls: "modal-url-input",
    });
    const addBtn = inputRow.createEl("button", { text: "添加" });
    addBtn.addEventListener("click", () => {
      const val = input.value.trim();
      if (val && !this.selectedMp3s.has(val)) {
        this.selectedMp3s.add(val);
        if (!this.mp3Urls.includes(val)) this.mp3Urls.push(val);
        this.renderCurrentStep();
      }
      input.value = "";
    });

    this.renderNavButtons(
      undefined,
      () => { this.currentStep = "asr"; this.renderCurrentStep(); },
    );
  }

  // ===== Step 2: ASR 配置 =====
  private renderASRStep() {
    this.stepContentEl.createEl("h3", { text: "语音转写 (ASR) 配置" });

    // 提供商选择
    new Setting(this.stepContentEl)
      .setName("ASR 提供商")
      .setDesc("选择语音转写引擎")
      .addDropdown((dropdown) => {
        for (const [key, label] of Object.entries(ASR_LABELS)) {
          dropdown.addOption(key, label);
        }
        dropdown.setValue(this.asrConfig.protocol);
        dropdown.onChange((value) => {
          this.asrConfig.protocol = value as ASRProtocol;
          this.renderCurrentStep();
        });
      });

    // 本地服务配置
    if (this.asrConfig.protocol.startsWith("local-")) {
      new Setting(this.stepContentEl)
        .setName("本地服务地址")
        .setDesc("OpenAI 兼容的本地 ASR 服务端点")
        .addText((text) =>
          text.setPlaceholder("http://localhost:8000")
            .setValue(this.asrConfig.localEndpoint || "")
            .onChange((value) => { this.asrConfig.localEndpoint = value; }));
    }

    // 云端 API 配置
    if (!this.asrConfig.protocol.startsWith("local-")) {
      new Setting(this.stepContentEl)
        .setName("API Key")
        .setDesc("云端 ASR 服务的 API 密钥")
        .addText((text) => {
          text.setPlaceholder("sk-...")
            .setValue(this.asrConfig.apiKey || "")
            .onChange((value) => { this.asrConfig.apiKey = value; });
          text.inputEl.type = "password";
        });

      if (this.asrConfig.protocol === "volcengine") {
        new Setting(this.stepContentEl)
          .setName("API Key")
          .addText((text) => {
            text.setPlaceholder("请输入 API Key")
              .setValue(this.asrConfig.apiKey || "")
              .onChange((value) => { this.asrConfig.apiKey = value; });
            text.inputEl.type = "password";
          });

        new Setting(this.stepContentEl)
          .setName("资源 ID (可选)")
          .addText((text) =>
            text.setPlaceholder("资源实例 ID")
              .setValue(this.asrConfig.resourceId || "")
              .onChange((value) => { this.asrConfig.resourceId = value; }));
      }
    }

    // 语言选择
    new Setting(this.stepContentEl)
      .setName("转写语言")
      .setDesc("选择音频中的语言")
      .addDropdown((dropdown) => {
        for (const [key, label] of Object.entries(LANGUAGE_OPTIONS)) {
          dropdown.addOption(key, label);
        }
        dropdown.setValue(this.asrConfig.language);
        dropdown.onChange((value) => { this.asrConfig.language = value; });
      });

    // ASR 内置说话人分离
    new Setting(this.stepContentEl)
      .setName("ASR 内置说话人分离")
      .setDesc("如果 ASR 支持则启用")
      .addToggle((toggle) =>
        toggle.setValue(this.asrConfig.enableSpeakerDiarization)
          .onChange((value) => { this.asrConfig.enableSpeakerDiarization = value; }));

    this.renderNavButtons(
      () => { this.currentStep = "extract"; this.renderCurrentStep(); },
      () => { this.currentStep = "speaker"; this.renderCurrentStep(); },
    );
  }

  // ===== Step 3: 说话人识别配置 =====
  private renderSpeakerStep() {
    this.stepContentEl.createEl("h3", { text: "说话人识别 / 声纹识别 配置" });

    new Setting(this.stepContentEl)
      .setName("启用说话人识别")
      .setDesc("关闭则使用默认的发言人标签（发言人A/B/C...）")
      .addToggle((toggle) =>
        toggle.setValue(this.speakerConfig.enabled)
          .onChange((value) => {
            this.speakerConfig.enabled = value;
            this.renderCurrentStep();
          }));

    if (this.speakerConfig.enabled) {
      new Setting(this.stepContentEl)
        .setName("识别方式")
        .addDropdown((dropdown) => {
          dropdown.addOption("none", "不使用（跳过）");
          dropdown.addOption("builtin", "内置启发式识别");
          dropdown.addOption("custom", "自定义声纹识别服务");
          dropdown.setValue(this.speakerConfig.modelType);
          dropdown.onChange((value) => {
            this.speakerConfig.modelType = value as "none" | "builtin" | "custom";
            this.renderCurrentStep();
          });
        });

      if (this.speakerConfig.modelType === "custom") {
        new Setting(this.stepContentEl)
          .setName("声纹识别 API URL")
          .addText((text) =>
            text.setPlaceholder("https://your-diarization-api.com")
              .setValue(this.speakerConfig.customEndpoint || "")
              .onChange((value) => { this.speakerConfig.customEndpoint = value; }));

        new Setting(this.stepContentEl)
          .setName("API Key")
          .addText((text) => {
            text.setPlaceholder("sk-...")
              .setValue(this.speakerConfig.apiKey || "")
              .onChange((value) => { this.speakerConfig.apiKey = value; });
            text.inputEl.type = "password";
          });
      }

      new Setting(this.stepContentEl)
        .setName("最少说话人数")
        .addSlider((slider) =>
          slider.setLimits(1, 5, 1)
            .setValue(this.speakerConfig.minSpeakers)
            .setDynamicTooltip()
            .onChange((value) => { this.speakerConfig.minSpeakers = value; }));

      new Setting(this.stepContentEl)
        .setName("最多说话人数")
        .addSlider((slider) =>
          slider.setLimits(2, 20, 1)
            .setValue(this.speakerConfig.maxSpeakers)
            .setDynamicTooltip()
            .onChange((value) => { this.speakerConfig.maxSpeakers = value; }));
    }

    this.renderNavButtons(
      () => { this.currentStep = "asr"; this.renderCurrentStep(); },
      () => { this.currentStep = "llm"; this.renderCurrentStep(); },
    );
  }

  // ===== Step 4: LLM 配置 =====
  private renderLLMStep() {
    this.stepContentEl.createEl("h3", { text: "大语言模型 (LLM) 配置" });

    new Setting(this.stepContentEl)
      .setName("LLM 提供商")
      .addDropdown((dropdown) => {
        for (const [key, label] of Object.entries(LLM_LABELS)) {
          dropdown.addOption(key, label);
        }
        dropdown.setValue(this.llmConfig.provider);
        dropdown.onChange((value) => {
          this.llmConfig.provider = value as LLMProviderType;
          this.renderCurrentStep();
        });
      });

    new Setting(this.stepContentEl)
      .setName("API Key")
      .addText((text) => {
        text.setPlaceholder("sk-...")
          .setValue(this.llmConfig.apiKey)
          .onChange((value) => { this.llmConfig.apiKey = value; });
        text.inputEl.type = "password";
      });

    new Setting(this.stepContentEl)
      .setName("API URL")
      .setDesc("LLM API 端点地址")
      .addText((text) =>
        text.setPlaceholder("https://api.anthropic.com/v1/messages")
          .setValue(this.llmConfig.apiUrl)
          .onChange((value) => { this.llmConfig.apiUrl = value; }));

    new Setting(this.stepContentEl)
      .setName("模型")
      .addText((text) =>
        text.setPlaceholder("claude-haiku-3-5-sonnet / gpt-4o-mini")
          .setValue(this.llmConfig.model)
          .onChange((value) => { this.llmConfig.model = value; }));

    new Setting(this.stepContentEl)
      .setName("最大 Token 数")
      .addSlider((slider) =>
        slider.setLimits(512, 16384, 256)
          .setValue(this.llmConfig.maxTokens)
          .setDynamicTooltip()
          .onChange((value) => { this.llmConfig.maxTokens = value; }));

    new Setting(this.stepContentEl)
      .setName("Temperature (创造性)")
      .addSlider((slider) =>
        slider.setLimits(0, 2, 0.1)
          .setValue(this.llmConfig.temperature)
          .setDynamicTooltip()
          .onChange((value) => { this.llmConfig.temperature = value; }));

    this.renderNavButtons(
      () => { this.currentStep = "speaker"; this.renderCurrentStep(); },
      () => { this.currentStep = "template"; this.renderCurrentStep(); },
    );
  }

  // ===== Step 5: 模板选择 =====
  private renderTemplateStep() {
    this.stepContentEl.createEl("h3", { text: "总结模板选择" });

    const templateOptions = getAllTemplateOptions([]);

    for (const option of templateOptions) {
      const isActive = this.templateType === option.value;
      const card = this.stepContentEl.createDiv({
        cls: `modal-template-card ${isActive ? "modal-template-active" : ""}`,
      });

      card.createEl("div", { text: option.label, cls: "modal-template-name" });
      card.createEl("div", { text: option.description, cls: "modal-template-desc" });

      card.addEventListener("click", () => {
        this.templateType = option.value;
        this.renderCurrentStep();
      });
    }

    this.renderNavButtons(
      () => { this.currentStep = "llm"; this.renderCurrentStep(); },
      () => { this.currentStep = "hotwords"; this.renderCurrentStep(); },
    );
  }

  // ===== Step 6: 热词与声纹 =====
  private renderHotWordsStep() {
    this.stepContentEl.createEl("h3", { text: "热词管理与声纹识别库" });

    // 热词
    this.stepContentEl.createEl("h4", { text: "热词设置" });
    this.stepContentEl.createEl("p", {
      text: "添加专业术语、人名等热词以提高转写准确率。每行一个，格式：词语,权重(1-10)。\n当前仅 火山引擎 / 讯飞 / 腾讯云 支持热词，其他协议无效。",
      cls: "setting-item-description",
    });

    const hotWordsArea = this.stepContentEl.createEl("textarea", {
      attr: { rows: "6", placeholder: "人工智能,10\n大语言模型,9\n张三,8" },
    });
    hotWordsArea.value = this.hotWords.map((h) => `${h.word}${h.weight ? `,${h.weight}` : ""}`).join("\n");
    hotWordsArea.addClass("sonicnote-asr-textarea");
    hotWordsArea.addEventListener("change", () => {
      const lines = hotWordsArea.value.split("\n").filter((l) => l.trim());
      this.hotWords = lines.map((line) => {
        const [word, weightStr] = line.split(",");
        return { word: word.trim(), weight: weightStr ? parseInt(weightStr.trim()) : 5 };
      });
    });

    // 声纹库
    this.stepContentEl.createEl("h4", { text: "声纹识别库" });
    this.stepContentEl.createEl("p", {
      text: "格式：姓名,声纹样本路径,描述（每行一个）",
      cls: "setting-item-description",
    });

    const vpArea = this.stepContentEl.createEl("textarea", {
      attr: { rows: "5", placeholder: "张三,audio/zhangsan.mp3,技术总监\n李四,audio/lisi.mp3,产品经理" },
    });
    vpArea.value = this.voiceprintLibrary
      .map((v) => `${v.name},${v.audioSamplePath || ""},${v.description || ""}`).join("\n");
    vpArea.addClass("sonicnote-asr-textarea");
    vpArea.addEventListener("change", () => {
      const lines = vpArea.value.split("\n").filter((l) => l.trim());
      this.voiceprintLibrary = lines.map((line, i) => {
        const [name, audioSamplePath, description] = line.split(",");
        return {
          id: `vp_${i}_${Date.now()}`,
          name: (name || "").trim(),
          audioSamplePath: (audioSamplePath || "").trim(),
          description: (description || "").trim(),
        };
      });
    });

    this.renderNavButtons(
      () => { this.currentStep = "template"; this.renderCurrentStep(); },
      () => { this.currentStep = "confirm"; this.renderCurrentStep(); },
    );
  }

  // ===== Step 7: 确认 =====
  private renderConfirmStep() {
    this.stepContentEl.createEl("h3", { text: "确认处理配置" });

    const summary = this.stepContentEl.createDiv({ cls: "modal-confirm-summary" });

    const selectedUrls = Array.from(this.selectedMp3s);
    summary.createEl("div", { text: `📁 音频文件: ${selectedUrls.length} 个` });
    for (const url of selectedUrls) {
      summary.createEl("div", { text: `   - ${url}`, cls: "modal-confirm-detail" });
    }

    summary.createEl("div", { text: `🎤 ASR 引擎: ${ASR_LABELS[this.asrConfig.protocol]}` });
    summary.createEl("div", { text: `🌐 语言: ${LANGUAGE_OPTIONS[this.asrConfig.language] || this.asrConfig.language}` });

    summary.createEl("div", {
      text: `👥 说话人识别: ${this.speakerConfig.enabled ? this.speakerConfig.modelType : "关闭"}`,
    });

    summary.createEl("div", { text: `🤖 LLM: ${LLM_LABELS[this.llmConfig.provider]} / ${this.llmConfig.model}` });

    const templateOptions = getAllTemplateOptions([]);
    const selectedTemplate = templateOptions.find((t) => t.value === this.templateType);
    summary.createEl("div", { text: `📝 模板: ${selectedTemplate?.label || "自定义"}` });

    summary.createEl("div", { text: `🔥 热词: ${this.hotWords.length} 个` });
    summary.createEl("div", { text: `🗣️ 声纹样本: ${this.voiceprintLibrary.length} 个` });

    // 确认按钮
    const btnRow = this.stepContentEl.createDiv({ cls: "modal-button-row" });

    const backBtn = btnRow.createEl("button", { text: "上一步" });
    backBtn.addEventListener("click", () => {
      this.currentStep = "hotwords";
      this.renderCurrentStep();
    });

    const confirmBtn = btnRow.createEl("button", { text: "开始处理", cls: "mod-cta" });
    confirmBtn.addEventListener("click", async () => {
      const urls = Array.from(this.selectedMp3s);
      if (urls.length === 0) {
        new Notice("请选择至少一个音频文件");
        return;
      }
      if (!this.llmConfig.apiKey) {
        new Notice("请配置 LLM API Key");
        return;
      }
      if (!this.sourceFile) {
        new Notice("无法获取源文件信息");
        return;
      }

      // 禁用按钮
      confirmBtn.disabled = true;
      confirmBtn.setText("处理中...");

      const progressNotice = new Notice("正在处理...", 0);

      try {
        const progressCallback: ProcessingProgressCallback = (stage, percent) => {
          progressNotice.setMessage(`${stage} (${percent}%)`);
        };

        if (this.onConfirmCallback) {
          await this.onConfirmCallback(
            urls, this.asrConfig, this.speakerConfig, this.llmConfig,
            this.templateType, this.hotWords, this.voiceprintLibrary,
            this.sourceFile, progressCallback,
          );
        }
        progressNotice.hide();
        this.close();
      } catch (error) {
        progressNotice.hide();
        new Notice(`处理失败: ${error instanceof Error ? error.message : "未知错误"}`);
        confirmBtn.disabled = false;
        confirmBtn.setText("重试");
        console.error("Audio Transcriber error:", error);
      }
    });
  }

  // ===== 导航按钮 =====
  private renderNavButtons(onPrev?: () => void, onNext?: () => void) {
    const row = this.stepContentEl.createDiv({ cls: "modal-button-row" });

    if (onPrev) {
      const prevBtn = row.createEl("button", { text: "上一步" });
      prevBtn.addEventListener("click", onPrev);
    } else {
      row.createDiv({ cls: "modal-button-spacer" });
    }

    if (onNext) {
      const nextBtn = row.createEl("button", { text: "下一步", cls: "mod-cta" });
      nextBtn.addEventListener("click", () => {
        // 验证
        if (this.currentStep === "extract" && this.selectedMp3s.size === 0) {
          new Notice("请选择至少一个音频文件，或手动添加 MP3 链接");
          return;
        }
        if (this.currentStep === "asr") {
          if (!this.asrConfig.protocol.startsWith("local-") && !this.asrConfig.apiKey) {
            new Notice("请输入 ASR API Key");
            return;
          }
        }
        onNext();
      });
    }
  }

  onClose() {
    this.stepContentEl.empty();
  }
}
