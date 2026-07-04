import { Notice, requestUrl, Vault } from "obsidian";
import type {
  TranscriptionTask, TranscriptionResult, TranscriptSegment,
  ASRConfig, LLMConfig, SpeakerDiarizationConfig, SummaryTemplate, ASRProtocol,
  VoiceprintEntry, TemplateType,
} from "./types";
import { getTemplate } from "./templates";
import { generateOutput } from "./utils/output-generator";

/**
 * 核心处理管线: ASR 转写 → 说话人分离 → LLM 总结 → 生成输出文档
 */
export class AudioProcessor {
  /** 最近一次处理的转录结果，供 AI 聊天使用 */
  public lastTranscript: TranscriptSegment[] = [];
  /** 最近一次下载的 MP3 本地路径（vault 相对路径） */
  public lastDownloadedPaths: string[] = [];
  /** 最近一次处理的原始 MP3 URL（供云端 ASR 重新转写使用） */
  public lastOriginalUrls: string[] = [];
  /** Vault 根目录绝对路径（用于读取本地文件） */
  public vaultBasePath: string = "";
  /** 最近一次下载失败的错误信息 */
  public lastDownloadErrors: Array<{ url: string; error: string }> = [];

  /**
   * 执行完整处理流程: 下载 → 转写 → 总结 → 文档
   * progressCallback(stageIndex, label): 0=音频下载, 1=语音转写, 2=分析总结, 3=文档写入
   */
  async process(
    task: TranscriptionTask,
    vault: Vault,
    sourceTitle: string,
    progressCallback?: (stageIndex: number, label: string) => void,
    asrModelName?: string,
  ): Promise<string> {
    // 设置 vault 根目录绝对路径（用于 xunfei 等需要读取本地文件的场景）
    this.vaultBasePath = (vault.adapter as any).basePath || "";
    this.lastOriginalUrls = task.mp3Urls;

    // Stage 0: 下载 MP3 到本地 (云端 ASR 保留原始 URL 用于 API 调用)
    progressCallback?.(0, "音频下载");
    const isCloudASR = !task.asrConfig.protocol.startsWith("local-") && task.asrConfig.protocol !== "xunfei";
    this.lastDownloadedPaths = await this.downloadMp3s(task.mp3Urls, vault, sourceTitle);

    // Stage 1: ASR 转写 + 说话人分离
    progressCallback?.(1, "语音转写");
    const mp3sToProcess = isCloudASR ? task.mp3Urls
      : (this.lastDownloadedPaths.length > 0 ? this.lastDownloadedPaths : task.mp3Urls);
    const rawTranscript = await this.runASR(mp3sToProcess, task.asrConfig, task.hotWords);
    const transcript = await this.runSpeakerDiarization(
      rawTranscript, task.speakerConfig, task.voiceprintLibrary,
      this.lastDownloadedPaths.length > 0 ? this.lastDownloadedPaths : mp3sToProcess,
    );
    this.lastTranscript = transcript;

    // Stage 2: LLM 总结
    progressCallback?.(2, "分析总结");
    let template = getTemplate(task.template);

    if (task.template === "custom" && task.customPrompt) {
      template = {
        type: "custom",
        name: "自定义模板",
        description: "用户自定义 Prompt",
        systemPrompt: task.customPrompt,
        outputFormat: "",
      };
    }

    if (!template) throw new Error("未找到指定的总结模板");

    let summary: string;
    let keywords: string[] = [];
    let actionItems: string[] = [];
    try {
      const llmResult = await this.runLLMSummarization(
        transcript, task.llmConfig, template,
      );
      summary = llmResult.summary;
      keywords = llmResult.keywords;
      actionItems = llmResult.actionItems;
    } catch (llmErr) {
      const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.warn("LLM 总结失败，仅输出逐字稿:", msg);
      summary = `> ⚠️ LLM 总结失败: ${msg}\n\n> 以下为语音转写逐字稿。`;
    }

    // Stage 3: 生成输出文档
    progressCallback?.(3, "文档写入");
    const result: TranscriptionResult = {
      taskId: task.id,
      transcript,
      summary,
      keywords,
      actionItems,
      duration: this.calcDuration(transcript),
      language: task.asrConfig.language,
      speakerCount: new Set(transcript.map((s) => s.speaker)).size,
    };

    const output = generateOutput(result, template, sourceTitle, asrModelName, task.mp3Urls);
    return output;
  }

  /** 下载远程 MP3 到 vault 本地 */
  private async downloadMp3s(
    mp3Urls: string[],
    vault: Vault,
    sourceTitle: string,
  ): Promise<string[]> {
    const localPaths: string[] = [];
    this.lastDownloadErrors = [];

    for (const url of mp3Urls) {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        localPaths.push(url);
        continue;
      }

      try {
        const fileName = url.split("/").pop()?.split("?")[0] || `audio_${Date.now()}.mp3`;
        const savePath = `SonicNoteSync/Audio/${sourceTitle}/${fileName}`;

        // 如果文件已存在，直接复用
        const existingFile = vault.getAbstractFileByPath(savePath);
        if (existingFile) {
          localPaths.push(savePath);
          continue;
        }

        const resp = await requestUrl({ url, method: "GET", throw: false });
        if (resp.status !== 200) {
          const errMsg = `HTTP ${resp.status}`;
          this.lastDownloadErrors.push({ url, error: errMsg });
          console.warn(`下载 MP3 失败: ${url} - ${errMsg}`);
          localPaths.push(url);
          continue;
        }

        const dirPath = savePath.substring(0, savePath.lastIndexOf("/"));
        try {
          await vault.createFolder(dirPath);
        } catch {
          // 目录已存在则忽略
        }

        try {
          await vault.createBinary(savePath, resp.arrayBuffer);
        } catch (writeErr) {
          // 文件可能已在检查后被创建（极少数情况），检查是否有文件存在
          const retryFile = vault.getAbstractFileByPath(savePath);
          if (retryFile) {
            localPaths.push(savePath);
            continue;
          }
          throw writeErr;
        }
        localPaths.push(savePath);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.lastDownloadErrors.push({ url, error: errMsg });
        console.warn(`下载 MP3 失败: ${url}`, error);
        localPaths.push(url);
      }
    }

