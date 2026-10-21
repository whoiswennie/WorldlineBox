import type { BrowserAgentMessage } from './agent-model';
export const browserAgentTextBytes = (text: string, limit: number): string => {
  if (Buffer.byteLength(text) <= limit) return text;
  return new TextDecoder().decode(Buffer.from(text).subarray(0, Math.max(0, limit - 60))).replace(/\uFFFD$/, '') + '\n[内容已截断，可通过分页工具继续读取]';
};
/** Conservative estimate for mixed Latin/CJK text, including protocol/schema text. */
export function estimateBrowserAgentTokens(value: string): number {
  let ascii = 0, other = 0;
  for (const character of value) { if (character.codePointAt(0)! < 128) ascii++; else other += 2; }
  return Math.ceil(ascii / 3) + other;
}
/** Remove only complete call/result groups. Never emit an orphan native tool result. */
export function compactBrowserAgentHistory(messages: readonly BrowserAgentMessage[], limit: number, previousSummary = '', unit: 'bytes' | 'tokens' = 'bytes'): {
  messages: BrowserAgentMessage[]; summary: string; removed: number; changed: boolean;
} {
  const measure = (text: string) => unit === 'tokens' ? estimateBrowserAgentTokens(text) : Buffer.byteLength(text);
  // Large contexts usually fit. Avoid cloning every evidence payload on every
  // model/tool round, and leave the earlier summary untouched when no work is needed.
  if (measure(JSON.stringify(messages)) <= limit) return { messages: [...messages], summary: previousSummary, removed: 0, changed: false };
  const retained: BrowserAgentMessage[] = structuredClone([...messages]); const removed: BrowserAgentMessage[] = [];
  const size = () => measure(JSON.stringify(retained));
  // First shorten large evidence payloads while retaining the native action and
  // its result. The source cache can supply the full body again by stable ID.
  if (size() > limit) for (const message of retained) {
    if (message.role !== 'tool' || Buffer.byteLength(message.text) <= 1800) continue;
    try {
      const value = JSON.parse(message.text);
      const excerpt = (item: unknown) => {
        if (!item || typeof item !== 'object') return String(item).slice(0, 200);
        const data = item as Record<string, unknown>;
        return { id: data.id, tabId: data.tabId, sourceId: data.sourceId, url: data.url, title: data.title, kind: data.kind, error: data.error, success: data.success, denied: data.denied,
          clicked: data.clicked, filled: data.filled, selected: data.selected, truncated: data.truncated, total: data.total, offset: data.offset,
          ...(Array.isArray(data.elements) ? { elements: data.elements.slice(0, 16), elementCount: data.elementCount, elementOffset: data.elementOffset,
            elementsCompacted: data.elements.length > 16, note: 'Query browser_observe for relevant controls; these grounded refs are from the actual observation.' } : {}),
          excerpt: String(data.content || data.text || data.snippet || '').slice(0, 350), contentCompacted: true };
      };
      message.text = JSON.stringify(Array.isArray(value) ? value.slice(0, 8).map(excerpt) : excerpt(value));
    } catch { message.text = browserAgentTextBytes(message.text, 1200); }
  }
  while (retained.length > 1 && size() > limit) {
    const nextUser = retained.findIndex((message, index) => index > 0 && message.role === 'user');
    if (nextUser > 0) { removed.push(...retained.splice(0, nextUser)); continue; }
    // Retain the current request, and discard a whole older assistant/tool pair.
    const assistant = retained.findIndex((message, index) => index > 0 && message.role === 'assistant');
    if (assistant < 0) break;
    let end = assistant + 1; while (retained[end]?.role === 'tool') end++;
    if (end === retained.length) break;
    removed.push(...retained.splice(assistant, end - assistant));
  }
  if (size() > limit) {
    for (const message of retained) {
      if (message.role === 'tool') message.text = browserAgentTextBytes(message.text, Math.max(700, Math.floor(limit / Math.max(2, retained.length))));
    }
  }
  const extract = removed.map(message => message.role === 'tool' ? `executed tool ${message.name}: ${browserAgentTextBytes(message.text, 450)}` : `${message.role}: ${browserAgentTextBytes(message.text, 700)}`).join('\n');
  return { messages: retained, summary: extract ? browserAgentTextBytes([previousSummary.slice(-600), extract].filter(Boolean).join('\n').slice(-2400), 2800) : previousSummary,
    removed: removed.length, changed: JSON.stringify(retained) !== JSON.stringify(messages) };
}
