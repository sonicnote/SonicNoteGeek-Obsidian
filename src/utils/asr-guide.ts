import { Modal, App, MarkdownRenderer, Component } from "obsidian";
import type { ASRProtocol } from "../types";

// ---- 各协议接口标准文档 ----
const GUIDES: Record<ASRProtocol, { title: string; content: string }> = {
  "openai-whisper": {
    title: "OpenAI Whisper 接口标准",
    content: `# OpenAI Whisper 音频转写接口标准

## 接口规范

\`\`\`
POST https://api.openai.com/v1/audio/transcriptions
Authorization: Bearer <API_KEY>
Content-Type: multipart/form-data

字段:
  file              (binary)  音频文件
  model             (string)  模型名称, 如 "whisper-1"
  language          (string)  语言代码, 如 "zh"
  response_format   (string)  "verbose_json"
  prompt            (string)  可选, 引导词

返回 (JSON):
{
  "text": "转写全文",
  "segments": [
    { "start": 0.0, "end": 2.5, "text": "...", "speaker": "speaker_0" }
  ]
}
\`\`\`

## 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| file | 是 | 音频文件 (mp3/wav/m4a/flac), 最大 25MB |
| model | 是 | 模型名, 推荐 whisper-1 |
| language | 否 | ISO 语言代码 |
| response_format | 否 | verbose_json 返回分段时戳 |

## 能力支持

| 能力 | 支持 | 说明 |
|------|------|------|
| 语音转文字 | ✅ | 通过 text 和 segments[].text |
| 说话人分离 | ❌ | OpenAI Whisper 不支持, 插件内置启发式替代 |
| 热词管理 | ❌ | 不支持 hotwords |
`,
  },

  "volcengine": {
    title: "火山引擎 BigModel ASR 接口标准",
    content: `# 火山引擎 BigModel ASR 接口标准

## 接口规范

\`\`\`
POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
X-Api-Key: <API_KEY>
Content-Type: multipart/form-data

字段:
  audio             (binary)  音频文件
  model             (string)  模型名称, 如 "bigmodel"
  language          (string)  语言代码, 如 "zh-CN"
  enable_itn        (bool)    逆文本正则化
  enable_punc       (bool)    标点预测

返回 (JSON):
{
  "code": 0,
  "message": "success",
  "result": {
    "text": "转写全文",
    "utterances": [
      { "text": "...", "start_time": 0, "end_time": 2500, "speaker": "0" }
    ]
  }
}
\`\`\`

## 认证方式

使用 X-Api-Key 头传递 API Key, 无需签名。

## 能力支持

| 能力 | 支持 | 说明 |
|------|------|------|
| 语音转文字 | ✅ | 通过 utterances[].text |
| 说话人分离 | ✅ | 通过 utterances[].speaker, 需资源实例开通 |
| 热词管理 | ✅ | 支持 hotwords 参数 |
`,
  },

  "aliyun-dashscope": {
    title: "阿里云 DashScope Fun-ASR 接口标准",
    content: `# 阿里云 DashScope Fun-ASR 接口标准

## 接口规范

\`\`\`
POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription
Authorization: Bearer <API_KEY>
Content-Type: application/json

请求体:
{
  "model": "fun-asr-flash-2026-06-15",
  "input": {
    "file_urls": ["https://example.com/audio.mp3"]
  },
  "parameters": {
    "language": "zh",
    "speaker_diarization": true
  }
}

返回 (JSON):
{
  "output": {
    "results": [{
      "transcription_url": "...",
      "sentences": [
        { "begin_time": 0, "end_time": 2500, "text": "...", "speaker_id": 0 }
      ]
    }]
  }
}
\`\`\`

## 认证方式

Bearer Token 方式, API Key 从阿里云 DashScope 控制台获取。

## 能力支持

| 能力 | 支持 | 说明 |
|------|------|------|
| 语音转文字 | ✅ | 提交+轮询模式 |
| 说话人分离 | ✅ | speaker_diarization 参数 |
| 热词管理 | ❌ | 不支持 |
`,
  },

  "xunfei": {
    title: "讯飞 ASR 接口标准",
    content: `# 讯飞录音文件转写大模型 接口标准

## 接口规范

\`\`\`
POST https://office-api-ist-dx.iflyaisol.com/.../upload
签名方式: HMAC-SHA256

需要: APPID + APIKey (accessKeyId) + APISecret
使用 HMAC-SHA256 生成签名

上传步骤:
  1. POST 上传音频文件 → 获取 taskId
  2. POST 查询转写结果 → 轮询直到完成

返回 (JSON):
{
  "code": 0,
  "data": {
    "taskId": "...",
    "result": {
      "content": [
        { "role": "0", "content": "...",
          "sentence_begin_time": 0, "sentence_end_time": 2500 }
      ]
    }
  }
}
\`\`\`

## 认证方式

HMAC-SHA256 签名, 需要 APPID, APIKey, APISecret 三个参数。

## 能力支持

| 能力 | 支持 | 说明 |
|------|------|------|
| 语音转文字 | ✅ | 上传+轮询模式 |
| 说话人分离 | ✅ | 通过 role 字段区分 |
| 热词管理 | ✅ | 支持 |
`,
  },

  "tencent": {
    title: "腾讯云 ASR 接口标准",
    content: `# 腾讯云录音文件识别 接口标准

## 接口规范

\`\`\`
POST https://asr.tencentcloudapi.com
签名方式: TC3-HMAC-SHA256

需要: SecretId + SecretKey
使用 TC3-HMAC-SHA256 签名算法

请求体 (JSON):
{
  "EngineModelType": "16k_zh",
  "ChannelNum": 1,
  "ResTextFormat": 3,
  "SourceType": 0,
  "Url": "https://example.com/audio.mp3",
  "SpeakerDiarization": 1,
  "SpeakerNumber": 0
}

返回 (JSON):
{
  "Response": {
    "RequestId": "...",
    "Data": {
      "TaskId": 1234567890
    }
  }
}
\`\`\`

## 认证方式

TC3-HMAC-SHA256 签名, 需要 SecretId 和 SecretKey。

## 能力支持

| 能力 | 支持 | 说明 |
|------|------|------|
| 语音转文字 | ✅ | 提交+轮询模式 |
| 说话人分离 | ✅ | SpeakerDiarization 参数 |
| 热词管理 | ✅ | HotwordId 参数 |
`,
  },

  "baidu": {
    title: "百度云 ASR 接口标准",
    content: `# 百度云长音频文件转写 接口标准

## 接口规范

\`\`\`
POST https://aip.baidubce.com/rpc/2.0/aasr/v1/...
签名方式: OAuth 2.0 (先获取 access_token)

需要: API Key + Secret Key
先调用 OAuth 获取 access_token, 再调用 ASR

请求体 (JSON):
{
  "url": "https://example.com/audio.mp3",
  "format": "mp3",
  "pid": 80001,
  "rate": 16000
}

返回 (JSON):
{
  "err_no": 0,
  "task_id": "...",
  "result": ["转写全文"]
}
\`\`\`

## 认证方式

OAuth 2.0: 使用 API Key + Secret Key 换取 access_token。

## 能力支持

| 能力 | 支持 | 说明 |
|------|------|------|
| 语音转文字 | ✅ | OAuth + 轮询模式 |
| 说话人分离 | 部分 | 部分模型支持 |
| 热词管理 | ❌ | 不支持 |
`,
  },

  "huawei": {
    title: "华为云 SIS 接口标准",
    content: `# 华为云语音交互服务 (SIS) 接口标准

## 接口规范

\`\`\`
POST https://sis-ext.cn-north-4.myhuaweicloud.com/v1/...
签名方式: AK/SK 签名

需要: Access Key (AK) + Secret Access Key (SK) + Project ID
使用华为云 AK/SK 签名算法

请求体 (JSON):
{
  "config": {
    "audio_format": "mp3",
    "property": "chinese_16k_media",
    "language": "zh"
  },
  "data": "<base64_audio>"
}

返回 (JSON):
{
  "result": {
    "text": "转写全文",
    "segments": [...]
  }
}
\`\`\`

## 认证方式

华为云 AK/SK 签名, 需要 AK, SK, Project ID 和对应的 endpoint。

## 能力支持

| 能力 | 支持 | 说明 |
|------|------|------|
| 语音转文字 | ✅ | 支持实时和录音文件 |
| 说话人分离 | ✅ | 部分模型支持 diarization |
| 热词管理 | ❌ | 不支持 |
`,
  },

  "local-openai": {
    title: "OpenAI 兼容标准",
    content: `# OpenAI 音频转写接口标准

SonicNoteAsr 插件通过此标准接口对接本地/远程 ASR 服务。

## 接口规范

\`\`\`
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

字段:
  file              (binary)  音频文件
  model             (string)  模型名称
  language          (string)  语言代码，如 "zh"
  response_format   (string)  "verbose_json"

返回 (JSON):
{
  "text": "转写全文",
  "segments": [
    { "start": 0.0, "end": 2.5, "text": "第一句话", "speaker": "speaker_0" },
    { "start": 2.5, "end": 5.0, "text": "第二句话", "speaker": "speaker_1" }
  ]
}

注意:
  - 该标准接口支持说话人分离 (speaker diarization)，通过 segments[].speaker 字段返回。
  - 该标准接口不支持热词管理 (hotwords / keyword boosting)，OpenAI 规范中无此参数。
\`\`\`

## 模板代码 (FastAPI)

\`\`\`python
from fastapi import FastAPI, UploadFile, File
import uvicorn

app = FastAPI()

@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    result = your_asr_model.transcribe(audio_bytes)
    return {
        "text": result.full_text,
        "segments": [
            {"start": seg.start, "end": seg.end, "text": seg.text, "speaker": seg.speaker}
            for seg in result.segments
        ],
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
\`\`\`

## 接入任意云服务商

如果你想用插件的 "OpenAI 兼容 (通用)" 对接付费云 ASR，只需写一个本地代理脚本：

\`\`\`python
# cloud_asr_proxy.py
from fastapi import FastAPI, UploadFile, File
import requests

app = FastAPI()

@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    audio = await file.read()
    # 调用云服务商的原生 API
    result = your_cloud_asr.transcribe(audio)
    # 转换成标准格式返回
    return {
        "text": result["raw_text"],
        "segments": [
            {"start": s["begin"], "end": s["end"], "text": s["content"], "speaker": s.get("speaker", "")}
            for s in result["sentences"]
        ]
    }

uvicorn.run(app, host="0.0.0.0", port=8100)
\`\`\`

## 字段说明

### 请求

| 字段 | 必填 | 说明 |
|------|------|------|
| file | 是 | 音频文件 (mp3/wav/m4a/flac) |
| model | 否 | 模型名 |
| language | 否 | ISO 语言代码 (zh/en/auto) |
| response_format | 否 | verbose_json |

### 响应

| 字段 | 必填 | 说明 |
|------|------|------|
| text | 是 | 转写全文 |
| segments | 否 | 分段列表（含时戳） |
| segments[].start | 是 | 开始秒数 |
| segments[].end | 是 | 结束秒数 |
| segments[].text | 是 | 本段文本 |
| segments[].speaker | 否 | 说话人标签 |
| duration | 否 | 音频总时长（秒） |

## 已适配本地服务

| 服务 | 端口 | 启动命令 | 可选模型 |
|------|------|----------|----------|
| FunASR | 8000 | \`cd ~/Desktop/funasr && python funasr_api.py\` | sensevoice / paraformer / fun-asr-nano |
| Whisper | 8001 | \`cd ~/Desktop/whisper && python whisper_api.py\` | tiny / base / small / medium / large-v3 / turbo |
| Moonshine | 6000 | \`cd ~/Desktop/moonshine && python moonshine_api.py\` | base / zh |

## 能力支持

| 能力 | 是否支持 | 说明 |
|------|----------|------|
| 语音转文字 | 支持 | 通过 text 和 segments[].text 返回 |
| 说话人分离 | 支持 | 通过 segments[].speaker 返回说话人标签 |
| 热词管理 | **不支持** | OpenAI 标准接口无 hotwords 参数；热词仅在云服务商原生 API 中可用 |
`,
  },
};

