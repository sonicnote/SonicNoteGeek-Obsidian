import { App, Modal, setIcon } from "obsidian";
import type { ASRModelEntry, ASRProtocol, ASRProviderPreset } from "../types";
import { AsrGuideModal, getGuideLabel } from "./asr-guide";

// ---- 预设服务商定义 ----
interface PresetDef {
  preset: ASRProviderPreset;
  name: string;
  protocol: ASRProtocol;
  defaultUrl: string;
  defaultModel?: string;
  desc: string;
}

const ASR_PRESETS: PresetDef[] = [
  {
    preset: "openai", name: "OpenAI Whisper", protocol: "openai-whisper",
    defaultUrl: "https://api.openai.com/v1/audio/transcriptions",
    defaultModel: "whisper-1", desc: "OpenAI 官方语音转写服务",
  },
  {
    preset: "volcengine", name: "火山引擎 BigModel", protocol: "volcengine",
    defaultUrl: "https://openspeech.bytedance.com/api/v3/auc/bigmodel",
    defaultModel: "bigmodel", desc: "字节跳动豆包语音识别",
  },
  {
    preset: "aliyun", name: "阿里云 Fun-ASR", protocol: "aliyun-dashscope",
    defaultUrl: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
    defaultModel: "fun-asr-flash-2026-06-15", desc: "阿里云 DashScope 语音识别",
  },
  {
    preset: "xunfei", name: "讯飞 ASR", protocol: "xunfei",
    defaultUrl: "https://office-api-ist-dx.iflyaisol.com",
    defaultModel: "ifasr_llm", desc: "科大讯飞录音文件转写大模型",
  },
  {
    preset: "tencent", name: "腾讯云 ASR", protocol: "tencent",
    defaultUrl: "https://asr.tencentcloudapi.com",
    defaultModel: "16k_zh", desc: "腾讯云录音文件识别",
  },
  {
    preset: "baidu", name: "百度云 ASR", protocol: "baidu",
    defaultUrl: "https://aip.baidubce.com/rpc/2.0/aasr/v1",
    defaultModel: "80001", desc: "百度云长音频文件转写",
  },
  {
    preset: "huawei", name: "华为云 SIS", protocol: "huawei",
    defaultUrl: "https://sis-ext.cn-north-4.myhuaweicloud.com",
    defaultModel: "chinese_16k_media", desc: "华为云语音交互服务录音文件识别",
  },
];

const PROTOCOL_LABELS: Record<ASRProtocol, string> = {
  "openai-whisper": "OpenAI Whisper 兼容",
  "volcengine": "火山引擎 (提交/轮询)",
  "aliyun-dashscope": "阿里云 DashScope (提交/轮询)",
  "xunfei": "讯飞 (上传/轮询)",
  "tencent": "腾讯云 (提交/轮询)",
  "baidu": "百度云 (OAuth/轮询)",
  "huawei": "华为云 (SDK签名/轮询)",
  "local-openai": "OpenAI 兼容 (通用)",
};

const LANGUAGE_OPTIONS: Record<string, string> = {
  "zh": "中文", "en": "英文", "ja": "日语", "ko": "韩语",
  "auto": "自动检测", "yue": "粤语", "fr": "法语", "de": "德语", "es": "西班牙语",
};

function presetLabel(entry: ASRModelEntry): string {
  const preset = ASR_PRESETS.find((p) => p.preset === entry.preset);
  if (preset) return preset.name;
  return entry.preset === "custom" ? (entry.displayName || "自定义") : entry.preset;
}

function protocolLabel(entry: ASRModelEntry): string {
  return PROTOCOL_LABELS[entry.protocol] || entry.protocol;
}

// ---- 新增 ASR 模型弹窗 ----
export class AddAsrModelModal extends Modal {
  private plugin: { settings: { asrModels: ASRModelEntry[]; activeAsrModelId: string }; saveSettings: () => Promise<void> };
  private onSave: () => void;
  private editingModel: ASRModelEntry | null;
  private mode: "preset" | "custom" = "preset";

