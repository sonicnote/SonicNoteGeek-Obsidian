# SonicNoteGeek

Obsidian 音频转写与智能总结插件。将 MP3 录音自动转写为带说话人标注的文字稿，并调用大语言模型生成结构化总结。

## 功能

- **音频链接解析** — 自动检测当前文档中的 MP3 链接，支持公网 URL 和本地附件
- **语音转写 (ASR)** — 支持 OpenAI Whisper、火山引擎、阿里云、讯飞、腾讯云、百度云、华为云、本地服务等
- **说话人分离** — 内置启发式算法 + 可选的声纹识别（CAM++）自动匹配真实人名
- **AI 总结 (LLM)** — 内置 18+ 模板，调用 LLM 生成结构化会议纪要/课堂笔记/访谈记录
- **云端文件同步** — 从 SonicNote 妙记 App 云端同步录音 → 本地 Obsidian 文档（转录原文 + AI 总结 + 音频文件）
- **声纹管理** — 从逐字稿中提取音频片段，注册为声纹样本，自动标注说话人姓名
- **AI 聊天** — 面板内置 AI 对话区，可对转录内容进行多轮问答

## 安装

### 从源码安装

```bash
cd ~/Documents/Obsidian/.obsidian/plugins
git clone <repo-url> SonicNoteGeek
cd SonicNoteGeek
npm install
npm run build
```

### 手动安装

1. 下载 `main.js`、`styles.css`、`manifest.json`
2. 放入 `<vault>/.obsidian/plugins/SonicNoteGeek/`
3. 在 Obsidian 设置 → 第三方插件中启用

## 开发

```bash
npm run dev      # 监听模式，自动重新构建
npm run build    # 生产构建（tsc 类型检查 + esbuild 打包）
```

构建输出 `main.js` 到项目根目录。

## 项目结构

```
SonicNoteGeek-Obsidian/
├── main.ts                       # 插件入口，注册命令/面板/同步
├── main.js                       # 构建产物（esbuild bundle）
├── manifest.json                 # Obsidian 插件清单
├── styles.css                    # 插件样式
├── esbuild.config.mjs            # esbuild 构建脚本
├── tsconfig.json                 # TypeScript 配置
├── src/
│   ├── types.ts                  # 类型定义（ASR/LLM/模板/声纹/同步）
│   ├── settings.ts               # 插件设置 Tab（Obsidian 原生）
│   ├── view.ts                   # 右侧面板（音频列表/模板选择/操作按钮/AI 聊天）
│   ├── modal.ts                  # 处理流程弹窗（7 步骤向导）
│   ├── processor.ts              # 音频处理管线（下载→转写→说话人分离→总结）
│   ├── templates.ts              # 18+ 内置总结模板
│   ├── sync/
│   │   ├── types.ts              # 同步数据类型
│   │   ├── api.ts                # SonicNote API 客户端
│   │   ├── sync.ts               # 同步编排逻辑（增量对比/下载/生成文档）
│   │   ├── settings.ts           # 同步设置 UI
│   │   └── formatter.ts          # 同步输出格式化
│   └── utils/
│       ├── mp3-extractor.ts      # MP3 链接提取（正则 + vault 附件遍历）
│       ├── output-generator.ts   # Markdown 输出生成
│       ├── model-list.ts         # LLM 模型选择 Modal + 预设
│       ├── asr-model-list.ts     # ASR 模型选择 Modal + 预设
│       ├── asr-guide.ts          # ASR 协议接口标准文档 Modal
│       └── voiceprint-guide.ts   # 声纹识别接口标准 Modal
└── docs/
    ├── SonicNoteGeek-功能说明.md   # 中文用户手册
    └── OpenAI_ASR_GUIDE.md       # OpenAI 音频转写接口规范（供本地服务对接）
```

## 支持的引擎

### ASR 语音转写

| 服务商 | 协议 | 本地文件 |
|--------|------|----------|
| OpenAI Whisper | `openai-whisper` | 需 URL |
| 火山引擎（豆包） | `volcengine` | 需 URL |
| 阿里云 DashScope | `aliyun-dashscope` | 需 URL |
| 讯飞 | `xunfei` | 支持 |
| 腾讯云 | `tencent` | 需 URL |
| 百度云 | `baidu` | 需 URL |
| 华为云 SIS | `huawei` | 需 URL |
| 本地 OpenAI 兼容 | `local-openai` | 支持 |

### LLM 大语言模型

Anthropic Claude、OpenAI GPT、智谱 GLM、DeepSeek、MiniMax、Google Gemini、阿里通义千问、百度文心一言、字节豆包、腾讯混元、华为盘古、Moonshot Kimi、讯飞星火、Mistral、Meta Llama，及自定义兼容接口。

## 视频教程

- [Bilibili 使用教程](https://www.bilibili.com/video/BV1gE7A6zERK/?vd_source=e28745caa23df4182841fe10c0c4faff) — 视频演示与操作指南

## 文档

- [官方使用文档](https://ainote.easylinkin.com/#/resources/docs) — 在线完整使用指南
- [SonicNoteGeek 功能说明](./docs/SonicNoteGeek-功能说明.md) — 完整中文用户手册
- [OpenAI ASR 接口标准](./docs/OpenAI_ASR_GUIDE.md) — 本地/远程 ASR 服务对接规范

## License

MIT
