/** Internal provenance envelopes are never narrative or embedding input. Only
 * this exact host format is recognized; ordinary JSON/code/IDs in prose survive. */
export function companionHistoryView(text: string): { content: string; version: number; title: string; tags: string[] } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (!match) return;
  try {
    const header = JSON.parse(match[1]!);
    if (header?.schema !== 'worldlinebox.companion-memory-history-v2' || !Number.isSafeInteger(header.contentRevision)
      || header.contentRevision < 1 || !header.memory || typeof header.memory !== 'object'
      || !/^[a-f0-9]{64}$/u.test(header.bodyHash) || header.id !== header.memory.id) return;
    const content = match[2]!, first = content.split(/\r?\n/u).find(line => line.trim()) ?? '记忆正文';
    return { content, version: header.contentRevision,
      title: first.replace(/^#{1,6}\s+|^[-*>]\s+/u, '').trim().slice(0, 80),
      tags: Array.isArray(header.memory.tags) ? header.memory.tags.filter((tag: unknown): tag is string => typeof tag === 'string').slice(0, 50) : [] };
  } catch { return; }
}
export function companionNarrativeText(text: string): string {
  return companionHistoryView(text)?.content ?? text;
}