const GUIDE_LABELS: Record<ASRProtocol, string> = {
  "openai-whisper": "OpenAI 接口标准",
  "volcengine": "火山引擎 接口标准",
  "aliyun-dashscope": "阿里云 接口标准",
  "xunfei": "讯飞 接口标准",
  "tencent": "腾讯云 接口标准",
  "baidu": "百度云 接口标准",
  "huawei": "华为云 接口标准",
  "local-openai": "OpenAI 兼容标准",
};

export function getGuideLabel(protocol: ASRProtocol): string {
  return GUIDE_LABELS[protocol] || "接口标准";
}

export class AsrGuideModal extends Modal {
  private protocol: ASRProtocol;

  constructor(app: App, protocol: ASRProtocol = "local-openai") {
    super(app);
    this.protocol = protocol;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-guide-modal");

    const guide = GUIDES[this.protocol] || GUIDES["local-openai"];

    const header = contentEl.createDiv({ cls: "sonicnote-guide-header" });
    header.createEl("h3", { text: guide.title });

    const downloadBtn = header.createEl("button", {
      cls: "sonicnote-guide-download-btn",
    });
    downloadBtn.setText("📥 下载 .md");
    downloadBtn.addEventListener("click", () => {
      const blob = new Blob([guide.content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${this.protocol}_asr_guide.md`;
      a.click();
      URL.revokeObjectURL(url);
    });

    const body = contentEl.createDiv({ cls: "sonicnote-guide-body" });
    MarkdownRenderer.render(
      this.app,
      guide.content,
      body,
      "",
      new Component(),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
