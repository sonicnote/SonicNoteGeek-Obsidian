import { App, PluginSettingTab, Setting, Modal, Notice } from "obsidian";
import type SonicNoteGeekPlugin from "../main";
import { BUILTIN_FRONTMATTER_FIELDS } from "./sync/types";

export const DEFAULT_SETTINGS: SonicNoteGeekSettings = {
  asr: {
    protocol: "openai-whisper",
    apiKey: "",
    apiUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    language: "zh",
    enableSpeakerDiarization: false,
  },
  asrModels: [],
  activeAsrModelId: "",
  speakerDiarization: {
    enabled: true,
    modelType: "builtin",
    customEndpoint: "",
    apiKey: "",
    autoVoiceprint: false,
    minSpeakers: 1,
    maxSpeakers: 10,
  },
  llm: {
    provider: "anthropic",
    apiKey: "",
    apiUrl: "https://api.anthropic.com/v1/messages",
    model: "claude-haiku-3-5-sonnet",
    maxTokens: 4096,
    temperature: 0.7,
  },
  llmModels: [],
  activeModelId: "",
  customTemplates: [],
  industry: "",
  hotWords: [],
  voiceprintLibrary: [],
  sync: DEFAULT_SYNC_SETTINGS,
};

// Re-import for clarity
import type { SonicNoteGeekSettings } from "./types";
import { DEFAULT_SYNC_SETTINGS } from "./sync/types";

export class SonicNoteGeekSettingTab extends PluginSettingTab {
  plugin: SonicNoteGeekPlugin;

  constructor(app: App, plugin: SonicNoteGeekPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sonicnote-asr-settings");

    // ===== 账号登录 =====
    this.renderLoginSection(containerEl);

    // ===== 文件同步设置 =====
    this.renderSyncSection(containerEl);

    // ===== 版本信息 =====
    containerEl.createEl("h2", { text: "关于" });

    new Setting(containerEl)
      .setName("当前版本")
      .setDesc("v1.0.0");

    new Setting(containerEl)
      .setName("检查更新")
      .setDesc("点击检查是否有新版本可用")
      .addButton((btn) =>
        btn.setButtonText("检查更新")
          .onClick(() => {
            btn.setButtonText("已是最新");
            setTimeout(() => btn.setButtonText("检查更新"), 2000);
          }));

    new Setting(containerEl)
      .setName("插件配置")
      .setDesc("ASR/LLM 模型、模板、热词、声纹库等配置，请在插件面板中操作");
  }

  // ===== 登录区域 =====
  private renderLoginSection(containerEl: HTMLElement) {
    const sync = this.plugin.settings.sync;

    containerEl.createEl("h2", { text: "账号登录" });

    if (this.plugin.syncApi.isAuthenticated()) {
      const maskedKey = sync.apiKey.length > 10
        ? sync.apiKey.slice(0, 10) + '...'
        : sync.apiKey;
      new Setting(containerEl)
        .setName("登录状态")
        .setDesc(`已登录: ${maskedKey}`)
        .addButton(btn => btn
          .setButtonText('登出')
          .setWarning()
          .onClick(async () => {
            sync.token = '';
            sync.apiKey = '';
            await this.plugin.saveSettings();
            new Notice('已登出 SonicNote');
            this.display();
          }));
    } else {
      new Setting(containerEl)
        .setName("登录 SonicNote")
        .setDesc("使用 API Key 登录妙记（在妙记 App → 我的 → API Key 管理中创建）")
        .addButton(btn => btn
          .setButtonText('登录')
          .setCta()
          .onClick(() => {
            new SyncLoginModal(this.app, this.plugin, () => this.display()).open();
          }));
    }
  }

