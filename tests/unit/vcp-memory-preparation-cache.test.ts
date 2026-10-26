import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { VcpMemoryAutomaticDecayPolicy, VcpMemoryContextReference, VcpMemoryMessage, VcpMemoryPreprocessResult, VcpMemoryQueryClock } from '../../src/main/vcp-memory/contracts';

interface Peripherals {
  corpusEpoch: number;
  plugins: Map<string, unknown>;
  contextReferences: VcpMemoryContextReference[];
  events: unknown[];
  decayPolicy: { getStore(): VcpMemoryAutomaticDecayPolicy | undefined };
  ragClock: { current(): VcpMemoryQueryClock | undefined };
  decayObservations: unknown[];
  preprocess(messages: VcpMemoryMessage[], clock?: VcpMemoryQueryClock, policy?: VcpMemoryAutomaticDecayPolicy): Promise<VcpMemoryPreprocessResult>;
  invalidateCorpus(): void;
  receiptCacheSnapshot(): { entries: number; bytes: number; corpusEpoch: number; maxEntries: number; maxBytes: number };
  load(name: string): Promise<unknown>;
  validateTimelines(plugin: unknown): Promise<void>;
  importTimelines(revision: string, artifacts: object): Promise<{ acceptedMonths: number; skippedMonths: number }>;
  readDependencies(): Promise<Record<string, Record<string, string>>>;
  writeDependencies(value: Record<string, Record<string, string>>): Promise<void>;
  monthDigest(plugin: unknown, agent: string, month: string): Promise<string>;
}
const require = createRequire(import.meta.url);
const { VcpMemoryPeripherals } = require('../../src/main/vcp-memory/peripherals.cjs') as {
  VcpMemoryPeripherals: new (runtime: object, configuration: object) => Peripherals;
};
const { VcpMemoryRuntime } = require('../../src/main/vcp-memory/runtime.cjs') as {
  VcpMemoryRuntime: { prototype: { prepare(this: object): Promise<{ ready: true; corpusEpoch: number }> } };
};
const clock = { now: '2026-10-26T08:00:00+08:00', timeZone: 'Asia/Shanghai' };
const normalizedClock = { ...clock, now: new Date(clock.now).toISOString() };
const messages = (query = 'alpha'): VcpMemoryMessage[] => [{ role: 'system', content: 'original focusing request' }, { role: 'user', content: query }];

function fixture(count = 1) {
  const records = new Map(Array.from({ length: count }, (_, index) => [`note-${index}`, { indexState: 'indexed', deleted: false, content: `source-${index}` }]));
  const runtime = { scopeRoot: path.resolve('synthetic-cache-fixture'), runtimeRoot: path.resolve('vendor/vcp-memory'), records, fileIds: new Map(),
    embedding: { apiUrl: 'http://127.0.0.1/unused' }, ensureArtifacts: vi.fn(async () => undefined),
    kb: { listDistinctDiaries: async () => ['memories'], databaseCoordinator: { awaitIndexedFilePaths: vi.fn(async () => undefined) } } };
  const peripherals = new VcpMemoryPeripherals(runtime, { chat: { baseUrl: 'http://127.0.0.1/unused', model: 'synthetic', apiKey: 'synthetic' } });
  const controls = { padding: '', failure: false };
  const focusedAnswers = new Map<string, string>();
  const rag = { timeParser: { defaultTimezone: 'Asia/Shanghai', parse: vi.fn<(text: string) => Array<{ start: Date; end: Date }>>(() => []) },
    sanitizeForEmbedding: (text: string) => text,
    cacheManager: { clear: vi.fn((name: string) => { if (name === 'aimemo') focusedAnswers.clear(); }) },
    processMessages: vi.fn(async (input: VcpMemoryMessage[]) => {
      if (controls.failure) return [{ role: 'system', content: '[AIMemo+处理失败: synthetic offline]' }];
      const key = JSON.stringify(input);
      if (!focusedAnswers.has(key)) focusedAnswers.set(key, [...records.values()].map(note => note.content).join('|') + controls.padding);
      peripherals.contextReferences = [{ id: [...records.keys()][0]!, role: 'focus_input', sourceFile: 'memories/source.md', textHash: 'a'.repeat(64) }];
      peripherals.events = [{ type: 'actual-native-observation', corpusCount: records.size }];
      const policy = peripherals.decayPolicy.getStore();
      peripherals.decayObservations = policy ? [{ policy: policy.schema, protectedCount: policy.protectedNoteIds.length, eligibleCount: 0, results: [] }] : [];
      return [{ role: 'system', content: focusedAnswers.get(key)! }];
    }) };
  const timelines = new Map<string, string>(), summaries: Record<string, Record<string, string>> = {};
  const timeline = { config: {}, safeAgentName() {}, processMessages: vi.fn(async (input: VcpMemoryMessage[]) => input),
    readSummaryStore: async () => summaries,
    listTimelineFiles: async (agent: string) => [...timelines].filter(([key]) => key.startsWith(agent + ':')).map(([key, content]) => ({ month: key.split(':')[1], content })),
    saveTimelineFile: vi.fn(async (agent: string, month: string, content: string) => { timelines.set(`${agent}:${month}`, content); }),
    saveSummary: vi.fn(async (agent: string, month: string, content: string) => { summaries[agent] ||= {}; summaries[agent]![month] = content; }),
    getTimelineDir: () => path.resolve('synthetic-timeline') };
  peripherals.load = vi.fn(async name => {
    const plugin = name === 'RAGDiaryPlugin' ? rag : timeline;
    peripherals.plugins.set(name, plugin); return plugin;
  });
  peripherals.validateTimelines = vi.fn(async () => undefined);
  let dependencies: Record<string, Record<string, string>> = {};
  peripherals.readDependencies = async () => dependencies;
  peripherals.writeDependencies = vi.fn(async value => { dependencies = value; });
  peripherals.monthDigest = async () => 'b'.repeat(64);
  return { peripherals, runtime, rag, timeline, records, controls };
}

