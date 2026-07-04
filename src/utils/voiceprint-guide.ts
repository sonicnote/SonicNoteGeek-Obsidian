import { Modal, App, MarkdownRenderer, Component } from "obsidian";

export const VOICEPRINT_GUIDE = `# 声纹识别接口标准

SonicNoteAsr 插件通过此标准接口对接本地/远程声纹识别服务。

## 接口规范

### 1. 声纹注册

\`\`\`
POST /v1/speaker/enroll?name={姓名}&audio_path={音频绝对路径}
\`\`\`

用于注册说话人的声纹样本。建议使用 3-10 秒的清晰单人语音片段。

| 参数 | 必填 | 说明 |
|------|------|------|
| name | 是 | 说话人姓名 |
| audio_path | 是 | 声纹样本音频的绝对路径 (wav/mp3/m4a) |

返回:

\`\`\`json
{
  "ok": true,
  "name": "张三",
  "samples": 1
}
\`\`\`

### 2. 说话人识别

\`\`\`
POST /v1/speaker/identify
Content-Type: application/json
\`\`\`

对音频中不同说话人的片段进行声纹比对，返回说话人姓名标签。

请求:

\`\`\`json
{
  "audio_file": "/path/to/recording.mp3",
  "speaker_segments": [
    {"speaker_id": "speaker_1", "starts": [0.5, 10.2], "ends": [3.0, 15.5]},
    {"speaker_id": "speaker_2", "starts": [2.0], "ends": [8.0]}
  ],
  "voiceprint_library": [
    {"name": "张三", "audio_path": "/path/to/zhangsan.wav"},
    {"name": "李四", "audio_path": "/path/to/lisi.wav"}
  ]
}
\`\`\`

| 字段 | 必填 | 说明 |
|------|------|------|
| audio_file | 是 | 原始录音的绝对路径 |
| speaker_segments | 是 | 按 speaker 分组的时间片段 |
| speaker_segments[].speaker_id | 是 | 说话人标识，如 "speaker_1" |
| speaker_segments[].starts | 是 | 每段的起始秒数数组 |
| speaker_segments[].ends | 是 | 每段的结束秒数数组 |
| voiceprint_library | 是 | 声纹库，包含人名和样本音频 |
| voiceprint_library[].name | 是 | 说话人姓名 |
| voiceprint_library[].audio_path | 是 | 声纹样本音频绝对路径 |

返回:

\`\`\`json
{
  "labels": {
    "speaker_1": "张三",
    "speaker_2": "未知说话人"
  }
}
\`\`\`

- 匹配成功时返回真实姓名
- 匹配失败或置信度不足时返回 "未知说话人"

### 3. 列出已注册说话人

\`\`\`
GET /v1/speaker/list
\`\`\`

返回:

\`\`\`json
{
  "speakers": ["张三", "李四"]
}
\`\`\`

### 4. 删除说话人

\`\`\`
POST /v1/speaker/delete?name={姓名}
\`\`\`

## 处理流程

\`\`\`
原始音频 → ASR转写(带说话人分离) → 得到speaker分段
    ↓
按speaker分组时间片段 → ffmpeg剪切+拼接 → 提取声纹特征
    ↓
与声纹库逐一比对(余弦相似度) → 最高分≥阈值 → 赋予姓名
    ↓
更新逐字稿中的说话人标签
\`\`\`

## 模板代码 (FastAPI + CAM++)

\`\`\`python
from fastapi import FastAPI
from funasr import AutoModel
import numpy as np
import subprocess, tempfile, os, json

app = FastAPI(title="声纹识别服务")
model = AutoModel(model="CAMPPlus")

@app.post("/v1/speaker/identify")
async def identify(req: dict):
    labels = {}
    for spk in req["speaker_segments"]:
        # ffmpeg 剪切 + 拼接音频片段
        merged = cut_and_merge(req["audio_file"], spk)
        # 提取声纹特征
        emb = model.generate(input=merged)[0]["spk_embedding"]
        emb = np.array(emb).flatten()
        # 与声纹库比对
        best_name, best_score = "未知说话人", 0.0
        for vp in req["voiceprint_library"]:
            ref = extract_embedding(vp["audio_path"])
            score = cosine_similarity(emb, ref)
            if score > best_score:
                best_score = score
                best_name = vp["name"]
        labels[spk["speaker_id"]] = best_name if best_score >= 0.55 else "未知说话人"
    return {"labels": labels}
\`\`\`

## 接入其他声纹模型

只需替换 \`AutoModel\` 的模型名称:

| 模型 | model key | 说明 |
|------|-----------|------|
| CAM++ | \`CAMPPlus\` | 达摩院 CAM++，192维，中文优化 |
| ERes2NetV2 | \`iic/speech_eres2netv2_sv_zh-cn_16k-common\` | 更强，512维，ModelScope下载 |

阈值建议: 0.55 (CAM++) / 0.60 (ERes2NetV2)，可根据实际效果调整。

## 已适配本地服务

| 服务 | 端口 | 启动命令 |
|------|------|----------|
| CAM++ 声纹 | 8100 | \`cd ~/Desktop/funasr && python voiceprint_api.py\` |
`;

export class VoiceprintGuideModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sonicnote-guide-modal");

    // 标题行 + 下载按钮
    const header = contentEl.createDiv({ cls: "sonicnote-guide-header" });
    header.createEl("h3", { text: "声纹识别接口标准" });

    const downloadBtn = header.createEl("button", {
      cls: "sonicnote-guide-download-btn",
    });
    downloadBtn.setText("📥 下载 .md");
    downloadBtn.addEventListener("click", () => {
      const blob = new Blob([VOICEPRINT_GUIDE], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "VOICEPRINT_API_GUIDE.md";
      a.click();
      URL.revokeObjectURL(url);
    });

    // 使用 Obsidian 内置 Markdown 渲染
    const body = contentEl.createDiv({ cls: "sonicnote-guide-body" });
    MarkdownRenderer.render(
      this.app,
      VOICEPRINT_GUIDE,
      body,
      "",
      new Component(),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