  // 表单字段
  private preset: ASRProviderPreset = "openai";
  private protocol: ASRProtocol = "openai-whisper";
  private apiKey = "";
  private secretKey = "";
  private apiUrl = "";
  private resourceId = "";
  private appId = "";
  private model = "";
  private localEndpoint = "http://localhost:8080";
  private language = "zh";
  private displayName = "";
  private enableSpeakerDiarization = false;
  private showAdvanced = false;

  constructor(
    app: App,
    plugin: { settings: { asrModels: ASRModelEntry[]; activeAsrModelId: string }; saveSettings: () => Promise<void> },
    onSave: () => void,
    editing?: ASRModelEntry,
  ) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave;
    this.editingModel = editing || null;
    if (editing) {
      this.mode = editing.preset === "custom" ? "custom" : "preset";
      this.preset = editing.preset;
      this.protocol = editing.protocol;
      this.apiKey = editing.apiKey || "";
      this.secretKey = editing.secretKey || "";
      this.apiUrl = editing.apiUrl || "";
      this.resourceId = editing.resourceId || "";
      this.appId = editing.appId || "";
      this.model = editing.model || "";
      this.localEndpoint = editing.localEndpoint || "http://localhost:8080";
      this.language = editing.language;
      this.displayName = editing.displayName || "";
      this.enableSpeakerDiarization = editing.enableSpeakerDiarization;
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-config-modal");
    contentEl.createEl("h3", { text: this.editingModel ? "编辑 ASR 模型" : "新增 ASR 模型" });

    // 模式切换按钮
    const modeToggle = contentEl.createDiv({ cls: "sonicnote-mode-toggle" });
    const presetBtn = modeToggle.createEl("button", {
      text: "模型服务商",
      cls: `sonicnote-mode-btn ${this.mode === "preset" ? "sonicnote-mode-active" : ""}`,
    });
    presetBtn.addEventListener("click", () => { this.mode = "preset"; this.onOpen(); });
    const customBtn = modeToggle.createEl("button", {
      text: "自定义模型",
      cls: `sonicnote-mode-btn ${this.mode === "custom" ? "sonicnote-mode-active" : ""}`,
    });
    customBtn.addEventListener("click", () => { this.mode = "custom"; this.onOpen(); });

    const wrap = this.fieldWrap(contentEl);

    if (this.mode === "preset") {
      this.renderPresetMode(wrap);
    } else {
      this.renderCustomMode(wrap);
    }

    // 保存按钮
    const btnRow = contentEl.createDiv({ cls: "sonicnote-button-row" });
    btnRow.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "sonicnote-btn-primary" });
    saveBtn.addEventListener("click", async () => {
      const entry = this.buildEntry();
      const models = this.plugin.settings.asrModels;
      if (this.editingModel) {
        const idx = models.findIndex((m) => m.id === this.editingModel!.id);
        if (idx >= 0) models[idx] = entry;
      } else {
        models.push(entry);
        if (models.length === 1) this.plugin.settings.activeAsrModelId = entry.id;
      }
      await this.plugin.saveSettings();
      this.onSave();
      this.close();
    });
  }

  private buildEntry(): ASRModelEntry {
    if (this.mode === "preset") {
      const def = ASR_PRESETS.find((p) => p.preset === this.preset)!;
      const isLocal = def.protocol.startsWith("local-");
      const isVolc = def.protocol === "volcengine";
      const isXunfei = def.protocol === "xunfei";
      const isTencent = def.protocol === "tencent";
      const isBaidu = def.protocol === "baidu";
      const isHuawei = def.protocol === "huawei";
      return {
        id: this.editingModel?.id || `asr_${Date.now()}`,
        preset: def.preset,
        protocol: def.protocol,
        displayName: this.displayName || undefined,
        apiKey: !isLocal ? (this.apiKey || undefined) : undefined,
        secretKey: (isVolc || isXunfei || isTencent || isBaidu || isHuawei) ? (this.secretKey || undefined) : undefined,
        apiUrl: !isLocal ? (this.apiUrl || def.defaultUrl) : undefined,
        resourceId: isVolc ? (this.resourceId || "volc.seedasr.auc") : undefined,
        appId: (isXunfei || isBaidu || isHuawei) ? (this.appId || undefined) : undefined,
        model: def.defaultModel || this.model || undefined,
        localEndpoint: isLocal ? this.localEndpoint : undefined,
        language: this.language,
        enableSpeakerDiarization: this.enableSpeakerDiarization,
      };
    }
    return {
      id: this.editingModel?.id || `asr_${Date.now()}`,
      preset: "custom",
      protocol: this.protocol,
      displayName: this.displayName || undefined,
      localEndpoint: this.protocol.startsWith("local-") ? this.localEndpoint : undefined,
      apiKey: !this.protocol.startsWith("local-") ? (this.apiKey || undefined) : undefined,
      apiUrl: !this.protocol.startsWith("local-") ? (this.apiUrl || undefined) : undefined,
      model: this.model || undefined,
      language: this.language,
      enableSpeakerDiarization: this.enableSpeakerDiarization,
    };
  }

  // ---- 模型服务商模式 ----
  private renderPresetMode(wrap: HTMLElement) {
    const presetOptions: Record<string, string> = {};
    for (const def of ASR_PRESETS) {
      presetOptions[def.preset] = `${def.name} — ${def.desc}`;
    }
    const presetSelect = this.fieldDropdown(wrap, "选择服务商", presetOptions, this.preset);
    presetSelect.addEventListener("change", () => {
      const selected = presetSelect.value as ASRProviderPreset;
      const def = ASR_PRESETS.find((p) => p.preset === selected);
      if (def) {
        this.preset = def.preset;
        this.protocol = def.protocol;
        this.apiUrl = def.defaultUrl;
        this.model = def.defaultModel || "";
        this.onOpen();
      }
    });

    const def = ASR_PRESETS.find((p) => p.preset === this.preset);
    if (!def) return;
    const isLocal = def.protocol.startsWith("local-");
    const isVolc = def.protocol === "volcengine";
    const isXunfei = def.protocol === "xunfei";
    const isTencent = def.protocol === "tencent";
    const isBaidu = def.protocol === "baidu";
    const isHuawei = def.protocol === "huawei";

    // 通信协议 + 接口标准按钮 同行
    this.fieldWithGuideBtn(wrap, "通信协议", PROTOCOL_LABELS[def.protocol], def.protocol);

    // API Key (非本地)
    if (!isLocal) {
      const keyLabel = isXunfei ? "APIKey (accessKeyId)"
        : isTencent ? "SecretId"
        : isHuawei ? "Access Key (AK)" : "API Key";
      const keyPlaceholder = isTencent ? "AKID..." : "sk-...";
      const keyInput = this.fieldText(wrap, keyLabel, this.apiKey, keyPlaceholder, true);
      keyInput.addEventListener("change", () => { this.apiKey = keyInput.value; });
    }

    // 讯飞额外字段
    if (isXunfei) {
      const appIdInput = this.fieldText(wrap, "APPID", this.appId, "讯飞控制台获取");
      appIdInput.addEventListener("change", () => { this.appId = appIdInput.value; });
      const skInput = this.fieldText(wrap, "APISecret", this.secretKey, "用于 HMAC-SHA1 签名", true);
      skInput.addEventListener("change", () => { this.secretKey = skInput.value; });
    }

    // 腾讯云额外字段
    if (isTencent) {
      const skInput = this.fieldText(wrap, "SecretKey", this.secretKey, "腾讯云 API 密钥", true);
      skInput.addEventListener("change", () => { this.secretKey = skInput.value; });
    }

    // 百度云额外字段
    if (isBaidu) {
      const appIdInput = this.fieldText(wrap, "AppID", this.appId, "百度云应用 AppID");
      appIdInput.addEventListener("change", () => { this.appId = appIdInput.value; });
      const skInput = this.fieldText(wrap, "Secret Key", this.secretKey, "百度云 Secret Key", true);
      skInput.addEventListener("change", () => { this.secretKey = skInput.value; });
    }

    // 华为云额外字段
    if (isHuawei) {
      const skInput = this.fieldText(wrap, "Secret Key (SK)", this.secretKey, "华为云 Secret Access Key", true);
      skInput.addEventListener("change", () => { this.secretKey = skInput.value; });
      const pidInput = this.fieldText(wrap, "Project ID", this.appId, "华为云项目 ID");
      pidInput.addEventListener("change", () => { this.appId = pidInput.value; });
    }

    // 火山引擎额外字段
    if (isVolc) {
      const ridInput = this.fieldText(wrap, "资源实例 ID（选填）", this.resourceId, "如: volc.seedasr.auc");
      ridInput.addEventListener("change", () => { this.resourceId = ridInput.value; });
    }

    // 自定义 API URL
    if (!isLocal) {
      const urlInput = this.fieldText(wrap, "API URL (可覆盖)", this.apiUrl, def.defaultUrl);
      urlInput.addEventListener("change", () => { this.apiUrl = urlInput.value; });
    }

    // 本地端点
    if (isLocal) {
      const epInput = this.fieldText(wrap, "服务地址", this.localEndpoint, "http://localhost:8000");
      epInput.addEventListener("change", () => { this.localEndpoint = epInput.value; });
      const modelInput = this.fieldText(wrap, "模型名称", this.model, "如: sensevoice, whisper-1, base");
      modelInput.addEventListener("change", () => { this.model = modelInput.value; });
    }

    const langSelect = this.fieldDropdown(wrap, "转写语言", LANGUAGE_OPTIONS, this.language);
    langSelect.addEventListener("change", () => { this.language = langSelect.value; });

    this.renderAdvanced(wrap);
  }

  // ---- 自定义模型模式 ----
  private renderCustomMode(wrap: HTMLElement) {
    // 通信协议 + 接口标准按钮 同一行 (仅 OpenAI 兼容)
    this.fieldWithGuideBtn(wrap, "通信协议", PROTOCOL_LABELS[this.protocol] || this.protocol, this.protocol,
      (newProtocol) => {
        this.protocol = newProtocol;
        this.onOpen();
      },
      { "local-openai": "OpenAI 兼容 (通用/本地)" },
    );

    // 展示名称
    const nameInput = this.fieldText(wrap, "展示名称", this.displayName, "如：我的 ASR 服务");
    nameInput.addEventListener("change", () => { this.displayName = nameInput.value; });

    // 服务地址
    const epInput = this.fieldText(wrap, "服务地址", this.localEndpoint, "http://localhost:8000");
    epInput.addEventListener("change", () => { this.localEndpoint = epInput.value; });

    // 模型名称
    const modelInput = this.fieldText(wrap, "模型名称", this.model, "如: sensevoice, whisper-1, base");
    modelInput.addEventListener("change", () => { this.model = modelInput.value; });

    const langSelect = this.fieldDropdown(wrap, "转写语言", LANGUAGE_OPTIONS, this.language);
    langSelect.addEventListener("change", () => { this.language = langSelect.value; });

    this.renderAdvanced(wrap);
  }

  // ---- 高级配置 ----
  private renderAdvanced(wrap: HTMLElement) {
    const toggleRow = wrap.createDiv({ cls: "sonicnote-config-advanced-toggle" });
    const toggleBtn = toggleRow.createEl("button", {
      text: `${this.showAdvanced ? "▾" : "▸"} 高级配置`,
      cls: "sonicnote-add-btn",
    });
    toggleBtn.addEventListener("click", () => {
      this.showAdvanced = !this.showAdvanced;
      this.onOpen();
    });

    if (this.showAdvanced) {
      const adv = wrap.createDiv({ cls: "sonicnote-advanced-section" });

      // 展示名称（仅在 preset 模式的高级配置中显示，custom 模式已在上方显示）
      if (this.mode === "preset") {
        const nameInput = this.fieldText(adv, "展示名称（可选）", this.displayName, "如：我的 ASR 服务");
        nameInput.addEventListener("change", () => { this.displayName = nameInput.value; });
      }

      const toggleRow2 = adv.createDiv({ cls: "sonicnote-checkbox-row" });
      const cb = toggleRow2.createEl("input", { type: "checkbox" });
      cb.checked = this.enableSpeakerDiarization;
      cb.addEventListener("change", () => { this.enableSpeakerDiarization = cb.checked; });
      toggleRow2.createEl("span", { text: "启用说话人分离", cls: "sonicnote-url-text" });
    }
  }

  // ---- 通信协议 + 接口标准按钮 (同一行) ----
  private fieldWithGuideBtn(
    container: HTMLElement,
    label: string,
    currentLabel: string,
    protocol: ASRProtocol,
    onChange?: (protocol: ASRProtocol) => void,
    options?: Record<string, string>,
  ) {
    this.fieldLabel(container, label);

    const row = container.createDiv({ cls: "sonicnote-protocol-row" });

    if (options && onChange) {
      // 自定义模式：可切换的 dropdown
      const select = row.createEl("select", { cls: "sonicnote-field-input sonicnote-protocol-select" });
      for (const [k, v] of Object.entries(options)) {
        const opt = select.createEl("option", { text: v, attr: { value: k } });
        if (k === protocol) opt.selected = true;
      }
      select.addEventListener("change", () => {
        onChange(select.value as ASRProtocol);
      });
    } else {
      // 预设模式：只读文本
      row.createEl("span", { text: currentLabel, cls: "sonicnote-protocol-label" });
    }

    // 接口标准按钮（右对齐）
    const guideBtn = row.createEl("button", {
      text: `📋 ${getGuideLabel(protocol)}`,
      cls: "sonicnote-guide-btn-inline",
    });
    guideBtn.addEventListener("click", () => {
      new AsrGuideModal(this.app, protocol).open();
    });
  }

  // ---- 表单字段辅助 ----
  private fieldLabel(container: HTMLElement, text: string) {
    container.createEl("label", { text, cls: "sonicnote-field-label" });
  }

  private fieldText(container: HTMLElement, label: string, value: string, placeholder: string, isPassword = false): HTMLInputElement {
    this.fieldLabel(container, label);
    const input = container.createEl("input", {
      type: isPassword ? "password" : "text",
      placeholder,
      cls: "sonicnote-field-input",
    });
    input.value = value;
    return input;
  }

  private fieldDropdown(container: HTMLElement, label: string, options: Record<string, string>, value: string): HTMLSelectElement {
    this.fieldLabel(container, label);
    const select = container.createEl("select", { cls: "sonicnote-field-input" });
    for (const [k, v] of Object.entries(options)) {
      const opt = select.createEl("option", { text: v, attr: { value: k } });
      if (k === value) opt.selected = true;
    }
    return select;
  }

  private fieldWrap(container: HTMLElement) {
    return container.createDiv({ cls: "sonicnote-field-wrap" });
  }
}

