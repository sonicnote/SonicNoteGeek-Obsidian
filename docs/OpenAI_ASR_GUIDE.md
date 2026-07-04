# OpenAI 音频转写接口标准

SonicNoteAsr 插件通过此标准接口对接本地/远程 ASR 服务。

## 接口规范

```
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
```

## 模板代码 (FastAPI)

```python
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
```

## 接入任意云服务商

如果你想用插件的 "OpenAI 兼容 (通用)" 对接付费云 ASR，只需写一个本地代理脚本：

```python
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
            {"start": s["begin"], "end": s["end"], "text": s["content"]}
            for s in result["sentences"]
        ]
    }

uvicorn.run(app, host="0.0.0.0", port=8100)
```

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
| segments[].speaker | 否 | 说话人标签，如 "speaker_0"、"speaker_1" |
| duration | 否 | 音频总时长（秒） |

## 已适配本地服务

| 服务 | 端口 | 启动命令 | 可选模型 |
|------|------|----------|----------|
| FunASR | 8000 | `cd ~/Desktop/funasr && python funasr_api.py` | sensevoice / paraformer / fun-asr-nano |
| Whisper | 8001 | `cd ~/Desktop/whisper && python whisper_api.py` | tiny / base / small / medium / large-v3 / turbo |
| Moonshine | 6000 | `cd ~/Desktop/moonshine && python moonshine_api.py` | base / zh |

## 能力支持

| 能力 | 是否支持 | 说明 |
|------|----------|------|
| 语音转文字 | 支持 | 通过 `text` 和 `segments[].text` 返回 |
| 说话人分离 | 支持 | 通过 `segments[].speaker` 返回说话人标签 |
| 热词管理 | **不支持** | OpenAI 标准接口无 hotwords 参数；热词仅在云服务商原生 API 中可用 |
