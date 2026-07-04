import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { SonicNoteApiClient } from './api';
import { SonicNoteSyncSettings, DEFAULT_SYNC_SETTINGS, BUILTIN_FRONTMATTER_FIELDS, CustomFrontmatterField } from './types';

export class SyncSettingTab extends PluginSettingTab {
  private api: SonicNoteApiClient;
  private getSettings: () => SonicNoteSyncSettings;
  private save: () => Promise<void>;
  private onDisplay: () => void;

  constructor(
    app: App,
    plugin: Plugin,
    api: SonicNoteApiClient,
    getSettings: () => SonicNoteSyncSettings,
    save: () => Promise<void>
  ) {
    super(app, plugin);
    this.api = api;
    this.getSettings = getSettings;
    this.save = save;
    this.onDisplay = () => {};
  }

  setOnDisplay(cb: () => void) {
    this.onDisplay = cb;
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.getSettings();
    containerEl.empty();

    containerEl.createEl('h2', { text: '文件同步 - SonicNote Sync' });
    containerEl.createEl('p', { text: '将妙记录音同步为 Obsidian Markdown 文件', cls: 'setting-item-description' });

    // Sync folder
    new Setting(containerEl)
      .setName('同步文件夹')
      .setDesc('录音 Markdown 文件存放的文件夹（相对于 Vault 根目录）')
      .addText(text => text
        .setPlaceholder('SonicNoteSync')
        .setValue(settings.syncFolder)
        .onChange(async (value) => {
          settings.syncFolder = value;
          await this.save();
        }));

    // Include transcript
    new Setting(containerEl)
      .setName('包含转录内容')
      .setDesc('关闭后同步的文件中不包含逐字转录内容')
      .addToggle(toggle => toggle
        .setValue(settings.includeTranscript)
        .onChange(async (value) => {
          settings.includeTranscript = value;
          await this.save();
        }));

    // Auto sync on open
    new Setting(containerEl)
      .setName('启动时自动同步')
      .setDesc('每次打开 Obsidian 时自动执行一次同步')
      .addToggle(toggle => toggle
        .setValue(settings.autoSyncOnOpen)
        .onChange(async (value) => {
          settings.autoSyncOnOpen = value;
          await this.save();
        }));

    // Resync interval
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
          await this.save();
          // Notify plugin to restart auto sync
          this.onDisplay();
        }));

    // Frontmatter fields toggles
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
                await this.save();
              });
            });
        }
      }
    };
    renderFrontmatterToggles();

    // Custom frontmatter fields
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
              await this.save();
            }))
          .addText(text => text
            .setPlaceholder('属性值')
            .setValue(field.value)
            .onChange(async (value) => {
              field.value = value;
              await this.save();
            }))
          .addExtraButton(btn => btn
            .setIcon('trash')
            .setTooltip('删除')
            .onClick(async () => {
              settings.customFrontmatter.splice(i, 1);
              await this.save();
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
          await this.save();
          renderCustomFields();
        }));

    // Login status & actions
    const loginSection = containerEl.createDiv();
    loginSection.createEl('h3', { text: '账号' });

    if (this.api.isAuthenticated()) {
      const maskedKey = settings.apiKey.length > 10
        ? settings.apiKey.slice(0, 10) + '...'
        : settings.apiKey;
      new Setting(loginSection)
        .setName('登录状态')
        .setDesc(`已登录: ${maskedKey}`)
        .addButton(btn => btn
          .setButtonText('登出')
          .setWarning()
          .onClick(async () => {
            settings.token = '';
            settings.apiKey = '';
            await this.save();
            new Notice('已登出');
            this.display();
          }));
    } else {
      new Setting(loginSection)
        .setName('登录')
        .setDesc('使用 API Key 登录 SonicNote')
        .addButton(btn => btn
          .setButtonText('登录')
          .onClick(() => {
            new LoginModal(this.app, this.api, this.getSettings, this.save, () => this.display()).open();
          }));
    }
  }
}

class LoginModal extends Modal {
  private api: SonicNoteApiClient;
  private getSettings: () => SonicNoteSyncSettings;
  private saveSettings: () => Promise<void>;
  private onCloseCallback: () => void;

  constructor(
    app: App,
    api: SonicNoteApiClient,
    getSettings: () => SonicNoteSyncSettings,
    saveSettings: () => Promise<void>,
    onCloseCallback: () => void
  ) {
    super(app);
    this.api = api;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
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
            const result = await this.api.login(apiKey);
            const settings = this.getSettings();
            settings.token = result.token;
            settings.apiKey = apiKey;
            await this.saveSettings();
            new Notice('登录成功');
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
