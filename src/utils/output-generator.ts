import type { TranscriptionResult, TranscriptSegment, SummaryTemplate } from "../types";

/**
 * 生成最终输出文档: 总结 + 转录原文(区分说话人)
 */
export function generateOutput(
  result: TranscriptionResult,
  template: SummaryTemplate,
  sourceTitle: string,
  asrModelName?: string,
  audioUrls?: string[],
): string {
  const date = formatDate(new Date());
  const speakers = getUniqueSpeakers(result.transcript);
  const speakerList = speakers.join("、") || "未知";

  let output = "";

  // ====== LLM 生成的结构化总结 ======
  output += result.summary
    .replace(/\{标题\}/g, sourceTitle)
    .replace(/\{日期\}/g, date)
    .replace(/\{发言人列表\}/g, speakerList);

  output += "\n\n---\n\n";

  // ====== 关键词和行动项 ======
  if (result.keywords.length > 0) {
    output += "## 关键词\n\n";
    output += result.keywords.map((k) => `\`${k}\``).join("  ");
    output += "\n\n";
  }

  if (result.actionItems.length > 0) {
    output += "## 行动项\n\n";
    for (const item of result.actionItems) {
      output += `- [ ] ${item}\n`;
    }
    output += "\n";
  }

  output += "---\n\n";

  // ====== 元数据 ======
  output += "## 转录信息\n\n";
  output += `- **时长**：${formatDuration(result.duration)}\n`;
  output += `- **语言**：${result.language}\n`;
  if (asrModelName) {
    output += `- **ASR 引擎**：${asrModelName}\n`;
  }
  output += `- **说话人数**：${result.speakerCount}\n`;
  output += `- **生成模板**：${template.name}\n`;
  output += `- **生成时间**：${date}\n`;
  if (audioUrls && audioUrls.length > 0) {
    for (const u of audioUrls) {
      if (u.startsWith("http")) {
        output += `- **原始音频**：${u}\n`;
      }
    }
  }
  output += "\n---\n\n";

  // ====== 转录原文 (区分说话人) ======
  output += "## 转录原文\n\n";

  for (const segment of result.transcript) {
    // 统一为 HH:MM:SS 格式
    const startFull = segment.startTime.length <= 5
      ? `00:${segment.startTime}`
      : segment.startTime;
    const speaker = segment.speaker || "未知";
    output += `**[${startFull}] ${speaker}：** ${segment.text}\n\n`;
  }

  return output;
}

function getUniqueSpeakers(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>();
  for (const s of segments) {
    if (s.speaker && !seen.has(s.speaker)) {
      seen.add(s.speaker);
    }
  }
  return Array.from(seen);
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}时${m}分${s}秒`;
  }
  if (m > 0) {
    return `${m}分${s}秒`;
  }
  return `${s}秒`;
}
