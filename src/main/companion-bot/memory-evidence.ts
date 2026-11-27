import { createHash } from 'node:crypto';

export interface BotMemoryCitation {
  /** Host reference identity. This is not a VCP chunk ID. */
  id: string;
  requestId: string;
  text: string;
  origin: 'vcp-rag-result' | 'vcp-system-fallback' | 'vcp-system-snapshot' | 'vcp-onering-history';
  eventIndex?: number;
  resultIndex?: number;
  messageIndex?: number;
  source?: string;
  date?: string;
  score?: number;
  fullPath?: string;
  sourceFile?: string;
  senderName?: string;
  frontendSource?: string;
  role?: 'user' | 'assistant';
  referenceOnly?: true;
}
export interface BotMemoryCitations {
  citations: BotMemoryCitation[];
  coverage: { basis: 'vcp-rag-broadcast' | 'system-fallback' | 'one-ring-history' | 'none'; broadcastEvents: number; broadcastMaxPerEvent?: 20; internalCandidates: 'not-exposed';
    ragResults?: number; oneRingHistory?: number; systemSnapshots?: number; systemMaterial?: 'unclassified-not-memory-facts';
    supplementaryReferences?: Array<{ id: string; origin: BotMemoryCitation['origin']; referenceOnly: true }>; supplementaryReferencesOmitted?: number };
}
export interface BotMemoryCitationPage {
  citationId: string; requestId: string; origin: BotMemoryCitation['origin'];
  offset: number; nextOffset: number | null; offsetUnit: 'utf16'; totalChars: number; totalBytes: number; text: string;
  source?: string; date?: string; score?: number; fullPath?: string; sourceFile?: string;
  senderName?: string; frontendSource?: string; role?: 'user' | 'assistant'; referenceOnly?: true;
  metadataOmitted?: string[];
}
type Row = Record<string, unknown>;
const DEFAULT_BYTES = 4096;
const row = (value: unknown): Row | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const prefix = (requestId: string) => 'host-memory-' + createHash('sha256').update(requestId).digest('hex').slice(0, 24) + '-';
const budgetError = () => Object.assign(new Error('记忆证据预算不足以容纳完整引用信封。'), { code: 'MEMORY_EVIDENCE_BUDGET_TOO_SMALL' });
function budget(value: number | undefined): number {
  const size = value ?? DEFAULT_BYTES;
  if (!Number.isSafeInteger(size) || size < 1) throw new TypeError('Memory evidence maxBytes must be a positive safe integer');
  return size;
}
function sourceFields(value: Row): Pick<BotMemoryCitation, 'source' | 'date' | 'score' | 'fullPath' | 'sourceFile' | 'senderName' | 'frontendSource' | 'role' | 'referenceOnly'> {
  const output: ReturnType<typeof sourceFields> = {};
  for (const field of ['source', 'date', 'fullPath', 'sourceFile', 'senderName', 'frontendSource'] as const) if (typeof value[field] === 'string') output[field] = value[field];
  if (typeof value.score === 'number' && Number.isFinite(value.score)) output.score = value.score;
  if (value.role === 'user' || value.role === 'assistant') output.role = value.role;
  if (value.referenceOnly === true) output.referenceOnly = true;
  return output;
}
function systemText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.flatMap(part => {
    const item = row(part); return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n') : '';
}
/** At most a small prefix is allocated even when the stored original is large. */
function points(text: string, maximum: number): string[] {
  let end = Math.min(text.length, maximum);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  return Array.from(text.slice(0, end));
}
function fittingPrefix(text: string, maximum: number, fits: (prefix: string) => boolean): string | undefined {
  if (!fits('')) return undefined;
  const characters = points(text, maximum);
  let lower = 0, upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fits(characters.slice(0, middle).join(''))) lower = middle; else upper = middle - 1;
  }
  return characters.slice(0, lower).join('');
}
function omitLargeMetadata<T extends { source?: string; date?: string; fullPath?: string; sourceFile?: string; senderName?: string; frontendSource?: string; metadataOmitted?: string[] }>(value: T, fits: () => boolean): void {
  for (const field of ['fullPath', 'sourceFile', 'source', 'date', 'senderName', 'frontendSource'] as const) {
    if (fits()) return;
    if (value[field] === undefined) continue;
    delete value[field]; (value.metadataOmitted ??= []).push(field);
  }
}

/** Project genuine passive VCP output without reranking, summarizing or changing
 * retrieval. Exact full text and returned source fields remain in citations for
 * durable, authorized follow-up reads. The broadcast exposes at most 20 results
 * per event, and does not expose original chunk IDs or every scoring field. */