    return localPaths;
  }

  // ---- ASR 转写 ----
  private async runASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    // 云端 ASR 校验: URL 必须是 HTTP(S) 地址（xunfei 除外，它自己处理本地文件上传）
    if (!config.protocol.startsWith("local-") && config.protocol !== "xunfei") {
      for (const url of mp3Urls) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error(
            `云端 ASR (${config.protocol}) 需要公网可访问的 HTTP URL，但当前是 vault 本地路径: "${url}"\n` +
            `请使用本地 ASR 模型 (local-openai) 或将音频上传到公网图床/OSS。`,
          );
        }
      }
    }

    try {
      switch (config.protocol) {
        case "local-openai":
          return this.callLocalASR(mp3Urls, config);
        case "openai-whisper":
          return this.callOpenAIWhisper(mp3Urls, config, hotWords);
        case "volcengine":
          return this.callVolcengineASR(mp3Urls, config, hotWords);
        case "aliyun-dashscope":
          return this.callAliyunDashScopeASR(mp3Urls, config, hotWords);
        case "xunfei":
          return this.callXunfeiASR(mp3Urls, config, hotWords);
        case "tencent":
          return this.callTencentASR(mp3Urls, config, hotWords);
        case "baidu":
          return this.callBaiduASR(mp3Urls, config, hotWords);
        case "huawei":
          return this.callHuaweiASR(mp3Urls, config, hotWords);
        default:
          throw new Error(`不支持的 ASR 协议: ${config.protocol}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const urlInfo = mp3Urls.length === 1 ? mp3Urls[0] : `${mp3Urls.length} 个文件`;
      throw new Error(`ASR 转写失败 [${urlInfo}]: ${msg}`);
    }
  }

  /**
   * 统一本地 ASR 入口（OpenAI 兼容格式）
   * 所有本地 ASR 服务只需暴露 POST /v1/audio/transcriptions，返回 {text, segments: [{start, end, text}]}。
   */
  private async callLocalASR(
    mp3Urls: string[], config: ASRConfig,
  ): Promise<TranscriptSegment[]> {
    const baseUrl = config.localEndpoint || "http://localhost:8000";
    const model = config.model || "";
    const results: TranscriptSegment[] = [];

    for (const pathOrUrl of mp3Urls) {
      const endpoint = baseUrl.replace(/\/$/, "") + "/v1/audio/transcriptions";

      // 读取音频（支持远程 URL，仅 FunASR 场景常用）
      let audioBuffer: Buffer;
      let fileName = "audio.mp3";
      const fs = require("fs");
      const resolvedPath = pathOrUrl.startsWith("/") ? pathOrUrl
        : `${this.vaultBasePath}/${pathOrUrl}`;
      try {
        audioBuffer = fs.readFileSync(resolvedPath);
        fileName = (resolvedPath.split("/").pop() || "audio.mp3");
      } catch (e) {
        if (pathOrUrl.startsWith("http")) {
          const resp = await requestUrl({ url: pathOrUrl, method: "GET" });
          audioBuffer = Buffer.from(resp.arrayBuffer);
          fileName = pathOrUrl.split("/").pop()?.split("?")[0] || "audio.mp3";
        } else {
          throw new Error(`无法读取音频文件: ${resolvedPath} (${(e as Error).message})`);
        }
      }

      // 构造 multipart/form-data
      const boundary = `----LocalASRBoundary${Date.now()}`;
      const parts: Buffer[] = [];
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ));
      parts.push(audioBuffer);
      const addField = (name: string, value: string) => {
        parts.push(Buffer.from(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`,
        ));
      };
      addField("model", model);
      addField("language", config.language || "zh");
      addField("response_format", "verbose_json");
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const respData = await this.httpMultipartPost(endpoint, boundary, body);

      if (respData.status !== 200) {
        throw new Error(`本地 ASR 请求失败 [${endpoint}] HTTP ${respData.status}: ${respData.text.substring(0, 300)}`);
      }

      const data = JSON.parse(respData.text);
      let segments = data.segments || data.utterances || data.results || data.sentences || data.result || [];

      if (segments.length > 0) {
        // 有分段 → 加人工间隙帮助说话人分离
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          let start = seg.start || seg.start_time || seg.begin || 0;
          let end = seg.end || seg.end_time || seg.finish || 0;
          if (i > 0) {
            const prevEndSec = this.timestampToSeconds(results[results.length - 1].endTime);
            const gap = 0.3 + Math.random() * 2.2;
            start = Math.max(start, prevEndSec + gap);
            end = Math.max(end, start + (seg.end - seg.start || seg.duration || 1));
          }
          results.push({
            startTime: this.secondsToTimestamp(start),
            endTime: this.secondsToTimestamp(end),
            speaker: seg.speaker || seg.spk || "",
            text: (seg.text || seg.txt || seg.transcript || "").trim(),
          });
        }
      } else if (data.text) {
        // 无分段 → 多级拆分
        const fullText = data.text.trim().replace(/\s+/g, " ").trim();
        results.push(...this.splitTextToSegments(fullText, data.duration || 60));
      }
    }
    return results;
  }

  /** 将无标点的长文本拆分为带间隙的段落 */
  private splitTextToSegments(fullText: string, duration: number): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];

    // 第1步：按换行拆分
    const paragraphs = fullText.split(/\n+/).filter((p: string) => p.trim().length > 0);

    for (const para of paragraphs) {
      // 第2步：按标点拆分（中英文）
      const parts = para.split(/(?<=[。！？\.!\?；;，,、])/);
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // 第3步：长句（>40字）在逗号/空格处再拆分
        if (trimmed.length > 40) {
          const subParts = trimmed.split(/(?<=[,，\s])/);
          for (const sp of subParts) {
            const s = sp.trim();
            if (s) segments.push({ startTime: "", endTime: "", speaker: "", text: s });
          }
        } else {
          segments.push({ startTime: "", endTime: "", speaker: "", text: trimmed });
        }
      }
    }

    // 分配时间戳 + 人工间隙
    if (segments.length > 0) {
      const totalGapTime = Math.min(duration * 0.1, segments.length * 1.5);
      const speechTime = duration - totalGapTime;
      const avgSpeechDur = speechTime / segments.length;
      const avgGap = segments.length > 1 ? totalGapTime / (segments.length - 1) : 0;

      let currentTime = 0.0;
      for (let i = 0; i < segments.length; i++) {
        const jitter = i > 0 ? (0.3 + Math.random() * 2.2) : 0;
        const gap = i > 0 ? Math.max(avgGap * 0.5, jitter) : 0;
        currentTime += gap;
        segments[i].startTime = this.secondsToTimestamp(currentTime);
        segments[i].endTime = this.secondsToTimestamp(currentTime + avgSpeechDur);
        currentTime += avgSpeechDur;
      }
    }

    return segments;
  }

  private timestampToSeconds(ts: string): number {
    const parts = ts.split(":");
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }

  /** HTTP multipart POST */
  private httpMultipartPost(
    urlStr: string, boundary: string, body: Buffer,
    timeoutMs = 1800000,
  ): Promise<{ status: number; text: string }> {
    const { URL } = require("url");
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const http = require(isHttps ? "https" : "http");
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
      }, (res: any) => {
        let buf = "";
        res.on("data", (chunk: string) => { buf += chunk; });
        res.on("end", () => resolve({ status: res.statusCode || 0, text: buf }));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`请求超时 (${Math.round(timeoutMs / 60000)} 分钟)，Whisper CPU 转写可能较慢，尝试更小的模型`));
      });
      req.on("error", (e: Error) => reject(new Error(`连接失败: ${e.message}`)));
      req.write(body);
      req.end();
    });
  }

  private async callOpenAIWhisper(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const endpoint = config.apiUrl || "https://api.openai.com/v1/audio/transcriptions";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const resp = await requestUrl({
        url: endpoint,
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file: url,
          model: "whisper-1",
          language: config.language,
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
        }),
      });

      const data = resp.json;
      const segments = data.segments || [];
      for (const seg of segments) {
        results.push({
          startTime: this.secondsToTimestamp(seg.start),
          endTime: this.secondsToTimestamp(seg.end),
          speaker: "",
          text: seg.text?.trim() || "",
        });
      }
    }
    return results;
  }

  // ---- Node.js 原生 HTTPS 请求 (绕过 Electron net 模块兼容问题) ----
  private nodeRequest(
    urlStr: string,
    body: unknown,
    headers: Record<string, string>,
    method: "GET" | "POST" = "POST",
  ): Promise<{ status: number; headers: Record<string, string>; data: any; text: string }> {
    const https = require("https");
    const { URL } = require("url");
    const u = new URL(urlStr);
    const isGet = method === "GET";
    const bodyStr = isGet ? "" : JSON.stringify(body);
    const opts: Record<string, unknown> = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: { ...headers },
    };
    if (!isGet) {
      opts.headers = { ...headers, "Content-Length": Buffer.byteLength(bodyStr).toString() };
    }
    return new Promise((resolve, reject) => {
      const req = https.request(opts, (res: any) => {
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) { resHeaders[String(k)] = String(v); }
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let data: any = {};
          try { data = JSON.parse(chunks); } catch { /* ignore */ }
          resolve({ status: res.statusCode || 0, headers: resHeaders, data, text: chunks });
        });
      });
      req.on("error", (e: Error) => reject(e));
      if (!isGet) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  private async callVolcengineASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    if (!apiKey) throw new Error("请配置火山引擎 API Key");

    const resourceId = config.resourceId || "volc.seedasr.auc";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const format = this.detectAudioFormat(url);

      const enableSpeaker = config.enableSpeakerDiarization;
      const requestBody: Record<string, unknown> = {
        user: { uid: "豆包语音" },
        audio: { url, format, codec: "raw", rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: false,
          enable_ddc: false,
          enable_speaker_info: enableSpeaker,
          enable_channel_split: false,
          show_utterances: true,   // 必须为 true 才能获取分句和说话人信息
          vad_segment: false,
          sensitive_words_filter: "",
        },
      };

      if (hotWords.length > 0) {
        (requestBody.request as Record<string, unknown>).hotwords = hotWords.map((h) => h.word).join(",");
      }

      // 启用说话人分离时添加 ssd_version 参数
      if (enableSpeaker) {
        (requestBody.request as Record<string, unknown>).ssd_version = "200";
      }

      // Step 1: Submit — 任务 ID 就是我们发送的 X-Api-Request-Id（响应 body 官方规定为空）
      const requestId = crypto.randomUUID();
      try {
        const { status, headers: resHeaders, text: respText } = await this.nodeRequest(
          "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
          requestBody,
          {
            "x-api-key": apiKey,
            "X-Api-Resource-Id": resourceId,
            "X-Api-Request-Id": requestId,
            "X-Api-Sequence": "-1",
            "Content-Type": "application/json",
          },
        );

        const statusCode = resHeaders["x-api-status-code"] || "";
        if (status !== 200 || (statusCode && statusCode !== "20000000")) {
          throw new Error(
            `火山引擎 ASR 提交失败 (HTTP ${status}, x-api-status-code=${statusCode})\n` +
            `响应: ${respText.substring(0, 300) || "(空)"}`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("火山引擎")) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`火山引擎 ASR 提交请求失败 (resource_id=${resourceId}): ${msg}`);
      }

      // Step 2: 轮询直到完成 (最多 4 分钟)
      let utterances: Array<Record<string, unknown>> = [];
      let lastQueryText = "";
      let pollCount = 0;
      for (; pollCount < 120; pollCount++) {
        await this.sleep(2000);

        try {
          const { status: qStatus, headers: qHeaders, data: qData, text: qText } = await this.nodeRequest(
            "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
            {},
            {
              "x-api-key": apiKey,
              "X-Api-Resource-Id": resourceId,
              "X-Api-Request-Id": requestId,
              "Content-Type": "application/json",
            },
          );
          lastQueryText = qText;

          const qStatusCode = qHeaders["x-api-status-code"] || "";
          if (qStatus !== 200 || (qStatusCode && qStatusCode !== "20000000" && qStatusCode !== "20000001" && qStatusCode !== "20000002")) {
            throw new Error(`火山引擎 ASR 查询失败 (HTTP ${qStatus}, x-api-status-code=${qStatusCode})`);
          }

          // 20000000 = 成功, 20000001 = 处理中, 20000002 = 排队中
          if (qStatusCode === "20000000") {
            utterances = qData.result?.utterances || qData.utterances || [];
            // Fallback: 如果没有 utterances 但有 full text，构造一个段落
            if (utterances.length === 0) {
              const fullText = qData.result?.text || qData.text || "";
              if (fullText) {
                utterances = [{ text: fullText, start_time: 0, end_time: qData.audio_info?.duration || 0 }];
              }
            }
            break;
          }
          if (qStatusCode && qStatusCode !== "20000001" && qStatusCode !== "20000002") {
            throw new Error(`火山引擎 ASR 转写失败 (x-api-status-code=${qStatusCode})`);
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes("火山引擎")) throw err;
          // 轮询错误继续重试
        }
      }

      if (utterances.length === 0) {
        if (pollCount >= 120) {
          throw new Error(`火山引擎 ASR 任务超时 (requestId=${requestId}, 等待 4 分钟未完成)`);
        }
        // 无结果时输出调试信息
        const debugInfo = lastQueryText ? `\n> API 原始响应: \`${lastQueryText.substring(0, 500)}\`` : "";
        results.push({
          startTime: "00:00:00",
          endTime: "00:00:00",
          speaker: "",
          text: `（未检测到语音内容）${debugInfo}`,
        });
        continue;
      }

      // 收集所有出现的 speaker ID 并映射
      const speakerIds = new Set<string>();
      for (const seg of utterances) {
        const sid = (seg.speaker ?? seg.speaker_id ?? "") as string;
        if (sid) speakerIds.add(sid);
      }
      const speakerMap = new Map<string, string>();
      const sortedIds = Array.from(speakerIds).sort();
      sortedIds.forEach((sid, idx) => {
        speakerMap.set(sid, String(idx + 1));  // "0"→"1", "1"→"2"
      });
      const hasApiSpeakers = speakerMap.size >= 2;  // API 是否返回了多个说话人

      for (const seg of utterances) {
        const startMs = (seg.start_time ?? seg.start ?? 0) as number;
        const endMs = (seg.end_time ?? seg.end ?? 0) as number;
        const rawSpeaker = (seg.speaker ?? seg.speaker_id ?? "") as string;
        // 暂时存储原始字母代号，runSpeakerDiarization 会转换为 "说话人X"
        results.push({
          startTime: this.msToTimestamp(startMs),
          endTime: this.msToTimestamp(endMs),
          speaker: rawSpeaker ? `__ASR__${speakerMap.get(rawSpeaker) || rawSpeaker}` : "",
          text: (seg.text as string)?.trim() || "",
        });
      }
    }
    return results;
  }

  // ---- 阿里云 DashScope Fun-ASR (异步提交+轮询, 使用原生 Node HTTPS) ----
  private async callAliyunDashScopeASR(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    if (!apiKey) throw new Error("请配置阿里云 DashScope API Key");

    const submitUrl = config.apiUrl || "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
    const model = config.model || "fun-asr-flash-2026-06-15";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      // Step 1: 提交任务
      let taskId: string;
      try {
        const { status, data, text: respText } = await this.nodeRequest(
          submitUrl,
          {
            model,
            input: { file_urls: [url] },
            parameters: {
              channel_id: [0],
              language_hints: [config.language || "zh"],
            },
          },
          {
            "Authorization": `Bearer ${apiKey}`,
            "X-DashScope-Async": "enable",
            "Content-Type": "application/json",
          },
        );

        if (status !== 200) {
          // 解析阿里云错误码
          let errMsg = `阿里云 DashScope 提交失败 (HTTP ${status})\n音频URL: ${url}\n响应: ${respText.substring(0, 500)}`;
          try {
            const errData = JSON.parse(respText);
            if (errData.code === "Arrearage") {
              errMsg = "阿里云 DashScope 账户欠费，请前往阿里云百炼平台充值。";
            } else if (errData.message) {
              errMsg = `阿里云错误 [${errData.code}]: ${errData.message}\n音频URL: ${url}`;
            }
          } catch {}
          throw new Error(errMsg);
        }

        taskId = data.output?.task_id;
        if (!taskId) {
          throw new Error(
            `提交任务失败 (无 task_id): ${respText.substring(0, 500)}`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("阿里云")) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`阿里云 DashScope 提交失败: ${msg}`);
      }

      // Step 2: 轮询直到完成 (最多 6 分钟)
      const queryUrl = `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`;
      let transcriptionUrl = "";
      let pollCount = 0;
      let lastQueryData: Record<string, unknown> = {};

      for (; pollCount < 180; pollCount++) {
        await this.sleep(2000);

        try {
          const { data: qData } = await this.nodeRequest(
            queryUrl,
            {},
            {
              "Authorization": `Bearer ${apiKey}`,
              "X-DashScope-Async": "enable",
            },
            "GET",
          );
          lastQueryData = qData as Record<string, unknown>;
        } catch {
          continue;
        }

        const output = lastQueryData.output as Record<string, unknown> | undefined;
        const taskStatus: string = String(output?.task_status || "");
        if (taskStatus === "SUCCEEDED") {
          const resultList = (output?.results || []) as Array<Record<string, unknown>>;
          if (resultList.length > 0) {
            transcriptionUrl = String(resultList[0].transcription_url || "");
          }
          break;
        }
        if (taskStatus === "FAILED") {
          throw new Error(
            `阿里云 DashScope 转写失败: ${JSON.stringify(lastQueryData).substring(0, 500)}`,
          );
        }
      }

      if (pollCount >= 180) {
        throw new Error(`阿里云 DashScope 任务超时 (taskId=${taskId}, 等待 6 分钟未完成)`);
      }

      if (!transcriptionUrl) {
        results.push({
          startTime: "00:00:00",
          endTime: "00:00:00",
          speaker: "",
          text: `（未检测到语音内容）\n> API 响应: \`${JSON.stringify(lastQueryData).substring(0, 500)}\``,
        });
        continue;
      }

      // Step 3: 获取转写结果 (OSS URL, 无需鉴权)
      let transcriptData: Record<string, unknown>;
      try {
        const { data: tData, text: tText } = await this.nodeRequest(
          transcriptionUrl,
          {},
          {},
          "GET",
        );
        transcriptData = tData as Record<string, unknown>;
        if (!transcriptData || Object.keys(transcriptData).length === 0) {
          throw new Error(`转写结果为空: ${tText.substring(0, 300)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`阿里云 DashScope 获取转写结果失败: ${msg}`);
      }

      // Step 4: 解析 sentences
      const transcriptList = (transcriptData.transcripts || []) as Array<Record<string, unknown>>;
      if (transcriptList.length === 0) {
        results.push({
          startTime: "00:00:00",
          endTime: "00:00:00",
          speaker: "",
          text: `（转写结果为空）\n> 数据: \`${JSON.stringify(transcriptData).substring(0, 500)}\``,
        });
        continue;
      }

      const speakerIds = new Set<string>();
      const allSentences: Array<Record<string, unknown>> = [];
      for (const ch of transcriptList) {
        const sentences: Array<Record<string, unknown>> = (ch.sentences || []) as Array<Record<string, unknown>>;
        for (const s of sentences) {
          const sid = String(s.speaker_id ?? "");
          if (sid) speakerIds.add(sid);
          allSentences.push(s);
        }
      }

      const speakerMap = new Map<string, string>();
      Array.from(speakerIds).sort().forEach((sid, idx) => {
        speakerMap.set(sid, String(idx + 1));
      });

      for (const s of allSentences) {
        const beginMs = (s.begin_time ?? 0) as number;
        const endMs = (s.end_time ?? 0) as number;
        const rawSpeaker = String(s.speaker_id ?? "");
        results.push({
          startTime: this.msToTimestamp(beginMs),
          endTime: this.msToTimestamp(endMs),
          speaker: rawSpeaker ? `__ASR__${speakerMap.get(rawSpeaker) || rawSpeaker}` : "",
          text: (s.text as string)?.trim() || "",
        });
      }
    }
    return results;
  }

  // ---- 讯飞录音文件转写大模型 (上传+轮询) ----
  private async callXunfeiASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    const secretKey = config.secretKey || "";
    const appId = config.appId || "";
    if (!apiKey || !secretKey || !appId) throw new Error("请配置讯飞 APPID、APIKey、APISecret");

    const baseUrl = config.apiUrl || "https://office-api-ist-dx.iflyaisol.com";
    const fs = require("fs");
    const results: TranscriptSegment[] = [];

    for (const pathOrUrl of mp3Urls) {
      // Step 1: 读取音频二进制（vault 相对路径需转为绝对路径）
      let audioBuffer: Buffer;
      const resolvedPath = pathOrUrl.startsWith("http") ? pathOrUrl
        : pathOrUrl.startsWith("/") ? pathOrUrl
        : `${this.vaultBasePath}/${pathOrUrl}`;
      try {
        audioBuffer = fs.readFileSync(resolvedPath);
      } catch (e) {
        if (pathOrUrl.startsWith("http")) {
          const resp = await requestUrl({ url: pathOrUrl, method: "GET" });
          audioBuffer = Buffer.from(resp.arrayBuffer);
        } else {
          throw new Error(`无法读取音频文件: ${resolvedPath} (${(e as Error).message})`);
        }
      }

      // Step 2: 上传音频 → 获取 orderId
      const fileName = pathOrUrl.split("/").pop()?.split("?")[0] || "audio.mp3";
      const fileSize = String(audioBuffer.length);
      const xunfeiLang = this.mapXunfeiLanguage(config.language);
      const uploadParams = this.buildXunfeiParams(appId, apiKey);
      uploadParams.fileSize = fileSize;
      uploadParams.fileName = fileName;
      uploadParams.language = xunfeiLang;
      uploadParams.durationCheckDisable = "true";
      uploadParams.audioMode = "fileStream";
      if (hotWords.length > 0) {
        uploadParams.hotWord = hotWords.map((h) => h.word).join("|");
      }
      // 计算签名 (signature 不参与签名计算)
      const uploadSignature = this.xunfeiSign(secretKey, uploadParams);
      // signature 通过请求头传递，不出现在 URL 参数中
      const uploadQs = Object.entries(uploadParams)
        .map(([k, v]) => `${k}=${this.urlEncodeJava(String(v))}`).join("&");
      const uploadUrl = `${baseUrl}/v2/upload?${uploadQs}`;

      const { status: upStatus, data: upData, text: upText } = await this.nodePostBinary(
        uploadUrl, audioBuffer, {
          "Content-Type": "application/octet-stream",
          "signature": uploadSignature,
        },
      );

      if (upStatus !== 200) {
        throw new Error(`讯飞上传失败 HTTP ${upStatus}: ${upText.substring(0, 500)}`);
      }

      const content = upData.content || upData;
      const orderId = content.orderId;
      if (!orderId) {
        // 调试: 打印签名 base string
        const debugParams = { ...uploadParams };
        const debugBase = Object.keys(debugParams).sort()
          .filter(k => debugParams[k])
          .map(k => `${k}=${this.urlEncodeJava(debugParams[k])}`).join("&");
        throw new Error(
          `讯飞上传失败 (无 orderId): ${upText.substring(0, 500)}\n` +
          `signature=${uploadSignature?.substring(0, 20)}...\n` +
          `baseString=${debugBase.substring(0, 200)}`,
        );
      }

      // Step 3: 轮询查询转写结果 (最多 10 分钟)
      let pollCount = 0;
      let orderResult = "";
      let lastPollError = "";
      for (; pollCount < 300; pollCount++) {
        await this.sleep(2000);

        const queryParams = this.buildXunfeiParams(appId, apiKey);
        queryParams.orderId = orderId;
        queryParams.resultType = "transfer";
        const querySignature = this.xunfeiSign(secretKey, queryParams);
        const queryQs = Object.entries(queryParams)
          .map(([k, v]) => `${k}=${this.urlEncodeJava(String(v))}`).join("&");
        const queryUrl = `${baseUrl}/v2/getResult?${queryQs}`;

        const { status: qStatus, data: qData, text: qText } = await this.nodeRequest(
          queryUrl, {}, {
            "Content-Type": "application/json",
            "signature": querySignature,
          },
        );

        if (qStatus !== 200) {
          lastPollError = `HTTP ${qStatus}: ${qText.substring(0, 200)}`;
          continue;
        }

        const qContent = qData.content || qData;
        const status_ = qContent.orderInfo?.status;
        if (status_ === 4) {
          orderResult = qContent.orderResult || "";
          break;
        }
        if (status_ === -1 || qContent.orderInfo?.failType > 0) {
          throw new Error(`讯飞转写失败: ${qText.substring(0, 500)}`);
        }
        // status 0/3 → 继续轮询
      }

      if (pollCount >= 300) {
        throw new Error(
          `讯飞任务超时 (orderId=${orderId}, 等待 10 分钟未完成)` +
          (lastPollError ? ` | 最后轮询: ${lastPollError}` : ""),
        );
      }

      if (!orderResult) {
        results.push({
          startTime: "00:00:00", endTime: "00:00:00", speaker: "",
          text: `（未检测到语音内容）`,
        });
        continue;
      }

      // Step 4: 解析转写结果 (lattice / json_1best 格式)
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(orderResult);
      } catch {
        parsed = {};
      }

      // 讯飞 lattice 格式: lattice[].json_1best → st.rt[].ws[].cw[].w
      const lattice: Array<Record<string, unknown>> = (parsed.lattice || []) as Array<Record<string, unknown>>;
      const allWords: Array<{ text: string; beginMs: number; endMs: number }> = [];

      for (const lat of lattice) {
        const json1best = (lat.json_1best || "") as string;
        if (!json1best) continue;
        let rtData: Record<string, unknown>;
        try { rtData = JSON.parse(json1best); } catch { continue; }
        const st = (rtData.st || {}) as Record<string, unknown>;
        const rt: Array<Record<string, unknown>> = (st.rt || []) as Array<Record<string, unknown>>;
        for (const r of rt) {
          const ws: Array<Record<string, unknown>> = (r.ws || []) as Array<Record<string, unknown>>;
          for (const w of ws) {
            const cw: Array<Record<string, unknown>> = (w.cw || []) as Array<Record<string, unknown>>;
            const wordText = cw.map((c) => String(c.w || "")).join("");
            if (!wordText) continue;
            allWords.push({
              text: wordText,
              beginMs: Number(w.wb || 0),
              endMs: Number(w.we || 0),
            });
          }
        }
      }

      if (allWords.length === 0) {
        results.push({
          startTime: "00:00:00", endTime: "00:00:00", speaker: "",
          text: `（转写结果为空）\n> 原始数据: \`${orderResult.substring(0, 500)}\``,
        });
        continue;
      }

      // 将词语按标点或停顿合并成句子
      const punctuation = new Set(["。", "！", "？", "，", "、", ".", "!", "?", ","]);
      let currentSentence = "";
      let sentenceBegin = allWords[0].beginMs;
      let sentenceEnd = allWords[0].endMs;

      for (let i = 0; i < allWords.length; i++) {
        const w = allWords[i];
        currentSentence += w.text;
        sentenceEnd = w.endMs;

        // 遇到标点或大于 1 秒的停顿 → 结束当前句子
        const isPause = i < allWords.length - 1 &&
          (allWords[i + 1].beginMs - w.endMs) > 1000;
        const isPunctEnding = punctuation.has(w.text);

        if ((isPunctEnding || isPause || i === allWords.length - 1) && currentSentence.trim()) {
          results.push({
            startTime: this.msToTimestamp(sentenceBegin),
            endTime: this.msToTimestamp(sentenceEnd),
            speaker: "",
            text: currentSentence.trim(),
          });
          currentSentence = "";
          if (i < allWords.length - 1) {
            sentenceBegin = allWords[i + 1].beginMs;
          }
        }
      }
    }
    return results;
  }

  /** 构建讯飞签名参数 */
  private buildXunfeiParams(appId: string, apiKey: string): Record<string, string> {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const tz = `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}${String(Math.abs(offset) % 60).padStart(2, "0")}`;
    const dateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}${tz}`;
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let random = "";
    for (let i = 0; i < 16; i++) random += chars[Math.floor(Math.random() * chars.length)];
    return { appId, accessKeyId: apiKey, dateTime, signatureRandom: random };
  }

  /** Java URLEncoder.encode 兼容编码 (空格→+, 不编码*-._) */
  private urlEncodeJava(val: string): string {
    return encodeURIComponent(val)
      .replace(/%20/g, "+")
      .replace(/[!'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  }

  /** 映射语言代码到讯飞格式 */
  private mapXunfeiLanguage(lang: string): string {
    if (!lang || lang === "auto") return "autodialect";
    if (lang.startsWith("zh")) return "autodialect";
    if (lang.startsWith("en")) return "autominor";
    return "autodialect";
  }

  /** 讯飞 HMAC-SHA1 签名 */
  private xunfeiSign(secret: string, params: Record<string, string>): string {
    const crypto = require("crypto");
    const sorted = Object.keys(params).filter((k) => k !== "signature").sort();
    const parts: string[] = [];
    for (const key of sorted) {
      const val = params[key];
      if (val) parts.push(`${key}=${this.urlEncodeJava(val)}`);
    }
    const hmac = crypto.createHmac("sha1", secret);
    hmac.update(parts.join("&"));
    return hmac.digest("base64");
  }

  /** 原生 HTTPS POST 二进制 body */
  private nodePostBinary(
    urlStr: string, body: Buffer, headers: Record<string, string>,
  ): Promise<{ status: number; data: any; text: string }> {
    const https = require("https");
    const { URL } = require("url");
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": String(body.length) },
      }, (res: any) => {
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let data: any = {};
          try { data = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode || 0, data, text: chunks });
        });
      });
      req.on("error", (e: Error) => reject(e));
      req.write(body);
      req.end();
    });
  }

  // ---- 腾讯云 ASR (TC3-HMAC-SHA256 签名 + 提交/轮询) ----
  private sha256Hex(data: string): string {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(data, "utf8").digest("hex");
  }

  private hmacSha256Hex(key: Buffer | string, data: string): Buffer {
    const crypto = require("crypto");
    return crypto.createHmac("sha256", key).update(data, "utf8").digest();
  }

  /** 腾讯云 API 3.0 签名 (TC3-HMAC-SHA256) */
  private tencentSign(
    secretId: string, secretKey: string, action: string, payload: string, region: string,
  ): Record<string, string> {
    const service = "asr";
    const host = "asr.tencentcloudapi.com";
    const version = "2019-06-14";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const algorithm = "TC3-HMAC-SHA256";

    // 1. Canonical Request
    const canonicalURI = "/";
    const canonicalQueryString = "";
    const canonicalHeaders = `content-type:application/json\nhost:${host}\n`;
    const signedHeaders = "content-type;host";
    const hashedPayload = this.sha256Hex(payload);
    const canonicalRequest = `POST\n${canonicalURI}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

    // 2. String to Sign
    const date = new Date(Number(timestamp) * 1000).toISOString().split("T")[0];
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = this.sha256Hex(canonicalRequest);
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

    // 3. Signature
    const kDate = this.hmacSha256Hex(`TC3${secretKey}`, date);
    const kService = this.hmacSha256Hex(kDate, service);
    const kSigning = this.hmacSha256Hex(kService, "tc3_request");
    const signature = this.hmacSha256Hex(kSigning, stringToSign).toString("hex");

    // 4. Authorization header
    const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      "Authorization": authorization,
      "Content-Type": "application/json",
      "X-TC-Action": action,
      "X-TC-Version": version,
      "X-TC-Timestamp": timestamp,
      "X-TC-Region": region,
    };
  }

  private async callTencentASR(
    mp3Urls: string[], config: ASRConfig, hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const secretId = config.apiKey || "";
    const secretKey = config.secretKey || "";
    if (!secretId || !secretKey) throw new Error("请配置腾讯云 SecretId 和 SecretKey");

    const endpoint = config.apiUrl || "https://asr.tencentcloudapi.com";
    const engineModel = config.model || "16k_zh";
    const region = "ap-guangzhou";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      // Step 1: 提交识别任务
      const submitBody: Record<string, unknown> = {
        EngineModelType: engineModel,
        ChannelNum: 1,
        ResTextFormat: 3,
        SourceType: 0,
        Url: url,
        SpeakerDiarization: config.enableSpeakerDiarization ? 1 : 0,
      };
      if (hotWords.length > 0) {
        submitBody.HotwordList = hotWords.map((h) => `${h.word}|${h.weight || 5}`).join(",");
      }
      const submitPayload = JSON.stringify(submitBody);
      const submitHeaders = this.tencentSign(secretId, secretKey, "CreateRecTask", submitPayload, region);

      const { status: subStatus, data: subData, text: subText } = await this.nodeRequest(
        endpoint, JSON.parse(submitPayload), submitHeaders,
      );

      if (subStatus !== 200) {
        throw new Error(`腾讯云 ASR 提交失败 HTTP ${subStatus}: ${subText.substring(0, 500)}`);
      }

      const response = subData.Response;
      if (response.Error) {
        throw new Error(`腾讯云 API 错误 [${response.Error.Code}]: ${response.Error.Message}`);
      }

      const taskId: number = response.Data?.TaskId;
      if (!taskId) {
        throw new Error(`腾讯云提交失败 (无 TaskId): ${subText.substring(0, 500)}`);
      }

      // Step 2: 轮询查询结果 (最多 6 分钟)
      let pollCount = 0;
      let resultStr = "";
      let resultDetail: any[] | null = null;
      for (; pollCount < 180; pollCount++) {
        await this.sleep(2000);

        const queryPayload = JSON.stringify({ TaskId: taskId });
        const queryHeaders = this.tencentSign(secretId, secretKey, "DescribeTaskStatus", queryPayload, region);

        const { status: qStatus, data: qData, text: qText } = await this.nodeRequest(
          endpoint, JSON.parse(queryPayload), queryHeaders,
        );

        if (qStatus !== 200) continue;

        const qResponse = qData.Response;
        if (qResponse.Error) continue;

        const taskStatus = qResponse.Data?.Status;
        if (taskStatus === 2) {
          resultStr = qResponse.Data?.Result || "";
          resultDetail = qResponse.Data?.ResultDetail || null;
          break;
        }
        if (taskStatus === 3) {
          throw new Error(`腾讯云转写失败 (TaskId=${taskId}): ${qResponse.Data?.ErrorMsg || qText.substring(0, 300)}`);
        }
        // 0=等待中, 1=处理中 → 继续轮询
      }

      if (pollCount >= 180) {
        throw new Error(`腾讯云任务超时 (TaskId=${taskId}, 等待 6 分钟未完成)`);
      }

      if (!resultStr) {
        results.push({
          startTime: "00:00:00", endTime: "00:00:00", speaker: "",
          text: `（未检测到语音内容）`,
        });
        continue;
      }

      // Step 3: 解析结果 (ResultDetail 是 SentenceDetail 数组)
      const sentenceList: any[] = resultDetail || [];
      if (sentenceList.length === 0) {
        // 兜底: 使用 Result 纯文本作为整体输出
        const plainText = (resultStr || "").trim();
        if (plainText) {
          results.push({
            startTime: "00:00:00", endTime: "00:00:00", speaker: "",
            text: plainText,
          });
        } else {
          results.push({
            startTime: "00:00:00", endTime: "00:00:00", speaker: "",
            text: `（转写结果为空）`,
          });
        }
        continue;
      }

      const speakerIds = new Set<string>();
      for (const s of sentenceList) {
        const sid = s.SpeakerId;
        if (sid !== undefined && sid !== null && sid !== -1) speakerIds.add(String(sid));
      }
      const speakerMap = new Map<string, string>();
      Array.from(speakerIds).sort().forEach((sid, idx) => {
        speakerMap.set(sid, String(idx + 1));
      });

      for (const s of sentenceList) {
        const beginMs = (s.StartMs || s.BeginTime || 0) as number;
        const endMs = (s.EndMs || s.EndTime || 0) as number;
        const rawSpeaker = s.SpeakerId !== undefined && s.SpeakerId !== -1 ? String(s.SpeakerId) : "";
        const text = String(s.FinalSentence || s.WrittenText || s.Text || "").trim();
        if (!text) continue;
        results.push({
          startTime: this.msToTimestamp(beginMs),
          endTime: this.msToTimestamp(endMs),
          speaker: rawSpeaker ? `__ASR__${speakerMap.get(rawSpeaker) || rawSpeaker}` : "",
          text,
        });
      }
    }
    return results;
  }

  // ---- 百度云 ASR (OAuth access_token + 提交/轮询) ----
  private async callBaiduASR(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const apiKey = config.apiKey || "";
    const secretKey = config.secretKey || "";
    const appId = config.appId || "";
    if (!apiKey || !secretKey) throw new Error("请配置百度云 API Key 和 Secret Key");

    const pid = config.model || "80001";
    const format = this.detectAudioFormat(mp3Urls[0] || "");
    const results: TranscriptSegment[] = [];

    // Step 1: 获取 access_token
    const tokenUrl = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;

    let accessToken: string;
    try {
      const { data: tokenData, text: tokenText } = await this.nodeRequest(
        tokenUrl, {}, { "Content-Type": "application/json" },
      );
      accessToken = tokenData.access_token;
      if (!accessToken) {
        throw new Error(`获取百度 access_token 失败: ${tokenText.substring(0, 300)}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("百度")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`百度云 OAuth 鉴权失败: ${msg}`);
    }

    for (const url of mp3Urls) {
      // Step 2: 提交转写任务
      const submitBody: Record<string, unknown> = {
        speech_url: url,
        format,
        rate: 16000,
        pid: Number(pid),
      };

      const { data: subData, text: subText } = await this.nodeRequest(
        `https://aip.baidubce.com/rpc/2.0/aasr/v1/create?access_token=${accessToken}`,
        submitBody,
        { "Content-Type": "application/json" },
      );

      // 成功时直接返回 task_id（无 error_code），失败时有 error_code + error_msg
      if (subData.error_code && subData.error_code !== 0) {
        throw new Error(
          `百度云 ASR 提交失败 [error_code=${subData.error_code}]: ${subData.error_msg || subText.substring(0, 300)}`,
        );
      }

      const taskId: string = subData.task_id;
      if (!taskId) {
        throw new Error(`百度云提交失败 (无 task_id): ${subText.substring(0, 500)}`);
      }

      // Step 3: 轮询查询结果 (最多 10 分钟)
      let pollCount = 0;
      let taskResult: Record<string, unknown> | null = null;
      for (; pollCount < 300; pollCount++) {
        await this.sleep(2000);

        const { data: qData } = await this.nodeRequest(
          `https://aip.baidubce.com/rpc/2.0/aasr/v1/query?access_token=${accessToken}`,
          { task_ids: [taskId] },
          { "Content-Type": "application/json" },
        );

        if (qData.error_code && qData.error_code !== 0) continue;

        const tasksInfo: Array<Record<string, unknown>> = qData.tasks_info || [];
        if (tasksInfo.length === 0) continue;

        const info = tasksInfo[0];
        const taskStatus: string = String(info.task_status || "");

        if (taskStatus === "Success") {
          taskResult = (info.task_result || {}) as Record<string, unknown>;
          break;
        }
        if (taskStatus === "Failed") {
          throw new Error(
            `百度云转写失败 (taskId=${taskId}): ${JSON.stringify(info).substring(0, 500)}`,
          );
        }
        // "Running" / "Created" → 继续轮询
      }

      if (pollCount >= 300) {
        throw new Error(`百度云任务超时 (taskId=${taskId}, 等待 10 分钟未完成)`);
      }

      if (!taskResult) {
        results.push({
          startTime: "00:00:00", endTime: "00:00:00", speaker: "",
          text: `（未检测到语音内容）`,
        });
        continue;
      }

      // Step 4: 解析结果
      // detailed_result: [{res: ["文本"], begin_time: ms, end_time: ms}, ...]
      // result: ["全文文本1", "全文文本2"] (兜底)
      const detailedResult: Array<Record<string, unknown>> = (taskResult.detailed_result || []) as Array<Record<string, unknown>>;

      if (detailedResult.length === 0) {
        // 兜底: 使用 result 纯文本
        const resultArr: string[] = (taskResult.result || []) as string[];
        const fullText = resultArr.join("\n").trim();
        if (fullText) {
          results.push({
            startTime: "00:00:00", endTime: "00:00:00", speaker: "",
            text: fullText,
          });
        } else {
          results.push({
            startTime: "00:00:00", endTime: "00:00:00", speaker: "",
            text: `（转写结果为空）\n> 原始数据: \`${JSON.stringify(taskResult).substring(0, 500)}\``,
          });
        }
        continue;
      }

      for (const s of detailedResult) {
        const beginMs = (s.begin_time || 0) as number;
        const endMs = (s.end_time || 0) as number;
        const resArr: string[] = (s.res || []) as string[];
        const text = resArr.join("").trim();
        if (!text) continue;
        results.push({
          startTime: this.msToTimestamp(beginMs),
          endTime: this.msToTimestamp(endMs),
          speaker: "",
          text,
        });
      }
    }
    return results;
  }

  // ---- 华为云 SIS (SDK-HMAC-SHA256 签名 + 提交/轮询) ----
  private huaweiSign(
    ak: string, sk: string, method: string, path: string, query: string, body: string, baseUrl: string,
  ): Record<string, string> {
    const crypto = require("crypto");
    const { URL } = require("url");
    const algorithm = "SDK-HMAC-SHA256";
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    const hours = String(now.getUTCHours()).padStart(2, "0");
    const min = String(now.getUTCMinutes()).padStart(2, "0");
    const sec = String(now.getUTCSeconds()).padStart(2, "0");
    const timestamp = `${year}${month}${day}T${hours}${min}${sec}Z`;
    const host = new URL(baseUrl).hostname;

    // SDK: 路径各段 URL 编码，末尾强制加 "/"
    let canonicalURI = path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
    if (!canonicalURI.endsWith("/")) canonicalURI += "/";

    const signedHeaders = "content-type;host;x-sdk-date";
    const emptyBodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const hashedBody = body ? crypto.createHash("sha256").update(body, "utf8").digest("hex") : emptyBodyHash;

    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-sdk-date:${timestamp}\n`;
    const canonicalRequest = [
      method,
      canonicalURI,
      query,
      canonicalHeaders,
      signedHeaders,
      hashedBody,
    ].join("\n");

    const hashedCanonicalRequest = crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
    const stringToSign = [algorithm, timestamp, hashedCanonicalRequest].join("\n");

    const signature = crypto.createHmac("sha256", sk).update(stringToSign, "utf8").digest("hex");
    const authorization = `${algorithm} Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      "Authorization": authorization,
      "X-Sdk-Date": timestamp,
      "host": host,
      "Content-Type": "application/json",
    };
  }

  private async callHuaweiASR(
    mp3Urls: string[], config: ASRConfig, _hotWords: { word: string; weight?: number }[],
  ): Promise<TranscriptSegment[]> {
    const ak = config.apiKey || "";
    const sk = config.secretKey || "";
    const projectId = config.appId || "";
    if (!ak || !sk || !projectId) throw new Error("请配置华为云 Access Key、Secret Key 和 Project ID");

    const baseUrl = config.apiUrl || "https://sis-ext.cn-north-4.myhuaweicloud.com";
    const property = config.model || "chinese_16k_conversation";
    const results: TranscriptSegment[] = [];

    for (const url of mp3Urls) {
      const format = this.detectAudioFormat(url);

      // Step 1: 提交识别任务
      const submitPath = `/v1/${projectId}/asr/transcriber/jobs`;
      const submitBody = JSON.stringify({
        config: {
          audio_format: "auto",
          property,
          add_punc: "yes",
        },
        data_url: url,
      });

      const submitHeaders = this.huaweiSign(ak, sk, "POST", submitPath, "", submitBody, baseUrl);

      const { status: subStatus, data: subData, text: subText } = await this.nodeRequest(
        `${baseUrl}${submitPath}`, JSON.parse(submitBody), submitHeaders,
      );

      if (subStatus !== 200) {
        throw new Error(`华为云 SIS 提交失败 HTTP ${subStatus}: ${subText.substring(0, 500)}`);
      }

      if (subData.error_code) {
        throw new Error(`华为云 SIS 错误 [${subData.error_code}]: ${subData.error_msg || subText.substring(0, 300)}`);
      }

      const jobId: string = subData.job_id;
      if (!jobId) {
        throw new Error(`华为云提交失败 (无 job_id): ${subText.substring(0, 500)}`);
      }

      // Step 2: 轮询查询结果 (最多 10 分钟)
      let pollCount = 0;
      let segments: Array<Record<string, unknown>> = [];
      for (; pollCount < 300; pollCount++) {
        await this.sleep(2000);

        const queryPath = `/v1/${projectId}/asr/transcriber/jobs/${jobId}`;
        const queryHeaders = this.huaweiSign(ak, sk, "GET", queryPath, "", "", baseUrl);

        const { status: qStatus, data: qData, text: qText } = await this.nodeRequest(
          `${baseUrl}${queryPath}`, {}, queryHeaders, "GET",
        );

        if (qStatus !== 200) continue;

        const taskStatus: string = String(qData.status || "");
        if (taskStatus === "FINISHED") {
          segments = (qData.segments || []) as Array<Record<string, unknown>>;
          break;
        }
        if (taskStatus === "ERROR") {
          throw new Error(`华为云转写失败 (jobId=${jobId}): ${qText.substring(0, 500)}`);
        }
        // WAITING → 继续轮询
      }

      if (pollCount >= 300) {
        throw new Error(`华为云任务超时 (jobId=${jobId}, 等待 10 分钟未完成)`);
      }

      if (segments.length === 0) {
        results.push({
          startTime: "00:00:00", endTime: "00:00:00", speaker: "",
          text: `（未检测到语音内容）`,
        });
        continue;
      }

      for (const seg of segments) {
        const startMs = (seg.start_time || 0) as number;
        const endMs = (seg.end_time || 0) as number;
        const result = (seg.result || {}) as Record<string, unknown>;
        const text = String(result.text || "").trim();
        if (!text) continue;
        // 华为云 role 字段 (agent/user) 可用于区分说话人
        const analysisInfo = (result.analysis_info || {}) as Record<string, unknown>;
        const role = String(analysisInfo.role || "");
        const speakerLabel = role === "agent" ? "客服" : role === "user" ? "用户" : "";
        results.push({
          startTime: this.msToTimestamp(startMs),
          endTime: this.msToTimestamp(endMs),
          speaker: speakerLabel ? `__ASR__${speakerLabel}` : "",
          text,
        });
      }
    }
    return results;
  }

  // 映射语言代码到火山引擎格式
  private mapVolcLanguage(lang: string): string {
    const map: Record<string, string> = {
      "zh": "zh-CN",
      "en": "en-US",
      "ja": "ja-JP",
      "ko": "ko-KR",
      "yue": "yue-CN",
      "fr": "fr-FR",
      "de": "de-DE",
      "es": "es-ES",
      "auto": "zh-CN",   // 默认中文
    };
    return map[lang] || lang;
  }

  // 从 URL/路径 检测音频格式
  private detectAudioFormat(url: string): string {
    const lower = url.toLowerCase();
    if (lower.endsWith(".mp3")) return "mp3";
    if (lower.endsWith(".wav")) return "wav";
    if (lower.endsWith(".m4a")) return "m4a";
    if (lower.endsWith(".flac")) return "flac";
    if (lower.endsWith(".ogg")) return "ogg";
    if (lower.endsWith(".aac")) return "aac";
    if (lower.endsWith(".webm")) return "webm";
    return "mp3"; // 默认
  }

  // ---- 说话人分离 ----
  private async runSpeakerDiarization(
    segments: TranscriptSegment[],
    config: SpeakerDiarizationConfig,
    voiceprintLibrary: { id: string; name: string; audioSamplePath?: string }[],
    audioFilePaths: string[],
  ): Promise<TranscriptSegment[]> {
    // Step 1: 分配初始说话人标签
    // ASR 自带说话人 → 直接使用；否则启用时始终用内置分离（无论 modelType）
    // custom 模式 = 内置分离 + 声纹服务识别；builtin 模式 = 仅内置分离
    let labeled: TranscriptSegment[];
    const hasAsrSpeakers = segments.some((s) => s.speaker.startsWith("__ASR__"));

    if (hasAsrSpeakers) {
      labeled = segments.map((s) => {
        if (s.speaker.startsWith("__ASR__")) {
          const code = s.speaker.replace("__ASR__", "");
          return { ...s, speaker: `speaker_${code}` };
        }
        return { ...s, speaker: s.speaker || "" };
      });
    } else if (config.enabled) {
      // 内置启发式分离说话人（builtin 和 custom 模式都需要先分离）
      labeled = this.builtinSpeakerDiarization(segments);
    } else {
      labeled = segments.map((s) => ({ ...s, speaker: s.speaker || "" }));
    }

    // Step 2: 调用声纹识别服务匹配真实人名
    const shouldRunVoiceprint = config.enabled
      && config.autoVoiceprint
      && config.customEndpoint;

    if (shouldRunVoiceprint) {
      // 优先用传入的本地路径，云端ASR场景下回退到上次下载的本地路径
      let localPaths = this.resolveLocalAudioPaths(audioFilePaths);
      if (localPaths.length === 0 && this.lastDownloadedPaths.length > 0) {
        localPaths = this.resolveLocalAudioPaths(this.lastDownloadedPaths);
      }
      if (localPaths.length > 0 && voiceprintLibrary.some((v) => v.audioSamplePath)) {
        try {
          labeled = await this.callVoiceprintService(labeled, config, voiceprintLibrary, localPaths);
        } catch (e) {
          console.warn("声纹识别服务调用失败:", e);
        }
      }
    }

    // Step 3: 声纹库 id→name 映射 (对未通过声纹服务匹配的标签做兜底)
    if (voiceprintLibrary.length > 0) {
      labeled = labeled.map((s) => {
        const vp = voiceprintLibrary.find((v) => v.id === s.speaker);
        return vp ? { ...s, speaker: vp.name } : s;
      });
    }

    // Step 4: 将内部 speaker_N 格式转为友好显示名
    labeled = labeled.map((s) => {
      const m = s.speaker.match(/^speaker_(\d+)$/);
      if (m) return { ...s, speaker: `说话人${m[1]}` };
      return s;
    });

    return labeled;
  }

  /** 启发式说话人分离 (最多 4 人) */
  private builtinSpeakerDiarization(segments: TranscriptSegment[]): TranscriptSegment[] {
    let currentSpeaker = 0;
    const speakerNames = ["1", "2", "3", "4"];
    let consecutiveCount = 0;
    return segments.map((s, i) => {
      if (i > 0) {
        const prevText = segments[i - 1].text || "";
        const currText = s.text || "";
        const prevEndsPunct = /[。？！?！\.]$/.test(prevText.trim());
        const prevEndSec = this.timestampToSeconds(segments[i - 1].endTime || "00:00:00");
        const currStartSec = this.timestampToSeconds(s.startTime || "00:00:00");
        const gap = currStartSec - prevEndSec;
        const lenRatio = Math.max(currText.length, 1) / Math.max(prevText.length, 1);
        const prevIsQuestion = /[？?]$/.test(prevText.trim());
        const currStartsConversational = /^(我|你|那|这|嗯|啊|哦|不|对|是|好|可|但|就|也|还|都)/.test(currText.trim());

        const shouldSwitch = prevEndsPunct || gap > 1.0 || lenRatio > 2.5 ||
          lenRatio < 0.4 || consecutiveCount > 2 || prevIsQuestion ||
          (currStartsConversational && gap > 0.3);

        if (shouldSwitch) {
          currentSpeaker = (currentSpeaker + 1) % speakerNames.length;
          consecutiveCount = 0;
        }
      }
      consecutiveCount++;
      return { ...s, speaker: `speaker_${speakerNames[currentSpeaker]}` };
    });
  }

  /** 过滤出本地音频路径 */
  private resolveLocalAudioPaths(paths: string[]): string[] {
    return paths
      .filter((p) => p && !p.startsWith("http://") && !p.startsWith("https://"))
      .map((p) => p.startsWith("/") ? p : `${this.vaultBasePath}/${p}`);
  }

  /** 调用声纹识别服务 (CAM++ voiceprint_api.py) */
  private async callVoiceprintService(
    segments: TranscriptSegment[],
    config: SpeakerDiarizationConfig,
    voiceprintLibrary: { id: string; name: string; audioSamplePath?: string }[],
    localAudioPaths: string[],
  ): Promise<TranscriptSegment[]> {
    const baseUrl = config.customEndpoint!.replace(/\/$/, "");
    const endpoint = `${baseUrl}/v1/speaker/identify`;

    // 按 speaker 分组时间片段
    const speakerGroups = new Map<string, { starts: number[]; ends: number[] }>();
    for (const seg of segments) {
      const spk = seg.speaker || "unknown";
      if (!speakerGroups.has(spk)) {
        speakerGroups.set(spk, { starts: [], ends: [] });
      }
      const group = speakerGroups.get(spk)!;
      group.starts.push(this.timestampToSeconds(seg.startTime));
      group.ends.push(this.timestampToSeconds(seg.endTime));
    }

    const speakerSegments = Array.from(speakerGroups.entries()).map(([speakerId, group]) => ({
      speaker_id: speakerId,
      starts: group.starts,
      ends: group.ends,
    }));

    // 声纹库: 转换 vault 相对路径为绝对路径
    const vpLibrary = voiceprintLibrary
      .filter((v) => v.audioSamplePath)
      .map((v) => ({
        name: v.name,
        audio_path: v.audioSamplePath!.startsWith("/")
          ? v.audioSamplePath!
          : `${this.vaultBasePath}/${v.audioSamplePath}`,
      }));

    if (vpLibrary.length === 0) return segments;

    // 确保声纹样本已在声纹识别服务中注册
    const enrollUrl = `${baseUrl}/v1/speaker/enroll`;
    for (const vp of vpLibrary) {
      try {
        const params = `name=${encodeURIComponent(vp.name)}&audio_path=${encodeURIComponent(vp.audio_path)}`;
        await this.httpJsonPost(`${enrollUrl}?${params}`, {}, {});
      } catch {
        // 注册失败不阻塞流程
      }
    }

    const { data } = await this.httpJsonPost(endpoint, {
      audio_file: localAudioPaths[0],
      speaker_segments: speakerSegments,
      voiceprint_library: vpLibrary,
    }, config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {});

    if (data.error) {
      throw new Error(`声纹识别服务错误: ${data.error}`);
    }

    const labels: Record<string, string> = data.labels || {};
    return segments.map((s) => {
      const name = labels[s.speaker];
      return name && name !== "未知说话人" ? { ...s, speaker: name } : s;
    });
  }

  /** HTTP JSON POST (支持 localhost) */
  private httpJsonPost(
    urlStr: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; data: any; text: string }> {
    const { URL } = require("url");
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const http = require(isHttps ? "https" : "http");
    const bodyStr = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          ...extraHeaders,
        },
      }, (res: any) => {
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let respData: any = {};
          try { respData = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode || 0, data: respData, text: chunks });
        });
      });
      req.on("error", (e: Error) => reject(e));
      req.write(bodyStr);
      req.end();
    });
  }

  /** HTTP GET (支持 localhost) */
  private httpGet(
    urlStr: string,
  ): Promise<{ status: number; data: any }> {
    const { URL } = require("url");
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const http = require(isHttps ? "https" : "http");
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
      }, (res: any) => {
        let chunks = "";
        res.on("data", (d: string) => { chunks += d; });
        res.on("end", () => {
          let respData: any = {};
          try { respData = JSON.parse(chunks); } catch {}
          resolve({ status: res.statusCode || 0, data: respData });
        });
      });
      req.on("error", (e: Error) => reject(e));
      req.end();
    });
  }

  /** 检测声纹识别服务是否可连接 */
  async checkVoiceprintService(endpoint: string): Promise<boolean> {
    if (!endpoint) return false;
    try {
      const baseUrl = endpoint.replace(/\/$/, "");
      const { status, data } = await this.httpGet(`${baseUrl}/v1/speaker/list`);
      return status === 200 && Array.isArray(data.speakers);
    } catch {
      return false;
    }
  }

  // ---- LLM 总结 ----
  private async runLLMSummarization(
    transcript: TranscriptSegment[],
    config: LLMConfig,
    template: SummaryTemplate,
  ): Promise<{ summary: string; keywords: string[]; actionItems: string[] }> {
    const transcriptText = transcript
      .map((s) => `[${s.startTime}] ${s.speaker}: ${s.text}`)
      .join("\n\n");

    const systemPrompt = template.systemPrompt;
    const userPrompt = `请根据以下转录内容生成总结:\n\n${transcriptText}`;

    let summaryText = "";

    switch (config.provider) {
      case "anthropic":
        summaryText = await this.callAnthropic(config, systemPrompt, userPrompt);
        break;
      case "openai":
      case "zhipu":
      case "deepseek":
      case "minimax":
      case "google":
      case "aliyun":
      case "baidu":
      case "bytedance":
      case "tencent":
      case "huawei":
      case "moonshot":
      case "xunfei":
      case "mistral":
      case "meta":
      case "custom":
        if (config.apiFormat === "anthropic") {
          summaryText = await this.callAnthropic(config, systemPrompt, userPrompt);
        } else {
          summaryText = await this.callOpenAICompatible(config, systemPrompt, userPrompt);
        }
        break;
      default:
        throw new Error(`不支持的 LLM 提供商: ${config.provider}`);
    }

    // 提取关键词
    const keywords = await this.extractKeywords(summaryText, config);
    // 提取行动项
    const actionItems = this.extractActionItems(summaryText);

    return { summary: summaryText, keywords, actionItems };
  }

  private async callAnthropic(
    config: LLMConfig,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    let url = config.apiUrl || "https://api.anthropic.com/v1/messages";
    if (!url.endsWith("/messages")) {
      url = url.replace(/\/$/, "") + "/v1/messages";
    }
    const isOfficialAnthropic = url.includes("api.anthropic.com");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (isOfficialAnthropic) {
      headers["x-api-key"] = config.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
    const resp = await requestUrl({
      url,
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model || "claude-haiku-3-5-sonnet",
        max_tokens: config.maxTokens || 4096,
        temperature: config.temperature ?? 0.7,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      const body = typeof resp.json === "object" ? JSON.stringify(resp.json) : String(resp.text || "");
      throw new Error(`LLM 请求失败 [${url}] HTTP ${resp.status}: ${body.substring(0, 500)}`);
    }

    return resp.json.content?.[0]?.text || resp.json.choices?.[0]?.message?.content || "";
  }

  private async callOpenAICompatible(
    config: LLMConfig,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    let url = config.apiUrl || "https://api.openai.com/v1/chat/completions";
    if (!url.endsWith("/chat/completions")) {
      url = url.replace(/\/$/, "") + "/chat/completions";
    }
    const resp = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model || "gpt-4o-mini",
        max_tokens: config.maxTokens || 4096,
        temperature: config.temperature ?? 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      const body = typeof resp.json === "object" ? JSON.stringify(resp.json) : String(resp.text || "");
      throw new Error(`LLM 请求失败 [${url}] HTTP ${resp.status}: ${body.substring(0, 500)}`);
    }

    return resp.json.choices?.[0]?.message?.content || "";
  }

  /** AI 聊天: 使用配置的 LLM 回答问题 */
  async callLLM(
    config: LLMConfig,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    switch (config.provider) {
      case "anthropic":
        return this.callAnthropic(config, systemPrompt, userPrompt);
      case "custom":
        if (config.apiFormat === "anthropic") {
          return this.callAnthropic(config, systemPrompt, userPrompt);
        }
        return this.callOpenAICompatible(config, systemPrompt, userPrompt);
      default:
        return this.callOpenAICompatible(config, systemPrompt, userPrompt);
    }
  }

  /** 公开的声纹比对接口 (供 UI 一键比对使用) */
  async matchVoiceprints(
    audioFilePath: string,
    speakerSegments: Array<{ speaker_id: string; starts: number[]; ends: number[] }>,
    voiceprintLibrary: VoiceprintEntry[],
    endpoint: string,
    apiKey?: string,
  ): Promise<Record<string, string>> {
    const baseUrl = endpoint.replace(/\/$/, "");

    // 预处理声纹库：转换 vault 相对路径为绝对路径
    const vpLibrary = voiceprintLibrary
      .filter((v) => v.audioSamplePath)
      .map((v) => {
        const absPath = v.audioSamplePath!.startsWith("/")
          ? v.audioSamplePath!
          : `${this.vaultBasePath}/${v.audioSamplePath}`;
        return { name: v.name, audio_path: absPath };
      });

    if (vpLibrary.length === 0) {
      throw new Error("声纹库中没有带样本音频的说话人");
    }

    // 确保声纹样本已在声纹识别服务中注册
    const enrollUrl = `${baseUrl}/v1/speaker/enroll`;
    for (const vp of vpLibrary) {
      try {
        const params = `name=${encodeURIComponent(vp.name)}&audio_path=${encodeURIComponent(vp.audio_path)}`;
        await this.httpJsonPost(`${enrollUrl}?${params}`, {}, {});
      } catch {
        // 注册失败不阻塞流程，identify 接口也可直接从 audio_path 提取
      }
    }

    // 调用识别接口
    const absoluteAudio = audioFilePath.startsWith("/") ? audioFilePath : `${this.vaultBasePath}/${audioFilePath}`;
    const identifyUrl = `${baseUrl}/v1/speaker/identify`;

    const headers: Record<string, string> = apiKey
      ? { "Authorization": `Bearer ${apiKey}` }
      : {};

    const { data } = await this.httpJsonPost(identifyUrl, {
      audio_file: absoluteAudio,
      speaker_segments: speakerSegments,
      voiceprint_library: vpLibrary,
    }, headers);

    if (data.error) {
      throw new Error(`声纹识别服务错误: ${data.error}`);
    }

    const labels: Record<string, string> = data.labels || {};
    const allUnknown = Object.values(labels).every((n) => n === "未知说话人");
    if (allUnknown && Object.keys(labels).length > 0) {
      throw new Error(
        `声纹识别服务未能匹配任何说话人。\n`
        + `请检查: 1) 声纹样本音频路径是否正确 2) 声纹服务中模型是否正常加载 3) 原音频文件是否存在`,
      );
    }

    return labels;
  }

  /** 仅执行转写 + 说话人分离（跳过下载和 LLM 总结），供 "重新转写" 使用 */
  async transcribeOnly(
    audioPaths: string[],
    asrConfig: ASRConfig,
    speakerConfig: SpeakerDiarizationConfig,
    voiceprintLibrary: VoiceprintEntry[],
    hotWords: Array<{ word: string; weight?: number }>,
  ): Promise<TranscriptSegment[]> {
    const rawTranscript = await this.runASR(audioPaths, asrConfig, hotWords);
    const transcript = await this.runSpeakerDiarization(
      rawTranscript, speakerConfig, voiceprintLibrary, audioPaths,
    );
    this.lastTranscript = transcript;
    return transcript;
  }

  /** 仅执行 LLM 总结（跳过下载和 ASR），供 "重新总结" 使用 */
  async summarizeOnly(
    transcript: TranscriptSegment[],
    llmConfig: LLMConfig,
    templateType: TemplateType,
    customPrompt?: string,
  ): Promise<{ summary: string; keywords: string[]; actionItems: string[] }> {
    let template = getTemplate(templateType);
    if (templateType === "custom" && customPrompt) {
      template = {
        type: "custom",
        name: "自定义模板",
        description: "用户自定义 Prompt",
        systemPrompt: customPrompt,
        outputFormat: "",
      };
    }
    if (!template) throw new Error("未找到指定的总结模板");
    this.lastTranscript = transcript;
    return this.runLLMSummarization(transcript, llmConfig, template);
  }

  /** 用 ffmpeg 从音频中截取片段 (供提取声纹样本使用) */
  cutAudioSegment(
    audioPath: string,
    startSec: number,
    durationSec: number,
    outputPath: string,
  ): void {
    const { execSync } = require("child_process");
    const absPath = audioPath.startsWith("/") ? audioPath : `${this.vaultBasePath}/${audioPath}`;
    execSync(
      `ffmpeg -y -i "${absPath}" -ss ${startSec} -t ${durationSec} -ar 16000 -ac 1 -sample_fmt s16 "${outputPath}"`,
      { stdio: "pipe", timeout: 15000 },
    );
  }

  private async extractKeywords(text: string, config: LLMConfig): Promise<string[]> {
    // 简单提取 — 匹配中文/英文关键词模式
    const keywords = new Set<string>();
    const patterns = [
      /\*\*([^*]+)\*\*/g,           // **关键词**
      /关键词[：:]\s*([^\n]+)/g,    // 关键词：xxx
      /`([^`]+)`/g,                 // `keyword`
    ];
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        const parts = m[1].split(/[,，、;；]/);
        for (const p of parts) {
          const trimmed = p.trim();
          if (trimmed.length > 0 && trimmed.length < 50) {
            keywords.add(trimmed);
          }
        }
      }
    }
    return Array.from(keywords).slice(0, 20);
  }

  private extractActionItems(text: string): string[] {
    const items: string[] = [];
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- [ ]") || trimmed.startsWith("- []")) {
        items.push(trimmed.replace(/^-\s*\[?\s*\]?\s*/, ""));
      }
      if (trimmed.startsWith("待办") || trimmed.startsWith("TODO") || trimmed.startsWith("任务")) {
        const content = trimmed.replace(/^(待办事项?|TODO|任务)[：:]\s*/, "");
        if (content) items.push(content);
      }
    }
    return items;
  }

  // ---- 工具方法 ----
  private msToTimestamp(totalMs: number): string {
    return this.secondsToTimestamp(totalMs / 1000);
  }

  private secondsToTimestamp(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  private calcDuration(segments: TranscriptSegment[]): number {
    if (segments.length === 0) return 0;
    const last = segments[segments.length - 1];
    const match = last.endTime.match(/(\d+):(\d+):(\d+)/);
    if (match) {
      return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
    }
    return segments.length * 5; // 估算
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
