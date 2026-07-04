// Sync-specific types
export interface CustomFrontmatterField {
  key: string;
  value: string;
}

export interface SonicNoteSyncSettings {
  serverUrl: string;
  syncFolder: string;
  pageSize: number;
  includeTranscript: boolean;
  autoSyncOnOpen: boolean;
  resyncIntervalMinutes: number;
  frontmatterFields: Record<string, boolean>;
  customFrontmatter: CustomFrontmatterField[];
  token: string;
  apiKey: string;
  lastSyncTime: string;
}

export const BUILTIN_FRONTMATTER_FIELDS: Record<string, string> = {
  audio_id: '录音 ID',
  record_name: '录音文件名',
  record_nick_name: '录音标题',
  duration: '时长',
  record_time: '录音时间',
  record_type: '录音类型',
  device_name: '设备名称',
  audio_url: '音频地址',
  tags: '标签',
  sync_time: '同步时间',
};

export const DEFAULT_SYNC_SETTINGS: SonicNoteSyncSettings = {
  serverUrl: 'https://ainote.easylinkin.com:18048/prod-api',
  syncFolder: 'SonicNoteSync',
  pageSize: 50,
  includeTranscript: true,
  autoSyncOnOpen: false,
  resyncIntervalMinutes: 0,
  frontmatterFields: {
    audio_id: true,
    record_name: true,
    record_nick_name: true,
    duration: true,
    record_time: true,
    record_type: true,
    device_name: true,
    audio_url: true,
    tags: true,
    sync_time: true,
  },
  customFrontmatter: [],
  token: '',
  apiKey: '',
  lastSyncTime: '',
};

// Backend data types (same as main plugin types)
export interface BackendResponse {
  code: number;
  msg: string;
  data: any;
}

export interface Recording {
  audioId: string;
  userId: string;
  deviceId: string;
  audioUrl: string;
  recordTime: string;
  recordName: string;
  recordNickName: string;
  duration: string;
  note: string;
  recordType: string;
  isTranscribed: string;
  isSummarized: string;
  transcriptStatus: number;
  summaryStatus: number;
  delFlag: string;
  deviceName: string;
  createTime: string;
  updateTime: string;
}

export interface TranscriptSegment {
  spokesperson: string;
  text: string;
  time: number;
}

export interface SummaryData {
  summaryId: string;
  audioId: string;
  summaryContent: string;
  templateId: string;
  status: number;
}

export interface StudyReportData {
  id: number;
  audioId: string;
  knowledgePanorama: string;
  coreGains: string;
  consolidation: string;
  status: number;
}

export interface LocalFileInfo {
  path: string;
  syncTime: string;
}

export interface SyncResult {
  total: number;
  synced: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
}