it('prepares dependencies and a graph without performing a query, message processing or model generation', async () => {
  const { peripherals, runtime, rag, timeline } = fixture();
  const requireReady = vi.fn();
  const result = await VcpMemoryRuntime.prototype.prepare.call({ ...runtime, peripherals, requireReady });
  expect(result).toEqual({ ready: true, corpusEpoch: 0 });
  expect(peripherals.load).toHaveBeenCalledWith('RAGDiaryPlugin');
  expect(peripherals.load).toHaveBeenCalledWith('VCPTimeLine');
  expect(peripherals.validateTimelines).toHaveBeenCalledOnce();
  expect(runtime.ensureArtifacts).toHaveBeenCalledOnce();
  expect(rag.processMessages).not.toHaveBeenCalled(); expect(timeline.processMessages).not.toHaveBeenCalled();
});

it('reuses a complete receipt with actual references and events, isolated from caller mutations', async () => {
  const { peripherals, rag } = fixture();
  const first = await peripherals.preprocess(messages(), clock);
  expect(first.receiptCache).toEqual({ hit: false, corpusEpoch: 0 });
  const originalReferences = structuredClone(first.contextReferences), originalEvents = structuredClone(first.events);
  first.contextReferences![0]!.id = 'caller-mutated'; first.events.push('caller-mutated');
  const second = await peripherals.preprocess(messages(), { ...clock, now: '2026-10-26T12:00:00+08:00' });
  expect(second.receiptCache).toEqual({ hit: true, corpusEpoch: 0, sourceQueryClock: normalizedClock });
  expect(second.queryClock).toEqual({ ...clock, now: '2026-10-26T04:00:00.000Z' });
  expect(second.contextReferences).toEqual(originalReferences); expect(second.events).toEqual(originalEvents);
  expect(rag.processMessages).toHaveBeenCalledOnce();
  expect(second.cacheClock?.invalidated).toBe(false);
});

