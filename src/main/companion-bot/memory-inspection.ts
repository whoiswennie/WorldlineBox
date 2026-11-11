import { memoryRecallDate } from '../../shared/memory-recall-date';
import type { BotMemoryRecallReport, BotMemoryRecallMode } from '../../shared/companion-bot-memory';

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const short = (value: unknown, maximum = 4000): string | undefined => typeof value === 'string' ? Array.from(value).slice(0, maximum).join('') : undefined;
const scoreKey = /(?:score|rank|bonus|omega|similarity|distance|weight|alpha|rrf)/iu;
const privateKey = /(?:api.?key|authorization|password|secret|authToken|headers)/iu;
const vectorKey = /^(?:vector|embedding|queryVector|originalVector|denoisedVector|localVector|transferVector|ghostVectors|nativeSupplementalVectors|supplementalQueryVectors)$/iu;

/** This is a bounded diagnostic view, never input to retrieval or a scorer.
 * Values and order come from VCP; omissions are explicit. Do not normalize a
 * BM25 score, vector similarity and RRF score onto an invented common scale. */
export function boundedMemoryDiagnostic(value: unknown): unknown {
  let remaining = 1800, remainingText = 18000;
  const visit = (current: unknown, depth: number, key = ''): unknown => {
    if (privateKey.test(key)) return '[redacted]';
    if (vectorKey.test(key)) return { omitted: 'embedding-vector' };
    if (--remaining < 0 || depth > 9) return { omitted: 'diagnostic-view-capacity' };
    if (current === null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (typeof current === 'string') {
      const capacity = Math.min(1800, Math.max(0, remainingText)); remainingText -= Math.min(current.length, capacity);
      return current.length > capacity ? { text: short(current, capacity), omitted: 'long-diagnostic-text' } : current;
    }
    if (Array.isArray(current)) return [...current.slice(0, 60).map(item => visit(item, depth + 1)), ...(current.length > 60 ? [{ omittedItems: current.length - 60 }] : [])];
    const object = row(current); if (!object) return null;
    const entries = Object.entries(object), result: Row = {};
    for (const [field, item] of entries.slice(0, 40)) result[field] = visit(item, depth + 1, field);
    if (entries.length > 40) result.omittedFields = entries.length - 40;
    return result;
  };
  return visit(value, 0);
}

function scores(value: Row): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const number = finite(item); if (scoreKey.test(key) && number !== undefined) output[key] = number;
  }
  const river = row(value.riverMemo);
  if (river) for (const [key, item] of Object.entries(river)) {
    const number = finite(item); if (scoreKey.test(key) && number !== undefined) output[`riverMemo.${key}`] = number;
  }
  return output;
}

export function buildBotMemoryInspection(input: { requestId: string; query: string; mode: BotMemoryRecallMode; totalMs: number;
  result: unknown; telemetry?: unknown; preparationMs?: number }): BotMemoryRecallReport {
  const result = row(input.result) ?? {}, telemetry = row(input.telemetry) ?? {};
  const trace = row(telemetry.vcp), chat = row(telemetry.chat), spans = [
    ...(Array.isArray(trace?.spans) ? trace.spans : []), ...(Array.isArray(chat?.spans) ? chat.spans : []),
  ].flatMap(value => row(value) ? [row(value)!] : []);
  let candidates: Row[] = [];
  if (input.mode === 'passive' && Array.isArray(result.events)) candidates = result.events.flatMap(value => {
    const event = row(value); return event?.type === 'RAG_RETRIEVAL_DETAILS' && Array.isArray(event.results)
      ? event.results.flatMap(value => row(value) ? [row(value)!] : []) : [];
  });
  if (input.mode === 'semantic') {
    // The formatter's actual final candidate input preserves richer original
    // scoring fields than its human-readable text. Never substitute an earlier
    // native candidate pool and call that the final result ranking.
    const final = [...spans].reverse().find(span => span.stage === 'lightmemo.final-candidates');
    const values = row(final?.input)?.candidates;
    if (Array.isArray(values)) candidates = values.flatMap(value => row(value) ? [row(value)!] : []);
  }
  const hits = candidates.slice(0, 60).map((candidate, index) => ({ rank: index + 1,
    text: short(candidate.text) ?? '', source: short(candidate.source ?? candidate.sourceFile ?? candidate.fullPath ?? candidate.dbName, 600),
    date: memoryRecallDate(candidate), score: finite(candidate.score), scores: scores(candidate),
  }));
  const stages = spans.slice(0, 120).map(span => ({ name: String(span.stage ?? 'unknown'),
    durationMs: finite(row(span.hostTiming)?.durationMs), status: String(span.status ?? 'not-provided'),
    source: short(span.source, 600), id: finite(span.id), parentId: finite(span.parentId) }));
  if (input.preparationMs !== undefined) stages.unshift({ name: 'host.context.prepare', durationMs: input.preparationMs, status: 'completed', source: 'WorldlineBox stopwatch', id: undefined, parentId: undefined });
  let evidence: string | undefined;
  if (typeof input.result === 'string') evidence = short(input.result, 24000);
  else if (typeof result.content === 'string') evidence = short(result.content, 24000);
  else if (Array.isArray(result.messages)) evidence = result.messages.flatMap(value => {
    const message = row(value); return message?.role === 'system' && typeof message.content === 'string' ? [message.content] : [];
  }).join('\n').slice(0, 24000);
  else evidence = short(JSON.stringify(input.result), 24000);
  const report: BotMemoryRecallReport = { requestId: input.requestId, query: input.query, mode: input.mode, createdAt: new Date().toISOString(), totalMs: input.totalMs,
    stages, hits, evidence, coverage: { returnedCandidates: candidates.length, displayedCandidates: hits.length,
      displayedStages: stages.length, internalStageCount: spans.length, passiveResultBasis: input.mode === 'passive' ? 'VCP RAG broadcast, up to 20 per event' : undefined,
      finalRankingAvailable: input.mode === 'semantic' ? spans.some(span => span.stage === 'lightmemo.final-candidates') : input.mode === 'passive' && Array.isArray(result.events),
      textPreviewLimitCodePoints: 4000, stageTiming: 'nested inclusive boundaries; do not add durations', scoring: 'original fields and original order; missing fields are not provided' },
    raw: boundedMemoryDiagnostic({ result: input.result, telemetry }),
    notice: '试查使用当前伙伴与受众的原 VCP 链路，不生成聊天回复、不保存试查问题为对话记忆。分数保留原量纲；阶段耗时可相互包含，不能相加。' };
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 384 * 1024) {
    report.raw = { omitted: 'diagnostic-record-capacity' };
    report.coverage = { ...row(report.coverage), rawOmitted: true };
  }
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > 384 * 1024) {
    report.evidence = short(report.evidence, 4000);
    report.hits = report.hits.map(hit => ({ ...hit, text: short(hit.text, 1000) ?? '' }));
    report.coverage = { ...row(report.coverage), textPreviewLimitCodePoints: 1000, capacityExcerpt: true };
  }
  return report;
}
