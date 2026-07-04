// ========== ASR 协议（决定代码调用路径） ==========
export type ASRProtocol = "openai-whisper" | "volcengine" | "aliyun-dashscope" | "xunfei" | "tencent" | "baidu" | "huawei" | "local-openai";

// ========== ASR 预设服务商 ==========
export type ASRProviderPreset =
  | "openai" | "volcengine" | "aliyun" | "xunfei" | "tencent" | "baidu" | "huawei"
  | "local-openai" | "custom";

// ========== ASR 运行时配置（从模型条目派生） ==========
export interface ASRConfig {
  protocol: ASRProtocol;
  apiKey?: string;
  secretKey?: string;         // volcengine / xunfei
  apiUrl?: string;
  resourceId?: string;        // 仅 volcengine
  appId?: string;             // 仅 xunfei
  model?: string;
  localEndpoint?: string;     // 仅 local-*
  language: string;
  enableSpeakerDiarization: boolean;
}

// ========== ASR 模型列表配置 ==========
export interface ASRModelEntry {
  id: string;
  preset: ASRProviderPreset;
  protocol: ASRProtocol;
  displayName?: string;
  apiKey?: string;
  secretKey?: string;             // volcengine / xunfei
  apiUrl?: string;
  resourceId?: string;            // 仅 volcengine
  appId?: string;                 // 仅 xunfei
  model?: string;
  localEndpoint?: string;         // 仅 local-*
  language: string;
  enableSpeakerDiarization: boolean;
}

// ========== 说话人识别 / 声纹配置 ==========
export type SpeakerModelType = "none" | "builtin" | "custom";

export interface SpeakerDiarizationConfig {
  enabled: boolean;
  modelType: SpeakerModelType;
  customEndpoint?: string;
  apiKey?: string;
  autoVoiceprint: boolean;
  minSpeakers: number;
  maxSpeakers: number;
}

// ========== 声纹库 ==========
export interface VoiceprintEntry {
  id: string;
  name: string;                    // 说话人姓名
  audioSamplePath?: string;       // 声纹样本音频路径
  description?: string;
}

// ========== LLM 配置 ==========
export type LLMProviderType = "anthropic" | "openai" | "zhipu" | "deepseek" | "minimax" | "google" | "aliyun" | "baidu" | "bytedance" | "tencent" | "huawei" | "moonshot" | "xunfei" | "mistral" | "meta" | "custom";

export interface LLMConfig {
  provider: LLMProviderType;
  apiFormat?: ApiFormat;           // 仅 custom provider 使用
  apiKey: string;
  apiUrl: string;                  // API endpoint
  model: string;                   // 模型名
  maxTokens: number;
  temperature: number;
  // 高级选项
  systemPrompt?: string;
}

// ========== LLM 模型列表配置 ==========
export type ApiFormat = "openai" | "anthropic";

export interface LLMModelEntry {
  id: string;
  provider: LLMProviderType;
  // 自定义配置
  apiFormat?: ApiFormat;           // 仅 custom provider 使用
  // 连接配置
  apiKey: string;
  apiUrl: string;
  model: string;                   // 模型 ID
  // 高级选项
  displayName?: string;            // 展示名称
  contextWindow?: number;          // 上下文窗口大小
  maxTokens?: number;              // 最大输出 token
  temperature?: number;            // 温度参数 (默认 0.7, Kimi 等模型需设为 1)
}

// ========== 模板 ==========
export type TemplateType =
  | "business-meeting" | "academic-exchange" | "class-summary" | "interview"
  | "general" | "custom"
  | "reading-notes" | "thesis-discussion" | "news-interview" | "user-research"
  | "sales-meeting" | "customer-call" | "business-negotiation"
  | "government-meeting" | "policy-briefing" | "party-study"
  | "product-review" | "tech-proposal" | "sprint-retro";

export interface SummaryTemplate {
  type: TemplateType;
  name: string;
  description: string;
  systemPrompt: string;
  outputFormat: string;            // 输出格式说明
}

// ========== 热词 ==========
export interface HotWord {
  word: string;
  weight?: number;                 // 权重 1-10
  category?: string;               // 分类
}

// ========== 处理任务 ==========
export interface TranscriptionTask {
  id: string;
  mp3Urls: string[];               // MP3 文件链接列表
  asrConfig: ASRConfig;
  speakerConfig: SpeakerDiarizationConfig;
  llmConfig: LLMConfig;
  template: TemplateType;
  customPrompt?: string;            // 自定义模板的 Prompt
  hotWords: HotWord[];
  voiceprintLibrary: VoiceprintEntry[];
  createdAt: number;
}

// ========== 处理结果 ==========
export interface TranscriptionResult {
  taskId: string;
  // 转录原文 (区分说话人)
  transcript: TranscriptSegment[];
  // LLM 总结
  summary: string;
  // 关键词/行动项
  keywords: string[];
  actionItems: string[];
  // 元数据
  duration: number;
  language: string;
  speakerCount: number;
}

export interface TranscriptSegment {
  startTime: string;               // "00:01:23"
  endTime: string;
  speaker: string;                 // "发言人A" / "张三"
  text: string;
}

import type { SonicNoteSyncSettings, DEFAULT_SYNC_SETTINGS } from './sync/types';

export { SonicNoteSyncSettings, DEFAULT_SYNC_SETTINGS };
export interface SonicNoteGeekSettings {
  // ASR 默认配置 (向后兼容)
  asr: ASRConfig;
  // ASR 模型列表
  asrModels: ASRModelEntry[];
  // 当前激活的 ASR 模型 ID
  activeAsrModelId: string;
  // 说话人识别默认配置
  speakerDiarization: SpeakerDiarizationConfig;
  // LLM 默认配置 (向后兼容)
  llm: LLMConfig;
  // LLM 模型列表
  llmModels: LLMModelEntry[];
  // 当前激活的 LLM 模型 ID
  activeModelId: string;
  // 自定义模板
  customTemplates: SummaryTemplate[];
  // 行业偏好
  industry: string;
  // 热词库
  hotWords: HotWord[];
  // 声纹库
  voiceprintLibrary: VoiceprintEntry[];
  // 文件同步设置 (SonicNoteSync)
  sync: SonicNoteSyncSettings;
}
