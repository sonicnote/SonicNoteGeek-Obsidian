import { TFile, Vault } from "obsidian";

/**
 * 从 Markdown 文本中提取 MP3 链接
 * 支持:
 *   - Markdown 链接: [音频](xxx.mp3)
 *   - 内嵌链接: ![[xxx.mp3]]
 *   - 裸 URL: https://...xxx.mp3
 *   - HTML audio: <audio src="xxx.mp3">
 *   - 附件文件夹中的 mp3 文件
 */
export function extractMp3Links(markdown: string): string[] {
  const links = new Set<string>();

  // 1. YAML frontmatter audio_url
  const yamlAudioRegex = /^audio_url:\s*["']?([^\s"'\n]+\.mp3)["']?\s*$/gim;
  for (const m of markdown.matchAll(yamlAudioRegex)) {
    links.add(m[1]);
  }

  // 2. Inline audio_url: key
  const inlineAudioRegex = /audio_url:\s*["']?([^\s"'\n,]+\.mp3)["']?/gi;
  for (const m of markdown.matchAll(inlineAudioRegex)) {
    links.add(m[1]);
  }

  // 3. Markdown 内嵌音频: ![[xxx.mp3]]
  const embedRegex = /!\[\[([^\]]+\.mp3)\]\]/gi;
  for (const m of markdown.matchAll(embedRegex)) {
    links.add(m[1]);
  }

  // 4. Markdown 链接: [text](xxx.mp3)
  const mdLinkRegex = /\[([^\]]*)\]\(([^)]+\.mp3)\)/gi;
  for (const m of markdown.matchAll(mdLinkRegex)) {
    links.add(m[2]);
  }

  // 5. 裸 HTTPS URL 指向 mp3
  const bareUrlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.mp3/gi;
  for (const m of markdown.matchAll(bareUrlRegex)) {
    links.add(m[0]);
  }

  // 6. HTML audio/iframe embed
  const htmlAudioRegex = /<audio[^>]+src=["']([^"']+\.mp3)["']/gi;
  for (const m of markdown.matchAll(htmlAudioRegex)) {
    links.add(m[1]);
  }

  // 7. Obsidian internal link: [[xxx.mp3]]
  const internalLinkRegex = /\[\[([^\]]+\.mp3)\]\]/gi;
  for (const m of markdown.matchAll(internalLinkRegex)) {
    if (!m[0].startsWith("!")) {
      links.add(m[1]);
    }
  }

  return Array.from(links);
}

/**
 * 从 Obsidian vault 中查找与 MP3 相关的附件
 */
export async function findMp3Attachments(vault: Vault, sourceFile: TFile): Promise<string[]> {
  const results: string[] = [];

  // 查找同一目录下或附件子目录下的 mp3 文件
  const parentPath = sourceFile.parent?.path ?? "";
  const files = vault.getFiles();

  for (const file of files) {
    if (file.extension === "mp3") {
      // 检查是否与源文件相关 (同目录或标准附件目录)
      const fileDir = file.parent?.path ?? "";
      if (fileDir === parentPath ||
          fileDir.startsWith(parentPath + "/") ||
          fileDir.includes("attachments") ||
          fileDir.includes("assets") ||
          fileDir.includes("音频")) {
        results.push(file.path);
      }
    }
  }

  return results;
}
