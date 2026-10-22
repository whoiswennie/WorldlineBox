/** Decode only the native tool's known text envelopes. Unknown and mixed-media
 * receipts stay literal; the original payload is always retained verbatim. */
export function memoryToolPresentation(raw: string): { text: string; decoded: boolean } {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: raw, decoded: false };
    const envelope = value as Record<string, unknown>;
    let result: unknown;
    if (envelope.status === 'success') result = envelope.result;
    else if (!('status' in envelope) && Array.isArray(envelope.content)) result = envelope;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return { text: raw, decoded: false };
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content) || !content.length || !content.every(block => block && typeof block === 'object'
      && !Array.isArray(block) && block.type === 'text' && typeof block.text === 'string')) return { text: raw, decoded: false };
    return { text: content.map(block => (block as { text: string }).text).join('\n\n'), decoded: true };
  } catch { return { text: raw, decoded: false }; }
}

/** Native score zero and negative zero are both real values. */
export function nativeMemoryScore(value: number, digits = 4): string {
  return (Object.is(value, -0) ? '-' : '') + value.toFixed(digits);
}

export function memoryDisplayTitle(value: string, limit = 160): string {
  if (value.length <= limit) return value;
  let end = limit; if (/[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
  return value.slice(0, end) + '…';
}

/** Display only: retain the original excerpt separately as retrieval evidence. */
export function readableMemoryExcerpt(value: string): string {
  const anchor = /^<!-- WorldlineBoxMemory:[a-f0-9]{64} -->\r?$(?:\r?\n)?/gmu;
  if (!anchor.test(value)) return value;
  return value.replace(anchor, '').replace(/^\[\d{4}-\d{2}-\d{2}\] - [^\r\n]*\r?\n(?:\[\d{2}:\d{2}:\d{2}\]\r?\n)?/u, '')
    .replace(/\r?\nTag: [^\r\n]*$/u, '');
}

export type MemoryToolSourceBlock = { source: string; relevance: string; path?: string; author?: string; date?: string; time?: string; tags: string[]; body: string };
/** Recognize the unchanged LightMemo formatter, then present its metadata in
 * dedicated fields. Ambiguous or future formats remain available as literal text. */
export function memoryToolSourceBlocks(text: string): MemoryToolSourceBlock[] | undefined {
  if (!text.trimStart().startsWith('[--- LightMemo 轻量回忆 ---]') || !text.trimEnd().endsWith('[--- 回忆结束 ---]')) return;
  const totals = [...text.matchAll(/^\[找到 (\d+) 条相关记忆片段:\]\r?$/gmu)];
  const ends = [...text.matchAll(/^\[--- 回忆结束 ---\]\r?$/gmu)];
  const entries = [...text.matchAll(/^--- \(来源: ([^\r\n]*), 相关性: ([^\r\n]*)\)\r?$/gmu)];
  if (totals.length !== 1 || ends.length !== 1 || !entries.length || entries.length > 12 || Number(totals[0]![1]) !== entries.length) return;
  if (entries[0]!.index! < totals[0]!.index! || entries.at(-1)!.index! > ends[0]!.index!) return;
  return entries.map((entry, index) => {
    const content = text.slice(entry.index! + entry[0].length + 1, entries[index + 1]?.index ?? ends[0]!.index).replace(/(?:\r?\n)+$/u, '');
    const lines = content.split(/\r?\n/u); let cursor = 0;
    const path = /^\s*\[路径: ([^\r\n]*)\]$/u.exec(lines[cursor] ?? ''); if (path) cursor++;
    if (/^\s*\[RiverMemo Topology V3: [^\r\n]*\]$/u.test(lines[cursor] ?? '')) cursor++;
    const dated = /^\[(\d{4}-\d{2}-\d{2})\] - (.*)$/u.exec(lines[cursor] ?? ''); if (dated) cursor++;
    const timed = /^\[(\d{2}:\d{2}:\d{2})\]$/u.exec(lines[cursor] ?? ''); if (timed) cursor++;
    if (/^<!-- WorldlineBoxMemory:(?:[a-f0-9]{40}|[a-f0-9]{64}) -->$/u.test(lines[cursor] ?? '')) cursor++;
    const tagLine = /^Tag: (.*)$/u.exec(lines.at(-1) ?? ''); const bodyEnd = tagLine ? lines.length - 1 : lines.length;
    return { source: entry[1]!, relevance: entry[2]!, ...(path ? { path: path[1]! } : {}), ...(dated ? { date: dated[1]!, author: dated[2]! } : {}), ...(timed ? { time: timed[1]! } : {}),
      tags: tagLine ? tagLine[1]!.split(',').map(tag => tag.trim()).filter(Boolean) : [], body: lines.slice(cursor, bodyEnd).join('\n') };
  });
}

/** Comparison only; no path from recalled text is ever opened directly. */
export function memorySourcePathKey(value: string): string {
  let path = value;
  if (/^file:\/\//iu.test(path)) { path = path.slice('file://'.length); try { path = decodeURIComponent(path); } catch { return ''; } }
  path = path.replaceAll('\\', '/').replace(/^\/+\?\//u, '').replace(/^\?\//u, '').replace(/^\/+(?=[A-Za-z]:\/)/u, '').replace(/^\/{2,}/u, '/');
  return /^[A-Za-z]:\//u.test(path) ? path.toLowerCase() : path;
}