it('keys Time queries by actual parsed ranges and keeps stable day ranges reusable', async () => {
  const { peripherals, rag } = fixture();
  const timedMessages = [{ role: 'system', content: '[[memories日记本::RiverMemo::Time::AIMemo+]]' }, { role: 'user', content: 'relative temporal fixture' }];
  rag.timeParser.parse.mockImplementation(() => {
    const now = Date.parse(peripherals.ragClock.current()!.now);
    return [{ start: new Date(now - 3_600_000), end: new Date(now) }];
  });
  const first = await peripherals.preprocess(timedMessages, clock);
  const moved = await peripherals.preprocess(timedMessages, { ...clock, now: '2026-10-26T09:00:00+08:00' });
  expect(moved.receiptCache?.hit).toBe(false); expect(moved.cacheClock?.invalidated).toBe(true);
  expect(moved.cacheClock?.bucket).not.toBe(first.cacheClock?.bucket);
  expect(rag.processMessages).toHaveBeenCalledTimes(2);
  rag.timeParser.parse.mockReturnValue([{ start: new Date('2026-10-25T00:00:00+08:00'), end: new Date('2026-10-25T23:59:59+08:00') }]);
  await peripherals.preprocess(timedMessages, clock);
  const stable = await peripherals.preprocess(timedMessages, { ...clock, now: '2026-10-26T11:00:00+08:00' });
  expect(stable.receiptCache?.hit).toBe(true);
  expect(stable.queryClock?.now).toBe('2026-10-26T03:00:00.000Z');
  expect(stable.receiptCache?.sourceQueryClock).toEqual(normalizedClock);
  expect(rag.processMessages).toHaveBeenCalledTimes(3);
});

it('uses exact now for explicit Time queries with unsupported ranges and invalidates upstream focused answers', async () => {
  const { peripherals, rag } = fixture();
  const timedMessages = [{ role: 'system', content: '[[memories日记本::RiverMemo::Time::AIMemo+]]' }, { role: 'user', content: '最近一小时的记忆' }];
  await peripherals.preprocess(timedMessages, clock);
  rag.cacheManager.clear.mockClear();
  const moved = await peripherals.preprocess(timedMessages, { ...clock, now: '2026-10-26T09:00:00+08:00' });
  expect(moved.receiptCache?.hit).toBe(false);
  expect(moved.queryClock?.now).toBe('2026-10-26T01:00:00.000Z');
  expect(rag.cacheManager.clear).toHaveBeenCalledWith('aimemo');
  expect(rag.cacheManager.clear).toHaveBeenCalledWith('query');
  expect(rag.processMessages).toHaveBeenCalledTimes(2);
});

it('separates messages, civil days, timezones and complete automatic-decay policy in the cache', async () => {
  const { peripherals, rag } = fixture(2);
  const policy: VcpMemoryAutomaticDecayPolicy = { schema: 'episodic-v1', halfLifeDays: 180, minScore: 0, protectedNoteIds: ['note-0'] };
  const inputs = [
    { messages: messages(), clock, policy },
    { messages: messages('new topic'), clock, policy },
    { messages: messages(), clock: { ...clock, now: '2026-10-27T08:00:00+08:00' }, policy },
    { messages: messages(), clock: { ...clock, timeZone: 'UTC' }, policy },
    { messages: messages(), clock, policy: { ...policy, protectedNoteIds: ['note-0', 'note-1'] } },
  ];
  for (const input of inputs) expect((await peripherals.preprocess(input.messages, input.clock, input.policy)).receiptCache?.hit).toBe(false);
  expect(rag.processMessages).toHaveBeenCalledTimes(5);
});

it('invalidates source-insensitive upstream AIMemo answers and complete receipts after corpus changes', async () => {
  const { peripherals, records, rag } = fixture();
  await peripherals.preprocess(messages(), clock);
  expect((await peripherals.preprocess(messages(), clock)).receiptCache?.hit).toBe(true);
  records.get('note-0')!.content = 'updated-source';
  peripherals.invalidateCorpus();
  expect(peripherals.receiptCacheSnapshot()).toMatchObject({ entries: 0, bytes: 0, corpusEpoch: 1 });
  const updated = await peripherals.preprocess(messages(), clock);
  expect(updated.messages[0]!.content).toBe('updated-source');
  expect(updated.receiptCache).toEqual({ hit: false, corpusEpoch: 1 });
  expect(rag.cacheManager.clear).toHaveBeenCalledWith('aimemo');
  expect(rag.cacheManager.clear).toHaveBeenCalledWith('query');
});

