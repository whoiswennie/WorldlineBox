import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBotMemoryInspection, boundedMemoryDiagnostic } from '../../src/main/companion-bot/memory-inspection';
import { BotStore } from '../../src/main/companion-bot/store';

const roots: Array<{ path: string; store: BotStore }> = [];
afterEach(async () => { for (const root of roots.splice(0)) { root.store.close(); await rm(root.path, { recursive: true, force: true }); } });
const base = { requestId: 'inspection-1', query: '决定是什么', totalMs: 321.4 };
it('recovers diary heading date and time when VCP omitted date metadata without guessing dates mentioned in prose', () => {
  const result = buildBotMemoryInspection({ ...base, mode: 'passive', result: { events: [{ type: 'RAG_RETRIEVAL_DETAILS', results: [
    { text: '[2026-11-10] - Companion\n[10:30]\n用户提到明年旅行。' },
    { text: '用户计划在2026-12-01出发。' },
    { text: '[2026-02-31] - Companion\n[10:00]\n无效日期。' },
    { date: '2026-11-09', text: '[2026-11-10] - Companion\n[10:30]' },
  ] }] } });
  expect(result.hits.map(hit => hit.date)).toEqual(['2026-11-10 10:30', undefined, undefined, '2026-11-09']);
});
it('preserves final LightMemo order and original scores, including zero and negative values', () => {
  const report = buildBotMemoryInspection({ ...base, mode: 'semantic', result: { content: '原格式结果' }, telemetry: { vcp: { spans: [
    { id: 1, stage: 'native.lightmemo', raw: { candidates: [{ text: '候选池不是最终命中' }] }, status: 'completed', hostTiming: { durationMs: 12 } },
    { id: 2, parentId: 1, stage: 'lightmemo.final-candidates', input: { candidates: [
      { text: '第一条', score: 0, bm25Score: 30, vectorScore: -0.1, retrieval_rank: 8, riverMemo: { omega: 0, topologyBonus: -0.2 } },
      { text: '第二条', score: 1, hybridScore: 3.4 },
    ] }, status: 'completed', hostTiming: { durationMs: 4 } },
  ] } } });
  expect(report.hits.map(hit => hit.text)).toEqual(['第一条', '第二条']);
  expect(report.hits[0]).toMatchObject({ rank: 1, score: 0, scores: { bm25Score: 30, vectorScore: -0.1, retrieval_rank: 8, 'riverMemo.omega': 0, 'riverMemo.topologyBonus': -0.2 } });
  expect(report.totalMs).toBe(321.4); expect(report.stages.map(stage => stage.durationMs)).toEqual([12, 4]);
});
it('does not invent final candidates from native intermediate pools or invent missing scores/timings', () => {
  const report = buildBotMemoryInspection({ ...base, mode: 'semantic', result: { content: '原格式' }, telemetry: { vcp: { spans: [
    { stage: 'native.river', raw: { candidates: [{ text: '中间候选' }] } },
  ] } } });
  expect(report.hits).toEqual([]); expect(report.stages[0]?.durationMs).toBeUndefined();
  expect(report.coverage).toMatchObject({ finalRankingAvailable: false });
});
it('projects the actual passive broadcast and preserves evidence instead of reranking it', () => {
  const report = buildBotMemoryInspection({ ...base, mode: 'passive', preparationMs: 3, result: { messages: [{ role: 'system', content: 'RAG实际证据' }],
    events: [{ type: 'RAG_RETRIEVAL_DETAILS', results: [{ text: '先返回的低分', score: 0.1 }, { text: '后返回的高分', score: 0.9 }] }] } });
  expect(report.hits.map(hit => hit.text)).toEqual(['先返回的低分', '后返回的高分']);
  expect(report.evidence).toBe('RAG实际证据'); expect(report.stages[0]).toMatchObject({ name: 'host.context.prepare', durationMs: 3 });
  expect(report.notice).toContain('不能相加');
});
it('bounds diagnostic records, redacts transport credentials and omits vectors without changing numeric source scores', () => {
  const output = boundedMemoryDiagnostic({ apiKey: 'never-display', headers: { authorization: 'secret' }, queryVector: [0.1, 0.2],
    spans: Array.from({ length: 100 }, () => ({ raw: Array.from({ length: 100 }, () => ({ text: '很长🐳'.repeat(5000), score: -3.1415926535 })) })) });
  const serialized = JSON.stringify(output);
  expect(serialized).not.toContain('never-display'); expect(serialized).not.toContain('secret');
  expect(serialized).toContain('-3.1415926535'); expect(serialized).toContain('omitted');
  expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(200000);
});
it('retains at most twenty diagnostics per owner and never reads another companion or audience', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-inspection-')), store = new BotStore(path.join(directory, 'bot.sqlite'));
  roots.push({ path: directory, store });
  for (let index = 0; index < 25; index++) store.recordMemoryInspection('fish', 'private', {
    ...buildBotMemoryInspection({ ...base, mode: 'passive', result: {} }), requestId: `query-${index.toString().padStart(2, '0')}`, createdAt: new Date(100000 + index).toISOString(),
  });
  expect(store.memoryInspections('fish', 'private', 20)).toHaveLength(20);
  expect(store.memoryInspections('fish', 'group')).toEqual([]); expect(store.memoryInspections('other', 'private')).toEqual([]);
  const revision = store.memoryInspectionRevision('fish', 'private'); store.clearMemoryInspections('fish', 'private');
  expect(store.memoryInspections('fish', 'private')).toEqual([]); expect(store.memoryInspectionRevision('fish', 'private')).not.toBe(revision);
});
