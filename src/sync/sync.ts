import { App, Notice, TFile, TFolder } from 'obsidian';
import { SonicNoteApiClient } from './api';
import { SonicNoteSyncSettings, LocalFileInfo, Recording, SyncResult, SummaryData, StudyReportData } from './types';
import { formatFileName, sanitizeFileName, toMarkdown } from './formatter';
import type { TranscriptSegment } from './types';

export class SyncService {
  private api: SonicNoteApiClient;
  private app: App;
  private getSettings: () => SonicNoteSyncSettings;
  private saveSettings: () => Promise<void>;

  constructor(
    app: App,
    api: SonicNoteApiClient,
    getSettings: () => SonicNoteSyncSettings,
    saveSettings: () => Promise<void>
  ) {
    this.app = app;
    this.api = api;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
  }

  async syncAll(onProgress?: (msg: string) => void): Promise<SyncResult> {
    const settings = this.getSettings();
    const result: SyncResult = { total: 0, synced: 0, skipped: 0, errors: 0, errorMessages: [] };

    // 1. Ensure sync folder exists
    await this.ensureFolder(settings.syncFolder);

    // 2. Build local index
    onProgress?.('正在读取本地索引...');
    const localIndex = await this.buildLocalIndex(settings.syncFolder);

    // 3. Fetch all recordings from backend
    onProgress?.('正在从服务器拉取录音列表...');
    let page = 1;
    let allRecordings: Recording[] = [];

    while (true) {
      try {
        const res = await this.api.fetchRecordingList(page, settings.pageSize);
        allRecordings = allRecordings.concat(res.list);
        if (allRecordings.length >= res.total || res.list.length === 0) break;
        page++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : '获取录音列表失败';
        result.errorMessages.push(msg);
        console.error('[SonicNote] 获取录音列表失败:', e);
        new Notice(`同步失败: ${msg}`);
        return result;
      }
    }

    // Filter out deleted
    allRecordings = allRecordings.filter(r => r.delFlag !== '2');
    result.total = allRecordings.length;

    // 4. Process each recording
    for (let i = 0; i < allRecordings.length; i++) {
      const recording = allRecordings[i];
      onProgress?.(`正在同步 ${i + 1}/${result.total}: ${recording.recordNickName || recording.recordName}`);

      try {
        await this.processRecording(recording, localIndex, settings);
        result.synced++;
      } catch (e) {
        result.errors++;
        const msg = e instanceof Error ? e.message : '未知错误';
        const name = recording.recordNickName || recording.recordName;
        result.errorMessages.push(`${name}: ${msg}`);
        console.error(`[SonicNote] 同步失败 — ${name} (${recording.audioId}):`, e);
      }
    }

    // 5. Update last sync time
    const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    settings.lastSyncTime = now;
    await this.saveSettings();

    return result;
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  async buildLocalIndex(syncFolder: string): Promise<Map<string, LocalFileInfo>> {
    const index = new Map<string, LocalFileInfo>();
    const folder = this.app.vault.getAbstractFileByPath(syncFolder);
    if (!(folder instanceof TFolder)) return index;

    for (const file of folder.children) {
      if (!(file instanceof TFile) || file.extension !== 'md') continue;

      try {
        const content = await this.app.vault.read(file);
        const audioId = this.extractFrontmatterField(content, 'audio_id');
        const syncTime = this.extractFrontmatterField(content, 'sync_time');
        if (audioId) {
          index.set(audioId.replace(/"/g, ''), { path: file.path, syncTime: syncTime || '' });
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return index;
  }

  private extractFrontmatterField(content: string, field: string): string | null {
    const match = content.match(new RegExp(`^${field}:\\s*"?([^"]*)"\\s*$`, 'm'));
    return match ? match[1] : null;
  }

  private async processRecording(recording: Recording, localIndex: Map<string, LocalFileInfo>, settings: SonicNoteSyncSettings): Promise<void> {
    const syncTime = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

    const local = localIndex.get(recording.audioId);

    // Already synced — check if file still has original name but server has a summarized title
    if (local && local.path) {
      const hasNewTitle = recording.recordNickName && recording.recordNickName !== recording.recordName;
      const localBaseName = local.path.split('/').pop()?.replace(/\.md$/, '') || '';
      const originalName = sanitizeFileName(recording.recordName || '');

      if (hasNewTitle && localBaseName === originalName) {
        // Overwrite content and rename to new title
        const content = await this.buildRecordingContent(recording, syncTime);
        const newFileName = formatFileName(recording);
        const newFilePath = `${settings.syncFolder}/${newFileName}.md`;
        const oldFile = this.app.vault.getAbstractFileByPath(local.path);
        if (oldFile instanceof TFile) {
          await this.app.vault.modify(oldFile, content);
          await this.app.vault.rename(oldFile, newFilePath);
          localIndex.set(recording.audioId, { path: newFilePath, syncTime });
        }
      }
      return;
    }

    // New recording — create file
    const content = await this.buildRecordingContent(recording, syncTime);
    const fileName = formatFileName(recording);
    const filePath = `${settings.syncFolder}/${fileName}.md`;
    await this.app.vault.create(filePath, content);
    localIndex.set(recording.audioId, { path: filePath, syncTime });
  }

  private async buildRecordingContent(recording: Recording, syncTime: string): Promise<string> {
    const settings = this.getSettings();
    const tasks: [string, Promise<TranscriptSegment[] | SummaryData | StudyReportData | string | null>][] = [];

    // Fetch transcript if enabled and available (status 2 = completed)
    let transcript: TranscriptSegment[] | null = null;
    if (settings.includeTranscript && recording.transcriptStatus === 2) {
      tasks.push(['transcript', this.api.fetchTranscriptResult(recording.audioId).catch(() => null)]);
    }

    // Fetch summary if available (status 2 = completed)
    let summary: SummaryData | null = null;
    if (recording.summaryStatus === 2) {
      tasks.push(['summary', this.api.fetchSummary(recording.audioId).catch(() => null)]);
    }

    // Fetch study report
    let studyReport: StudyReportData | null = null;
    tasks.push(['studyReport', this.api.fetchStudyReport(recording.audioId).catch(() => null)]);

    // Fetch note
    let note = '';
    tasks.push(['note', this.api.fetchNote(recording.audioId).catch(() => '')]);

    // Execute all requests in parallel
    const results = await Promise.all(tasks.map(([_, p]) => p));
    tasks.forEach(([name], i) => {
      const val = results[i];
      if (name === 'transcript') transcript = val as TranscriptSegment[] | null;
      if (name === 'summary') summary = val as SummaryData | null;
      if (name === 'studyReport') studyReport = val as StudyReportData | null;
      if (name === 'note') note = (val as string) || '';
    });

    return toMarkdown(recording, transcript, summary, studyReport, note, syncTime, settings);
  }
}