export function buildBotMemoryCitations(input: { requestId: string; messages: readonly unknown[]; events: readonly unknown[]; injectedHistory?: readonly unknown[] }): BotMemoryCitations {
  const citations: BotMemoryCitation[] = [];
  const citationPrefix = prefix(input.requestId);
  let broadcastEvents = 0;
  input.events.forEach((value, eventIndex) => {
    const event = row(value); if (event?.type !== 'RAG_RETRIEVAL_DETAILS') return;
    broadcastEvents++;
    if (!Array.isArray(event.results)) return;
    event.results.forEach((value, resultIndex) => {
      const result = row(value); if (!result || typeof result.text !== 'string') return;
      citations.push({ id: citationPrefix + `rag-${eventIndex}-${resultIndex}`, requestId: input.requestId,
        text: result.text, origin: 'vcp-rag-result', eventIndex, resultIndex, ...sourceFields(result) });
    });
  });
  const ragResults = citations.length;
  const transported = new Map<number, Row>();
  for (const item of input.injectedHistory ?? []) {
    const record = row(item), timeline = row(record?.timeline);
    if (record && typeof record.index === 'number' && Number.isSafeInteger(record.index) && timeline) transported.set(record.index, timeline);
  }
  // These private, non-enumerable marks are set by original OneRing only on
  // DB-injected conversation messages. Tail-tag text or recording metadata
  // alone cannot distinguish genuine injection from an ordinary quotation.
  input.messages.forEach((value, messageIndex) => {
    const message = row(value); if (!message || !['user', 'assistant'].includes(String(message.role))) return;
    const injected = Object.getOwnPropertyDescriptor(message, '__oneRingInjectedFromDb');
    const timeline = Object.getOwnPropertyDescriptor(message, '__oneRingTimelineMeta');
    const meta = transported.get(messageIndex) ?? (injected?.enumerable === false && injected.value === true && timeline?.enumerable === false ? row(timeline.value) : undefined);
    if (!meta || typeof meta.timestamp !== 'string') return;
    const text = systemText(message.content); if (!text) return;
    const id = citationPrefix + `onering-${messageIndex}`;
    const body = text.replace(/(?:\s*\[OneRing通知:[\s\S]*?于\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?发送于[^\]]*?(?:；这是一个新对话的起点)?\]\s*)+$/, '').trim();
    const referenceOnly = !body || /^\s*\[(?:系统提示|系统警告|系统指示)/.test(body);
    citations.push({ id, requestId: input.requestId, text, origin: 'vcp-onering-history', messageIndex,
      ...sourceFields({ ...meta, date: meta.timestamp, role: message.role }), ...(referenceOnly ? { referenceOnly: true } : {}) });
  });
  const oneRingHistory = citations.length - ragResults;
  input.messages.forEach((value, messageIndex) => {
    const message = row(value); if (message?.role !== 'system') return;
    const text = systemText(message.content); if (!text) return;
    citations.push({ id: citationPrefix + `system-${messageIndex}`, requestId: input.requestId,
      text, origin: broadcastEvents ? 'vcp-system-snapshot' : 'vcp-system-fallback', messageIndex,
      ...(broadcastEvents ? { referenceOnly: true } : {}) });
  });
  const snapshots = citations.filter(citation => citation.origin === 'vcp-system-snapshot' || citation.origin === 'vcp-system-fallback');
  const supplementary = citations.filter(citation => citation.origin === 'vcp-system-snapshot' || citation.origin === 'vcp-onering-history');
  const coverage: BotMemoryCitations['coverage'] = { basis: broadcastEvents ? 'vcp-rag-broadcast' : snapshots.length ? 'system-fallback' : oneRingHistory ? 'one-ring-history' : 'none',
    broadcastEvents, ...(broadcastEvents ? { broadcastMaxPerEvent: 20 as const } : {}), internalCandidates: 'not-exposed',
    ...(snapshots.length || oneRingHistory ? { ragResults, oneRingHistory, systemSnapshots: snapshots.length,
      ...(snapshots.length ? { systemMaterial: 'unclassified-not-memory-facts' as const } : {}),
      supplementaryReferences: supplementary.slice(0, 3).map(citation => ({ id: citation.id, origin: citation.origin, referenceOnly: true as const })),
      supplementaryReferencesOmitted: Math.max(0, supplementary.length - 3) } : {}) };
  return { citations, coverage };
}

/** Read an exact citation in bounded complete JSON pages. The caller still owns
 * current-event/audience authorization and source-withdrawal checks. Offsets
 * count UTF-16 units and never split a Unicode surrogate pair. */
export function readBotMemoryCitation(input: { requestId: string; citations: readonly BotMemoryCitation[]; citationId: string; offset?: number; maxBytes?: number }): BotMemoryCitationPage {
  const maximum = budget(input.maxBytes);
  const citation = input.citations.find(citation => citation.id === input.citationId && citation.requestId === input.requestId);
  if (!input.citationId.startsWith(prefix(input.requestId)) || !citation) throw Object.assign(new Error('当前记忆请求中没有这条引用。'), { code: 'MEMORY_CITATION_NOT_FOUND' });
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > citation.text.length
    || offset > 0 && /[\uD800-\uDBFF]/.test(citation.text[offset - 1] ?? '') && /[\uDC00-\uDFFF]/.test(citation.text[offset] ?? '')) throw new TypeError('Memory citation offset is not a valid UTF-16 boundary');
  const page: BotMemoryCitationPage = { citationId: citation.id, requestId: input.requestId, origin: citation.origin,
    offset, nextOffset: offset < citation.text.length ? offset : null, offsetUnit: 'utf16', totalChars: citation.text.length,
    totalBytes: Buffer.byteLength(citation.text, 'utf8'), ...sourceFields({ ...citation }), text: '' };
  omitLargeMetadata(page, () => bytes(page) <= maximum);
  const text = fittingPrefix(citation.text.slice(offset), maximum, value => {
    page.text = value; page.nextOffset = offset + value.length < citation.text.length ? offset + value.length : null; return bytes(page) <= maximum;
  });
  if (text === undefined || !text && offset < citation.text.length) throw budgetError();
  page.text = text; page.nextOffset = offset + text.length < citation.text.length ? offset + text.length : null;
  return page;
}