it('accepts all 150 authorized protected IDs without truncation and rejects foreign or duplicate IDs', async () => {
  const { peripherals, rag, records } = fixture(150);
  const policy: VcpMemoryAutomaticDecayPolicy = { schema: 'episodic-v1', halfLifeDays: 180, minScore: 0, protectedNoteIds: [...records.keys()] };
  const result = await peripherals.preprocess(messages(), clock, policy);
  expect(result.automaticDecay?.[0]?.protectedCount).toBe(150);
  expect(rag.processMessages).toHaveBeenCalledOnce();
  await expect(peripherals.preprocess(messages(), clock, { ...policy, protectedNoteIds: ['foreign-note'] })).rejects.toThrow('Invalid VCP automatic decay policy');
  await expect(peripherals.preprocess(messages(), clock, { ...policy, protectedNoteIds: ['note-0', 'note-0'] })).rejects.toThrow('Invalid VCP automatic decay policy');
});

it('does not publish a receipt into the cache when its corpus changes during asynchronous processing', async () => {
  const { peripherals, rag } = fixture();
  const process = rag.processMessages.getMockImplementation()!;
  rag.processMessages.mockImplementationOnce(async input => {
    const output = await process(input);
    peripherals.invalidateCorpus();
    return output;
  });
  await peripherals.preprocess(messages(), clock);
  expect(peripherals.receiptCacheSnapshot()).toMatchObject({ entries: 0, corpusEpoch: 1 });
  expect((await peripherals.preprocess(messages(), clock)).receiptCache).toEqual({ hit: false, corpusEpoch: 1 });
  expect(rag.processMessages).toHaveBeenCalledTimes(2);
});

it('bounds receipts by LRU count and UTF-8 bytes, including oversized responses and uncached failures', async () => {
  const byCount = fixture();
  for (let index = 0; index < 33; index++) await byCount.peripherals.preprocess(messages(`query-${index}`), clock);
  expect(byCount.peripherals.receiptCacheSnapshot()).toMatchObject({ entries: 32 });
  expect((await byCount.peripherals.preprocess(messages('query-0'), clock)).receiptCache?.hit).toBe(false);
  expect((await byCount.peripherals.preprocess(messages('query-32'), clock)).receiptCache?.hit).toBe(true);
  const byBytes = fixture(); byBytes.controls.padding = '汉'.repeat(600_000);
  for (let index = 0; index < 3; index++) await byBytes.peripherals.preprocess(messages(`large-${index}`), clock);
  const snapshot = byBytes.peripherals.receiptCacheSnapshot();
  expect(snapshot.entries).toBe(2); expect(snapshot.bytes).toBeLessThanOrEqual(snapshot.maxBytes);
  expect((await byBytes.peripherals.preprocess(messages('large-0'), clock)).receiptCache?.hit).toBe(false);
  const oversized = fixture(); oversized.controls.padding = 'x'.repeat(snapshot.maxBytes + 1);
  await oversized.peripherals.preprocess(messages(), clock);
  expect(oversized.peripherals.receiptCacheSnapshot()).toMatchObject({ entries: 0, bytes: 0 });
  const failed = fixture(); failed.controls.failure = true;
  await failed.peripherals.preprocess(messages(), clock); await failed.peripherals.preprocess(messages(), clock);
  expect(failed.rag.processMessages).toHaveBeenCalledTimes(2);
  expect(failed.peripherals.receiptCacheSnapshot().entries).toBe(0);
});

it('invalidates changed timeline imports while preserving receipts on identical repeated imports', async () => {
  const { peripherals, timeline } = fixture();
  const artifacts = { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: 'revision', agents: [{ agentName: 'owner',
    months: [{ month: '2026-10', sourceDigest: 'b'.repeat(64), content: 'timeline-original', summary: 'summary-original' }] }] };
  await peripherals.preprocess(messages(), clock);
  expect(await peripherals.importTimelines('revision', artifacts)).toEqual({ acceptedMonths: 1, skippedMonths: 0 });
  const changed = await peripherals.preprocess(messages(), clock);
  expect(changed.receiptCache).toEqual({ hit: false, corpusEpoch: 1 });
  await peripherals.importTimelines('revision', artifacts);
  expect((await peripherals.preprocess(messages(), clock)).receiptCache).toMatchObject({ hit: true, corpusEpoch: 1 });
  expect(timeline.saveTimelineFile).toHaveBeenCalledOnce(); expect(timeline.saveSummary).toHaveBeenCalledOnce();
  artifacts.agents[0]!.months[0]!.summary = 'corrected-summary';
  await peripherals.importTimelines('revision', artifacts);
  expect((await peripherals.preprocess(messages(), clock)).receiptCache).toEqual({ hit: false, corpusEpoch: 2 });
});