// ---- ASR 模型列表渲染 ----
export function renderAsrModelList(
  container: HTMLElement,
  models: ASRModelEntry[],
  activeModelId: string,
  onSelect: (id: string) => void,
  onEdit: (model: ASRModelEntry) => void,
  onDelete: (id: string) => void,
  onAdd: () => void,
  showHeader = true,
) {
  if (showHeader) {
    container.createEl("h4", { text: "已配置的 ASR 模型" });
  }

  const listContainer = container.createDiv({ cls: "sonicnote-list-container" });

  const renderItems = () => {
    listContainer.empty();
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const row = listContainer.createDiv({ cls: "sonicnote-model-row" });

      const radio = row.createEl("input", { type: "radio", attr: { name: "active-asr-model" } });
      radio.checked = m.id === activeModelId;
      radio.addEventListener("change", () => onSelect(m.id));

      const info = row.createDiv({ cls: "sonicnote-model-info" });
      info.createEl("span", {
        text: m.displayName || presetLabel(m),
        cls: "sonicnote-model-name",
      });
      info.createEl("span", {
        text: protocolLabel(m),
        cls: "sonicnote-model-provider",
      });

      const actions = row.createDiv({ cls: "sonicnote-model-actions" });
      const editBtn = actions.createEl("button", {
        cls: "sonicnote-icon-btn",
        attr: { title: "配置" },
      });
      setIcon(editBtn, "settings");
      editBtn.addEventListener("click", () => onEdit(m));
      const delBtn = actions.createEl("button", {
        cls: "sonicnote-icon-btn sonicnote-icon-btn-danger",
        attr: { title: "删除" },
      });
      setIcon(delBtn, "trash-2");
      delBtn.addEventListener("click", () => onDelete(m.id));
    }
  };

  renderItems();

  const addBtn = container.createEl("button", { text: "+ 新增模型", cls: "sonicnote-add-btn" });
  addBtn.addEventListener("click", onAdd);
}
