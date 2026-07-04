import { App, Modal, setIcon } from "obsidian";
import type { LLMModelEntry, LLMProviderType, ApiFormat } from "../types";

// ---- 服务商默认配置 ----
export const PROVIDER_DEFAULTS: Record<string, { url: string; model: string }> = {
  anthropic: { url: "https://api.anthropic.com/v1/messages", model: "claude-fable-5" },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-5.5-turbo" },
  zhipu: { url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-5.2" },
  deepseek: { url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-v4-pro" },
  minimax: { url: "https://api.minimaxi.com/v1/text/chatcompletion_v2", model: "minimax-text-01" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.1-pro" },
  aliyun: { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen3.5-122b" },
  baidu: { url: "https://qianfan.baidubce.com/v2/chat/completions", model: "ernie-4.0" },
  bytedance: { url: "https://api.doubao.com/v1/chat/completions", model: "doubao-pro-32k" },
  tencent: { url: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions", model: "hunyuan-4.0" },
  huawei: { url: "https://pangu.huaweicloud.com/v1/chat/completions", model: "pangu-4.0" },
  moonshot: { url: "https://api.moonshot.cn/v1/chat/completions", model: "kimi-k2.7-code" },
  xunfei: { url: "https://spark-api.xfyun.cn/v3.5/chat/completions", model: "spark-4.0" },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", model: "mistral-large-2" },
  meta: { url: "https://api.openrouter.ai/v1/chat/completions", model: "meta-llama/llama-3.1-70b-instruct" },
  custom: { url: "", model: "" },
};

export const PROVIDER_LABELS: Record<LLMProviderType, string> = {
  anthropic: "Anthropic Claude",
  openai: "OpenAI (GPT-4o)",
  zhipu: "智谱 (GLM)",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  google: "Google Gemini",
  aliyun: "阿里云 (通义千问)",
  baidu: "百度 (文心一言)",
  bytedance: "字节跳动 (豆包)",
  tencent: "腾讯 (混元)",
  huawei: "华为 (盘古)",
  moonshot: "月之暗面 (Kimi)",
  xunfei: "讯飞 (星火)",
  mistral: "Mistral AI",
  meta: "Meta (Llama)",
  custom: "自定义 LLM",
};

export const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5", "claude-sonnet-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1"],
  zhipu: ["glm-4-plus", "glm-4.5", "glm-4-flash", "glm-4-air", "glm-4-airx", "glm-4-long", "glm-4", "glm-5.1", "glm-5.2"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3", "deepseek-r1", "deepseek-chat", "deepseek-reasoner"],
  minimax: ["minimax-text-01", "minimax-m1"],
  google: ["gemini-3.1-pro", "gemini-3.1-flash", "gemini-2.5-pro", "gemini-2.5-flash"],
  aliyun: ["qwen3.5-122b", "qwen3.5-32b", "qwen3.5-14b", "qwen3-plus", "qwen3-turbo", "qwen-plus", "qwen-turbo"],
  baidu: ["ernie-4.0", "ernie-4.0-turbo", "ernie-3.5", "ernie-speed", "ernie-lite"],
  bytedance: ["doubao-pro-32k", "doubao-pro-128k", "doubao-lite-32k", "doubao-lite-128k"],
  tencent: ["hunyuan-4.0", "hunyuan-turbo", "hunyuan-lite", "hunyuan-standard"],
  huawei: ["pangu-4.0", "pangu-3.0"],
  moonshot: ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  xunfei: ["spark-4.0", "spark-3.5", "spark-lite", "spark-pro"],
  mistral: ["mistral-large-2", "mistral-medium", "mistral-small", "mistral-nemo"],
  meta: ["meta-llama/llama-3.1-405b-instruct", "meta-llama/llama-3.1-70b-instruct", "meta-llama/llama-3.1-8b-instruct"],
  custom: [],
};

// ---- 添加模型弹窗 ----
export class AddModelModal extends Modal {
  private plugin: { settings: { llmModels: LLMModelEntry[]; activeModelId: string }; saveSettings: () => Promise<void> };
  private onSave: () => void;
  private editingModel: LLMModelEntry | null;
  private mode: "provider" | "custom" = "provider";

  // 表单字段
  private provider: LLMProviderType = "anthropic";
  private apiFormat: ApiFormat = "openai";
  private apiKey = "";
  private apiUrl = "";
  private model = "";
  private displayName = "";
  private contextWindow = "";
  private maxTokens = "";
  private temperature = "";
  private showAdvanced = false;

  constructor(
    app: App,
    plugin: { settings: { llmModels: LLMModelEntry[]; activeModelId: string }; saveSettings: () => Promise<void> },
    onSave: () => void,
    editing?: LLMModelEntry,
  ) {
    super(app);
    this.plugin = plugin;
    this.onSave = onSave;
    this.editingModel = editing || null;
    if (editing) {
      this.mode = editing.provider === "custom" ? "custom" : "provider";
      this.provider = editing.provider;
      this.apiFormat = editing.apiFormat || "openai";
      this.apiKey = editing.apiKey;
      this.apiUrl = editing.apiUrl;
      this.model = editing.model;
      this.displayName = editing.displayName || "";
      this.contextWindow = editing.contextWindow?.toString() || "";
      this.maxTokens = editing.maxTokens?.toString() || "";
      this.temperature = editing.temperature?.toString() || "";
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-config-modal");
    contentEl.createEl("h3", { text: this.editingModel ? "编辑模型" : "新增模型" });

    // 模式切换: 服务商 / 自定义 (并列按钮)
    const modeToggle = contentEl.createDiv({ cls: "sonicnote-mode-toggle" });
    const providerBtn = modeToggle.createEl("button", {
      text: "模型服务商",
      cls: `sonicnote-mode-btn ${this.mode === "provider" ? "sonicnote-mode-active" : ""}`,
    });
    providerBtn.addEventListener("click", () => {
      this.mode = "provider";
      this.onOpen();
    });
    const customBtn = modeToggle.createEl("button", {
      text: "自定义配置",
      cls: `sonicnote-mode-btn ${this.mode === "custom" ? "sonicnote-mode-active" : ""}`,
    });
    customBtn.addEventListener("click", () => {
      this.mode = "custom";
      this.onOpen();
    });

    if (this.mode === "provider") {
      this.renderProviderMode(contentEl);
    } else {
      this.renderCustomMode(contentEl);
    }

    // 保存按钮
    const btnRow = contentEl.createDiv({ cls: "sonicnote-button-row" });
    const cancelBtn = btnRow.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.close());
    const saveBtn = btnRow.createEl("button", { text: "保存", cls: "sonicnote-btn-primary" });
    saveBtn.addEventListener("click", async () => {
      const dflt = PROVIDER_DEFAULTS[this.provider];
      const entry: LLMModelEntry = {
        id: this.editingModel?.id || `llm_${Date.now()}`,
        provider: this.mode === "custom" ? "custom" : this.provider,
        apiFormat: this.mode === "custom" ? this.apiFormat : undefined,
        apiKey: this.apiKey,
        apiUrl: this.apiUrl || dflt?.url || "",
        model: this.model || dflt?.model || "",
        displayName: this.displayName || undefined,
        contextWindow: this.contextWindow ? parseInt(this.contextWindow) : undefined,
        maxTokens: this.maxTokens ? parseInt(this.maxTokens) : undefined,
        temperature: this.temperature ? parseFloat(this.temperature) : undefined,
      };
      if (!entry.apiKey) { return; }

      const models = this.plugin.settings.llmModels;
      if (this.editingModel) {
        const idx = models.findIndex((m) => m.id === this.editingModel!.id);
        if (idx >= 0) models[idx] = entry;
      } else {
        models.push(entry);
        if (models.length === 1) {
          this.plugin.settings.activeModelId = entry.id;
        }
      }
      await this.plugin.saveSettings();
      this.onSave();
      this.close();
    });
  }

  // ---- 表单字段辅助: label 在上, 输入框/下拉框全宽 ----
  private fieldLabel(container: HTMLElement, text: string) {
    const label = container.createEl("label", { text, cls: "sonicnote-field-label" });
    return label;
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

  // ---- 渲染: 模型服务商模式 ----
  private renderProviderMode(container: HTMLElement) {
    const wrap = this.fieldWrap(container);

    // 服务商
    const providerOptions: Record<string, string> = {};
    for (const [k, v] of Object.entries(PROVIDER_LABELS)) {
      if (k !== "custom") providerOptions[k] = v;
    }
    const providerSelect = this.fieldDropdown(wrap, "服务商", providerOptions,
      this.provider === "custom" ? "anthropic" : this.provider);
    providerSelect.addEventListener("change", () => {
      const v = providerSelect.value as LLMProviderType;
      this.provider = v;
      const dflt = PROVIDER_DEFAULTS[v];
      if (dflt?.url) this.apiUrl = dflt.url;
      if (dflt?.model) this.model = dflt.model;
      this.onOpen();
    });

    // 模型
    const models = PROVIDER_MODELS[this.provider] || [];
    if (models.length > 0) {
      const modelOpts: Record<string, string> = {};
      for (const m of models) modelOpts[m] = m;
      const modelSelect = this.fieldDropdown(wrap, "模型", modelOpts, this.model || models[0]);
      modelSelect.addEventListener("change", () => { this.model = modelSelect.value; });
    } else {
      const modelInput = this.fieldText(wrap, "模型 ID", this.model, "输入模型 ID");
      modelInput.addEventListener("change", () => { this.model = modelInput.value; });
    }

    // API Key
    const keyInput = this.fieldText(wrap, "API Key", this.apiKey, "sk-...", true);
    keyInput.addEventListener("change", () => { this.apiKey = keyInput.value; });

    // API URL
    const urlInput = this.fieldText(wrap, "API URL", this.apiUrl, "https://api.openai.com/v1/chat/completions");
    urlInput.addEventListener("change", () => { this.apiUrl = urlInput.value; });

    this.renderAdvanced(wrap);
  }

  // ---- 渲染: 自定义配置模式 ----
  private renderCustomMode(container: HTMLElement) {
    const wrap = this.fieldWrap(container);

    // API 格式
    const formatOpts: Record<string, string> = {
      "openai": "OpenAI Chat Completions",
      "anthropic": "Anthropic Messages",
    };
    const formatSelect = this.fieldDropdown(wrap, "API 格式", formatOpts, this.apiFormat);
    formatSelect.addEventListener("change", () => { this.apiFormat = formatSelect.value as ApiFormat; });

    // 请求地址
    const urlInput = this.fieldText(wrap, "请求地址", this.apiUrl, "https://your-api.com/v1/chat/completions");
    urlInput.addEventListener("change", () => { this.apiUrl = urlInput.value; });

    // 模型 ID
    const modelInput = this.fieldText(wrap, "模型 ID", this.model, "your-model-id");
    modelInput.addEventListener("change", () => { this.model = modelInput.value; });

    // API 密钥
    const keyInput = this.fieldText(wrap, "API 密钥", this.apiKey, "sk-...", true);
    keyInput.addEventListener("change", () => { this.apiKey = keyInput.value; });

    this.renderAdvanced(wrap);
  }

  private renderAdvanced(container: HTMLElement) {
    const toggleRow = container.createDiv({ cls: "sonicnote-config-advanced-toggle" });
    const toggleBtn = toggleRow.createEl("button", {
      text: `${this.showAdvanced ? "▾" : "▸"} 高级配置`,
      cls: "sonicnote-add-btn",
    });
    toggleBtn.addEventListener("click", () => {
      this.showAdvanced = !this.showAdvanced;
      this.onOpen();
    });

    if (this.showAdvanced) {
      const advContainer = container.createDiv({ cls: "sonicnote-advanced-section" });

      const nameInput = this.fieldText(advContainer, "展示名称", this.displayName, "如：Claude 4.6 快速模式");
      nameInput.addEventListener("change", () => { this.displayName = nameInput.value; });

      const ctxInput = this.fieldText(advContainer, "上下文窗口", this.contextWindow, "如：200000");
      ctxInput.addEventListener("change", () => { this.contextWindow = ctxInput.value; });

      const tokInput = this.fieldText(advContainer, "最大输出 Token", this.maxTokens, "如：4096");
      tokInput.addEventListener("change", () => { this.maxTokens = tokInput.value; });

      const tempInput = this.fieldText(advContainer, "温度 (Temperature)", this.temperature, "默认 0.7，Kimi 模型请设为 1");
      tempInput.addEventListener("change", () => { this.temperature = tempInput.value; });
    }
  }
}

// ---- 模型列表渲染 (供 settings 和 view 共用) ----
export function renderModelList(
  container: HTMLElement,
  models: LLMModelEntry[],
  activeModelId: string,
  onSelect: (id: string) => void,
  onEdit: (model: LLMModelEntry) => void,
  onDelete: (id: string) => void,
  onAdd: () => void,
  showHeader = true,
) {
  if (showHeader) {
    container.createEl("h4", { text: "已配置的模型" });
  }

  const listContainer = container.createDiv({ cls: "sonicnote-list-container" });

  const renderItems = () => {
    listContainer.empty();
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const row = listContainer.createDiv({ cls: "sonicnote-model-row" });

      // 单选按钮
      const radio = row.createEl("input", { type: "radio", attr: { name: "active-model" } });
      radio.checked = m.id === activeModelId;
      radio.addEventListener("change", () => onSelect(m.id));

      // 模型信息
      const info = row.createDiv({ cls: "sonicnote-model-info" });
      info.createEl("span", {
        text: m.displayName || m.model,
        cls: "sonicnote-model-name",
      });
      info.createEl("span", {
        text: ` ${m.provider === "custom" ? "自定义" : PROVIDER_LABELS[m.provider] || m.provider}`,
        cls: "sonicnote-model-provider",
      });

      // 操作按钮
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

  // 新增模型按钮
  const addBtn = container.createEl("button", { text: "+ 新增模型", cls: "sonicnote-add-btn" });
  addBtn.addEventListener("click", onAdd);
}