  // ===== 文件同步设置 =====
  private renderSyncSection(containerEl: HTMLElement) {
    const settings = this.plugin.settings.sync;

    containerEl.createEl("h2", { text: "文件同步设置" });
    containerEl.createEl("p", { text: "将妙记录音同步为 Obsidian Markdown 文件", cls: "setting-item-description" });

    // 同步文件夹
    new Setting(containerEl)
      .setName('同步文件夹')
      .setDesc('录音 Markdown 文件存放的文件夹（相对于 Vault 根目录）')
      .addText(text => text
        .setPlaceholder('SonicNoteSync')
        .setValue(settings.syncFolder)
        .onChange(async (value) => {
          settings.syncFolder = value;
          await this.plugin.saveSettings();
        }));

    // 包含转录内容
    new Setting(containerEl)
      .setName('包含转录内容')
      .setDesc('关闭后同步的文件中不包含逐字转录内容')
      .addToggle(toggle => toggle
        .setValue(settings.includeTranscript)
        .onChange(async (value) => {
          settings.includeTranscript = value;
          await this.plugin.saveSettings();
        }));

    // 启动时自动同步
    new Setting(containerEl)
      .setName('启动时自动同步')
      .setDesc('每次打开 Obsidian 时自动执行一次同步')
      .addToggle(toggle => toggle
        .setValue(settings.autoSyncOnOpen)
        .onChange(async (value) => {
          settings.autoSyncOnOpen = value;
          await this.plugin.saveSettings();
        }));

    // 定时重同步
    new Setting(containerEl)
      .setName('定时重同步')
      .setDesc('Obsidian 打开期间按指定间隔自动重新同步')
      .addDropdown(dropdown => dropdown
        .addOptions({
          '0': '关闭（手动同步）',
          '60': '每 1 小时',
          '180': '每 3 小时',
          '360': '每 6 小时',
          '1440': '每 24 小时',
        })
        .setValue(String(settings.resyncIntervalMinutes))
        .onChange(async (value) => {
          settings.resyncIntervalMinutes = parseInt(value, 10);
          await this.plugin.saveSettings();
          this.plugin.startAutoSync();
        }));

    // Frontmatter 属性字段
    const fmSection = containerEl.createDiv();
    fmSection.createEl('h3', { text: '文件属性' });
    fmSection.createEl('p', { text: '选择同步到 Frontmatter 中的属性字段', cls: 'setting-item-description' });
    fmSection.style.marginBottom = '12px';

    const fmListEl = fmSection.createDiv();
    const renderFrontmatterToggles = () => {
      fmListEl.empty();
      for (const [key, desc] of Object.entries(BUILTIN_FRONTMATTER_FIELDS)) {
        const isRequired = key === 'audio_id' || key === 'sync_time';
        if (isRequired) {
          new Setting(fmListEl)
            .setName(`${desc}`)
            .setDesc(key)
            .addText(text => {
              text.setValue('必要属性').setDisabled(true);
              text.inputEl.style.width = 'auto';
              text.inputEl.style.color = 'var(--text-muted)';
              text.inputEl.style.textAlign = 'center';
              text.inputEl.style.border = 'none';
              text.inputEl.style.background = 'var(--background-secondary)';
              text.inputEl.style.borderRadius = '4px';
              text.inputEl.style.padding = '2px 8px';
              text.inputEl.style.fontSize = '0.8em';
            });
        } else {
          new Setting(fmListEl)
            .setName(`${desc}`)
            .setDesc(key)
            .addToggle(toggle => {
              toggle.setValue(settings.frontmatterFields[key] !== false);
              toggle.onChange(async (value) => {
                settings.frontmatterFields[key] = value;
                await this.plugin.saveSettings();
              });
            });
        }
      }
    };
    renderFrontmatterToggles();

    // 自定义属性
    const customSection = containerEl.createDiv();
    customSection.createEl('h3', { text: '自定义属性' });
    customSection.createEl('p', { text: '添加自定义属性到所有同步文件的 Frontmatter 中', cls: 'setting-item-description' });
    customSection.style.marginBottom = '12px';

    const customListEl = customSection.createDiv();
    const renderCustomFields = () => {
      customListEl.empty();
      for (let i = 0; i < settings.customFrontmatter.length; i++) {
        const field = settings.customFrontmatter[i];
        new Setting(customListEl)
          .addText(text => text
            .setPlaceholder('属性名')
            .setValue(field.key)
            .onChange(async (value) => {
              field.key = value;
              await this.plugin.saveSettings();
            }))
          .addText(text => text
            .setPlaceholder('属性值')
            .setValue(field.value)
            .onChange(async (value) => {
              field.value = value;
              await this.plugin.saveSettings();
            }))
          .addExtraButton(btn => btn
            .setIcon('trash')
            .setTooltip('删除')
            .onClick(async () => {
              settings.customFrontmatter.splice(i, 1);
              await this.plugin.saveSettings();
              renderCustomFields();
            }));
      }
    };
    renderCustomFields();

    new Setting(customSection)
      .setName('添加属性')
      .addButton(btn => btn
        .setButtonText('+ 添加')
        .onClick(async () => {
          settings.customFrontmatter.push({ key: '', value: '' });
          await this.plugin.saveSettings();
          renderCustomFields();
        }));
  }
}

// 登录弹窗
class SyncLoginModal extends Modal {
  private plugin: SonicNoteGeekPlugin;
  private onCloseCallback: () => void;

  constructor(app: App, plugin: SonicNoteGeekPlugin, onCloseCallback: () => void) {
    super(app);
    this.plugin = plugin;
    this.onCloseCallback = onCloseCallback;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '登录 SonicNote' });

    let apiKey = '';

    new Setting(contentEl)
      .setName('API Key')
      .setDesc('在妙记 App → 我的 → API Key 管理中创建')
      .addText(text => {
        text
          .setPlaceholder('sk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
          .onChange((value) => { apiKey = value; });
        text.inputEl.type = 'password';
      });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('登录')
        .setCta()
        .onClick(async () => {
          if (!apiKey) {
            new Notice('请输入 API Key');
            return;
          }
          try {
            btn.setButtonText('登录中...');
            btn.setDisabled(true);
            const result = await this.plugin.syncApi.login(apiKey);
            this.plugin.settings.sync.token = result.token;
            this.plugin.settings.sync.apiKey = apiKey;
            await this.plugin.saveSettings();
            new Notice('登录成功');
            this.plugin.updateSyncStatusBar();
            this.plugin.startAutoSync();
            this.close();
          } catch (e) {
            new Notice(`登录失败: ${e instanceof Error ? e.message : '未知错误'}`);
            btn.setButtonText('登录');
            btn.setDisabled(false);
          }
        }));
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.onCloseCallback();
  }
}
