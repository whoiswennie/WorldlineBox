import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve('resources/vcp-memory/package.json'));
const { BotHost } = require('./lib/bot-host.cjs');
const roots: string[] = [], hosts: Array<{ close(): void }> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const host of hosts.splice(0)) host.close(); for (const root of roots.splice(0)) {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('bot-maintenance-host-')) throw new Error('Unexpected owned maintenance test root');
  await rm(root, { recursive: true, force: true });
} });
const md5 = (text: string) => createHash('md5').update(text).digest('hex');
interface Probe { path: string; exists: boolean; checksum?: string; completeVectors?: boolean; completeTags?: boolean }
// File, SQLite and original DreamWave orchestration are real. The KB receipt /
// vector boundary is a fixture here; this unit test is not relevance acceptance.
function runtime(home: string) {
  const index = new Map<string, Probe>(), pendingFiles = new Set<string>(); let failIndex = false, failDelete = false;
  const relative = (file: string) => path.relative(path.join(home, 'dailynote'), file).replaceAll('\\', '/');
  const flush = async () => {
    if (failIndex) throw Object.assign(new Error('Index transport unavailable'), { code: 'TEST_INDEX_FAILURE' });
    for (const file of pendingFiles) { const text = await readFile(file, 'utf8'); index.set(relative(file), { path: relative(file), exists: true, checksum: md5(text), completeVectors: true, completeTags: true }); }
    pendingFiles.clear();
  };
  const nativeQueries = vi.fn(async (_query: unknown, options: Record<string, unknown>) => {
    expect(options.diaryNames).toEqual(['Companion']);
    return { results: [...index.keys()].map((fullPath, rank) => ({ fullPath, score: 0.81 - rank / 100, text: 'native boundary fixture' })), diagnostics: { nativeTopologyV3: { jointUsed: true } } };
  });
  const kb = { config: { ignorePrefixes: ['已整理'], dimension: 768 }, pendingFiles, _flushBatch: flush, ingestionPipeline: { drain: async () => {} },
    getChunksByFilePaths: async (paths: string[]) => paths.map((fullPath, rank) => ({ fullPath, fileId: rank + 1, vector: new Float32Array(768).fill(0.1), chunkId: rank + 1 })),
    executeNativeRiverQuery: nativeQueries, searchKnn: async () => [],
    probeIngestionFiles: async (paths: string[]) => paths.map(value => index.get(value) ?? { path: value, exists: false }),
    runExternalFileMutation: async (_name: string, fn: () => Promise<{ mutationPaths: { upserts: string[]; deletes: string[] } }>, options: { waitForIndex?: boolean }) => {
      const result = await fn();
      if (result.mutationPaths.deletes.length && failDelete) throw Object.assign(new Error('Delete receipt unavailable'), { code: 'TEST_DELETE_FAILURE' });
      for (const file of result.mutationPaths.deletes) { index.delete(relative(file)); pendingFiles.delete(file); }
      for (const file of result.mutationPaths.upserts) pendingFiles.add(file);
      if (options.waitForIndex) await flush(); return result;
    } };
  return { config: { DEFAULT_TIMEZONE: 'Asia/Shanghai' }, kb, index, nativeQueries, start: async () => {},
    setFailIndex(value: boolean) { failIndex = value; }, setFailDelete(value: boolean) { failDelete = value; },
    _require: (name: string) => {
      if (name !== 'Plugin/AgentDream/DreamWaveEngine.js') return { getDb: () => ({ prepare: () => ({ get: () => undefined }), exec: () => {} }) };
      const previous = process.env.KNOWLEDGEBASE_ROOT_PATH;
      try { process.env.KNOWLEDGEBASE_ROOT_PATH = path.join(home, 'dailynote'); const location = require.resolve('./upstream/toolbox/' + name); delete require.cache[location]; return require(location); }
      finally { if (previous === undefined) delete process.env.KNOWLEDGEBASE_ROOT_PATH; else process.env.KNOWLEDGEBASE_ROOT_PATH = previous; }
    },
    callTool: async (_name: string, input: { Date: string; Content: string; Tag: string; fileName: string }) => {
      const dir = path.join(home, 'dailynote/Companion'); await mkdir(dir, { recursive: true });
      const filename = `${input.Date}-12_00_00-${input.fileName}.txt`, file = path.join(dir, filename);
      await writeFile(file, `[${input.Date}] - Companion\n[12:00]\n${input.Content}\nTag: ${input.Tag}`, { flag: 'wx' }); pendingFiles.add(file);
      return { status: 'success', result: { folder: 'Companion', fileName: filename } };
    } };
}
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-maintenance-host-')); roots.push(home);
  const host = new BotHost(home); hosts.push(host); const rt = runtime(home);
  const seed = async (key: string, content: string, root = key) => {
    const receipt = await host.remember(rt, { sourceEventId: key, sourceRootEventId: root, sourceMessageIds: [`message-${key}`], content, tags: '计划,未决' });
    await host.sync(rt, { id: receipt.id }); return host.readNote({ id: receipt.id });
  };
  return { home, host, rt, seed };
}
it('upgrades busy-state probes on populated ledgers and leaves complete history out of turn readiness', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-maintenance-host-')); roots.push(home);
  const old = new BotHost(home);
  try {
    old.db.exec(`DROP INDEX managed_unfinished_operations;
      DROP INDEX maintenance_unreadable_operations;
      CREATE TEMP TABLE prior(id TEXT PRIMARY KEY);
      WITH RECURSIVE seq(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM seq WHERE i<5000)
        INSERT INTO prior SELECT CAST(i AS TEXT) FROM seq;
      INSERT INTO history_receipts(id,hash,episode,state) SELECT id,'old',0,'done' FROM prior;
      INSERT INTO mutations(id,hash,state,created_at) SELECT id,'old','indexed','2026-01-01' FROM prior;
      INSERT INTO managed_operations(operation_id,kind,fingerprint,state,plan_json,created_at,updated_at)
        SELECT id,'update','old','indexed','{}','','' FROM prior;
      INSERT INTO maintenance_operations(operation_id,kind,fingerprint,plan,state) SELECT id,'insight','old','{}','indexed' FROM prior;`);
  } finally { old.close(); }
  const host = new BotHost(home); hosts.push(host);
  const plan = (s: { source: string }) => host.db.prepare(`EXPLAIN QUERY PLAN ${s.source}`).all().map((row: { detail: string }) => row.detail).join('\n');
  expect(plan(host.unfinishedMutation)).toMatch(/SEARCH mutations USING COVERING INDEX mutations_state/);
  expect(plan(host.managed.unfinishedOperation)).toMatch(/USING COVERING INDEX managed_unfinished_operations/);
  expect(plan(host.managed.unknownOperation)).toMatch(/SEARCH managed_operations USING COVERING INDEX managed_unfinished_operations/);
  expect(plan(host.maintenance.unreadableOperation)).toMatch(/USING COVERING INDEX maintenance_unreadable_operations/);
  expect(host.status()).toMatchObject({ pending: 0, operationsPending: 0, indexed: 5000, historyMessages: 5000 });
  expect(host.turnPending()).toBe(false);
  const mutation = host.db.prepare("UPDATE mutations SET state=? WHERE id='1'");
  for (const state of ['pending','writing','failed','withdrawing','unknown']) {
    mutation.run(state); expect(host.turnPending()).toBe(true);
  }
  mutation.run('indexed');
  const operation = host.db.prepare("UPDATE managed_operations SET state=? WHERE operation_id='1'");
  for (const state of ['indexed','conflict','withdrawn']) {
    operation.run(state); expect(host.turnPending()).toBe(false);
  }
  operation.run('new-unfinished-state'); expect(host.turnPending()).toBe(true);
  expect(() => host.managed.assertReadable()).not.toThrow();
  operation.run('unknown'); expect(() => host.managed.assertReadable()).toThrowError(expect.objectContaining({ code: 'MEMORY_OUTCOME_UNKNOWN' }));
  for (const state of ['partial','unknown']) {
    host.db.prepare("UPDATE maintenance_operations SET state=? WHERE operation_id='1'").run(state);
    expect(() => host.maintenance.assertReadable()).toThrowError(expect.objectContaining({ code: 'MEMORY_OUTCOME_UNKNOWN' }));
  }
});
it('runs the preserved DreamWaveEngine across verified diaries in the same audience and retains original wave roles/scores', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const f = await fixture(), a = await f.seed('a', '用户的博物馆计划，尚未预约。'), b = await f.seed('b', '伙伴讨论博物馆路线，尚未执行。'), outside = await f.seed('outside', '上个月的博物馆经历。');
  f.rt.index.set('Other/foreign.txt', { path: 'Other/foreign.txt', exists: true });
  const wave = await f.host.maintenance.dreamRecall(f.rt, { sources: [a, b].map(note => ({ id: note.id, expectedChecksum: note.checksum })), expectedSourceRevision: '0' });
  expect(wave).toMatchObject({ engine: 'DreamWaveEngine', namespace: 'Companion', examined: 2 }); expect(f.rt.nativeQueries).toHaveBeenCalled();
  const hits = Object.values(wave.groups).flat() as Array<{ id: string; score?: number }>;
  expect(hits.some(hit => hit.id === a.id)).toBe(true); expect(hits.every(hit => [a.id, b.id, outside.id].includes(hit.id))).toBe(true); expect(hits.some(hit => hit.id === outside.id)).toBe(true);
  expect(wave.dreamPrompt).toContain(outside.id); expect(wave.dreamPrompt).not.toContain('{{DreamTreeBlock}}');
  expect(hits.filter(hit => hit.score !== undefined).every(hit => [0.81, 0.8, 0.79].some(score => Math.abs(score - hit.score!) < 1e-9))).toBe(true);
  expect(wave.omitted.filteredCandidates).toBeGreaterThan(0); expect(JSON.stringify(wave)).not.toContain(f.home);
});

it('filters out-of-period native chunks before association metadata, ranking and original previews', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const f = await fixture();
    vi.setSystemTime(new Date('2024-03-01T04:00:00Z'));
    const hidden = await f.seed('early', '日历范围外不可注入的记录。');
    vi.setSystemTime(new Date('2024-03-02T04:00:00Z'));
    const a = await f.seed('dated-seed', '潮汐日记开始。');
    vi.setSystemTime(new Date('2024-03-03T04:00:00Z'));
    const b = await f.seed('dated-evidence', '记录次日的潮位。');
    const runtime = { ...f.rt, runtimeDir: path.resolve('resources/vcp-memory/upstream/toolbox'), runtimeConfig: { PROJECT_BASE_PATH: f.home },
      kb: { ...f.rt.kb, config: { ...f.rt.kb.config, rootPath: path.join(f.home,'dailynote') }, listDistinctDiaries: async () => ['Companion'],
        getChunksByFilePaths: async (paths: string[]) => [{ sourceFile: paths[0], vector: new Float32Array(768).fill(0.1), chunkId: 1 }] } };
    const range = { fromDate: '2024-03-02', toDate: '2024-03-03', expectedSourceRevision: '0' };
    const associate = (sources: unknown[]) => require('./lib/diary-associations.cjs').associateDiaries(f.host.maintenance, runtime, { sources, ...range });
    const found = await associate([a]);
    expect(found.queries[0].totalChunksFound).toBe(2);
    expect(found.items).toEqual([expect.objectContaining({ id: b.id, diaryDate: '2024-03-03', seedIds: [a.id] })]);
    expect(JSON.stringify(found)).not.toContain(hidden.id);
    await expect(associate([hidden])).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
  } finally { vi.useRealTimers(); }
});

it('samples the whole owned diary timeline and requires a recent seed even after an earlier maintenance pass', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const f = await fixture(), today = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(today - 60 * 86400_000);
    for (let index = 0; index < 25; index++) await f.seed(`middle-${index}`, `两个月前的独立日记和讨论内容，第${index}篇。`);
    vi.setSystemTime(today);
    const empty = await f.host.maintenance.dreamRecall(f.rt, { expectedSourceRevision: '0' });
    expect(empty.examined).toBe(25); expect(empty.sources).toEqual([]);
    const fresh = await f.seed('recent-beyond-24', '近期的新日记唤起之前的讨论。');
    const foreign = path.join(f.home, 'dailynote/Companion/unmanaged.txt');
    await writeFile(foreign, '没有受管来源的日记也不能成为种子。');
    const wave = await f.host.maintenance.dreamRecall(f.rt, { expectedSourceRevision: '0' });
    expect(wave.examined).toBe(26);
    expect(wave.groups['recent.seeds']).toEqual([expect.objectContaining({ id: fresh.id, checksum: fresh.checksum })]);
    expect(wave.groups['mid.seeds']).toHaveLength(2);
    expect(wave.sources).toContainEqual({ id: fresh.id, checksum: fresh.checksum, role: 'seed' });
    expect(wave.dreamPrompt).toContain('（中期）'); expect(JSON.stringify(wave)).not.toContain('unmanaged.txt');
  } finally { vi.useRealTimers(); }
});

it('keeps pending dream context versioned and respects claims, retries and historical recovery', async () => {
  const f = await fixture(), work = f.host.maintenanceWork;
  const original = await f.seed('dream-seed', '梦境种子。'), borrowed = await f.seed('dream-borrowed', '另一条还在排队的日记。');
  const occupied = await f.seed('dream-other-job', '另一项维护已占用的日记。'), replaced = await f.seed('dream-changed', '关联凭据中的版本已经过期。');
  const claim = { kind: 'dream', jobId: 'dream-context', limit: 1 }, batch = work.claim(claim);
  expect(batch.items.map((n: { id: string }) => n.id)).toEqual([original.id]);
  const indexHit = (note: { id: string; checksum: string }) => ({ ...note, fullPath: f.host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(note.id).note_path });
  const future = Date.now() + 600000;
  f.host.db.prepare("UPDATE maintenance_work SET available_at=?,error='deferred' WHERE kind='dream' AND note_id=?").run(future, borrowed.id);
  work.seed({ records: [{ kind: 'organize', jobId: 'other-review', sources: [occupied], reserved: [occupied.id] }] });
  const retrieval = { engine: 'DreamWaveEngine', sourceRevision: batch.revision, groups: { 'recent.resonanceL1': [indexHit(borrowed), indexHit(occupied), { ...indexHit(replaced), checksum: '0'.repeat(32) }] } };
  const related = work.associate({ ...claim, retrieval });
  expect(related.items).toEqual([{ id: borrowed.id, checksum: borrowed.checksum }]);
  work.release(claim); expect(work.claim(claim).state).toBe('processing');
  const sources = [...batch.items, ...related.items], state = () => f.host.db.prepare("SELECT state,available_at,error FROM maintenance_work WHERE kind='dream' AND note_id=?").get(borrowed.id);
  work.complete({ ...claim, sources, reserved: [borrowed.id] }); expect(state().state).toBe('review');
  work.complete({ ...claim, sources }); expect(state()).toEqual({ state: 'pending', available_at: future, error: 'deferred' });

  const historical = { kind: 'dream', jobId: 'historical-dream', sources: [{ ...borrowed, contextOnly: true }], reserved: [borrowed.id] };
  work.seed({ records: [historical] }); expect(state().state).toBe('review');
  work.complete({ ...historical, reserved: [] }); expect(state()).toEqual({ state: 'pending', available_at: future, error: 'deferred' });
});

it('takes at most twenty ready seeds from one diary month, preserves a cross-month association and revisits young seeds once on day thirty', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const firstAt = Date.parse('2025-12-31T15:59:59.123Z'), monthLater = firstAt + 30 * 86400000;
  try {
    vi.setSystemTime(firstAt);
    const f = await fixture(), work = f.host.maintenanceWork;
    const december = [];
    for (let n = 1; n <= 21; n++) december.push(await f.seed('december-' + n, '整理十二月的第' + n + '条观测。'));
    vi.setSystemTime(firstAt + 2000); // Shanghai's date is January 1; UTC is still December 31.
    const january = await f.seed('january', '一月继续观测。');
    const first = { kind: 'organize', jobId: 'december-page', limit: 24 }, batch = work.claim(first);
    const versions = december.map(({ id, checksum }) => ({ id, checksum }));
    expect(batch.items).toEqual(versions.slice(0, 20));
    expect(work.claim(first).items).toEqual(batch.items);
    const context = work.associate({ ...first, retrieval: { engine: 'DailyNoteManager.Associate', sourceRevision: batch.revision,
      items: [{ id: january.id, checksum: january.checksum, seedIds: [batch.items[0].id] }] } });
    expect(context.items).toEqual([{ id: january.id, checksum: january.checksum }]);
    expect(work.complete({ ...first, sources: [...batch.items, ...context.items], reserved: [batch.items[1].id] })).toEqual({
      mode: 'incremental-v1', hasReady: true, maturityAt: monthLater });
    const second = { ...first, jobId: 'december-last' }, remainder = work.claim(second);
    expect(remainder.items).toEqual(versions.slice(20));
    work.complete({ ...second, sources: remainder.items });
    const januaryJob = { ...first, jobId: 'january-page' }, jan = work.claim(januaryJob);
    expect(jan.items).toEqual(context.items);
    work.release({ ...januaryJob, reason: '索引传输中断。' });
    expect(work.stats(first)).toMatchObject({ settling: 20, retrying: 1, maturityAt: monthLater, retryAt: Date.now() + 300000 });
    expect(work.claim(januaryJob).items).toEqual(jan.items);
    work.complete({ ...januaryJob, sources: jan.items });
    vi.setSystemTime(monthLater - 1);
    expect(work.stats(first)).toMatchObject({ ready: 0, settling: 21, retrying: 0 });
    vi.setSystemTime(monthLater);
    const mature = { ...first, jobId: 'settled-december' }, recheck = work.claim(mature);
    expect(recheck.items).toEqual(versions.filter(source => source.id !== batch.items[1].id));
    expect(work.complete({ ...mature, sources: recheck.items })).toEqual({ mode: 'incremental-v1', hasReady: false, maturityAt: monthLater + 2000 });
    vi.setSystemTime(monthLater + 2000);
    const last = { ...first, jobId: 'settled-january' };
    expect(work.claim(last).items).toEqual(jan.items);
    expect(work.complete({ ...last, sources: jan.items })).toEqual({ mode: 'incremental-v1', hasReady: false });
    expect(work.stats(first)).toMatchObject({ ready: 0, retrying: 0, settling: 0 });
    const query = f.host.db.prepare(`EXPLAIN QUERY PLAN SELECT w.note_id FROM maintenance_work w JOIN mutations m ON m.id=w.note_id
      WHERE w.kind='organize' AND w.state='pending' AND w.diary_month=? AND w.available_at<=? AND ${work.eligible()} ORDER BY w.available_at,w.sequence LIMIT 20`).all('2025-12',Date.now());
    expect(JSON.stringify(query)).toContain('maintenance_work_month');
  } finally { vi.useRealTimers(); }
});

it('replays historical analysis and keeps an explicitly decided version out of the thirty-day reconsideration queue', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const birth = Date.parse('2025-11-17T06:30:01.579Z');
    vi.setSystemTime(birth);
    const f = await fixture(), work = f.host.maintenanceWork;
    const judged = await f.seed('prior-rejection', '该候选已经被用户驳回。'), exempt = await f.seed('young-when-seen', '初次分析时日记尚在沉淀。');
    const awaiting = await f.seed('prior-pending-review', '旧版审批尚未处理。');
    const newDay = await f.seed('new-version', '保持近期日记。');
    const old = { kind: 'organize', jobId: 'imported-plan', analyzedAt: new Date(birth + 2 * 86400000).toISOString(),
      sources: [{ ...judged, fromCandidate: true }, exempt, { ...awaiting, fromCandidate: true }], reserved: [awaiting.id] };
    const state = (id: string) => f.host.db.prepare("SELECT state,available_at FROM maintenance_work WHERE note_id=? AND kind='organize'").get(id);
    vi.setSystemTime(birth + 3 * 86400000);
    work.seed({ records: [old] });
    expect(state(judged.id)).toEqual({ state: 'reviewed', available_at: 0 });
    expect(state(exempt.id)).toEqual({ state: 'pending', available_at: birth + 30 * 86400000 });
    expect(state(awaiting.id)).toMatchObject({ state: 'review' });
    work.complete({ ...old, reserved: [] });
    expect(state(awaiting.id)).toEqual({ state: 'reviewed', available_at: 0 });
    vi.setSystemTime(birth + 34 * 86400000);
    work.seed({ records: [{ ...old, reserved: [] }] });
    const next = { kind: 'organize', jobId: 'after-missed-maturity', limit: 20 };
    const batch = work.claim(next);
    expect(batch.items.map((row: { id: string }) => row.id).sort()).toEqual([exempt.id,newDay.id].sort());
    work.complete({ ...next, sources: batch.items });
    expect(work.claim({ ...next, jobId: 'same-version-again' }).items).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('claims each unchanged indexed version once per maintenance kind and persists coverage across reopening', async () => {
  const f = await fixture(), a = await f.seed('incremental-a', '用户计划先去博物馆。'), b = await f.seed('incremental-b', '用户尚未订票。');
  const work = f.host.maintenanceWork;
  const first = work.claim({ kind: 'organize', jobId: 'job-one', limit: 24 }); expect(first.items.map((n: { id: string }) => n.id).sort()).toEqual([a.id, b.id].sort());
  expect(work.claim({ kind: 'organize', jobId: 'job-one', limit: 24 }).items).toEqual(first.items);
  expect(work.claim({ kind: 'organize', jobId: 'parallel-job', limit: 24 }).items).toEqual([]);
  work.complete({ kind: 'organize', jobId: 'job-one', sources: first.items });
  expect(work.stats({ kind: 'organize' }).ready).toBe(0); expect(work.stats({ kind: 'dream' }).ready).toBe(2);
  f.host.close(); hosts.splice(hosts.indexOf(f.host), 1); const reopened = new BotHost(f.home); hosts.push(reopened);
  expect(reopened.maintenanceWork.claim({ kind: 'organize', jobId: 'after-restart', limit: 24 }).items).toEqual([]);
  const update = await reopened.update(f.rt, { operationId: 'user-edits-note', id: a.id, expectedChecksum: a.checksum, content: '用户改为周日去博物馆，仍未订票。', sourceEventId: 'user-edits-note', expectedSourceRevision: '0' });
  expect(update.state).toBe('indexed'); expect(reopened.maintenanceWork.stats({ kind: 'organize' }).ready).toBe(1);
  expect(reopened.maintenanceWork.claim({ kind: 'organize', jobId: 'changed-version', limit: 24 }).items).toEqual([{ id: a.id, checksum: update.checksum }]);
});

it('classifies completed maintenance outputs as context without feeding another cycle, while later user edits become pending', async () => {
  const f = await fixture(), a = await f.seed('derived-a', '用户原计划去湖边，尚未出发。'), b = await f.seed('derived-b', '用户改去博物馆，尚未订票。');
  const work = f.host.maintenanceWork, batch = work.claim({ kind: 'organize', jobId: 'organize-cycle', limit: 24 });
  work.complete({ kind: 'organize', jobId: 'organize-cycle', sources: batch.items });
  const organized = await f.host.organize(f.rt, { operationId: 'maintenance-derived-organize', sourceEventId: 'maintenance-derived-organize', sources: [a, b].map(n => ({ id: n.id, expectedChecksum: n.checksum })), content: '用户原计划去湖边，后改为博物馆，尚未订票。', expectedSourceRevision: '0' });
  expect(organized.state).toBe('indexed'); expect(work.stats({ kind: 'organize' }).ready).toBe(0); expect(work.stats({ kind: 'dream' }).ready).toBe(0);
  expect(f.host.db.prepare('SELECT kind,state FROM maintenance_work WHERE note_id=?').all(organized.id)).toEqual([{ kind: 'organize', state: 'derived' }, { kind: 'dream', state: 'derived' }]);
  await f.seed('new-after-organize', '用户今天补充：已经预约，明天出发。'); expect(work.stats({ kind: 'organize' }).ready).toBe(1);
  const edited = await f.host.update(f.rt, { operationId: 'explicit-user-correction', sourceEventId: 'explicit-user-correction', id: organized.id, expectedChecksum: organized.checksum, content: '用户已确认博物馆预约成功，明天出发。', expectedSourceRevision: '0' });
  expect(edited.state).toBe('indexed'); expect(work.stats({ kind: 'organize' }).ready).toBe(2);
});
it('preserves an approved long organization body without an artificial character ceiling', async () => {
  const f = await fixture(), a = await f.seed('long-body-a', '完整来源甲。'), b = await f.seed('long-body-b', '完整来源乙。'), content = '完整来源甲，完整来源乙，保持全部细节与限定。\n'.repeat(2500);
  const receipt = await f.host.organize(f.rt, { operationId: 'maintenance-long-approved-body', sourceEventId: 'maintenance-long-approved-body', sources: [a, b].map(note => ({ id: note.id, expectedChecksum: note.checksum })), content, expectedSourceRevision: '0' });
  expect(content.length).toBeGreaterThan(24000); expect(receipt.state).toBe('indexed'); expect((await f.host.readNote({ id: receipt.id })).content).toBe(content);
});

it('imports historical analysis only for the exact current version and keeps failed versions retryable without blocking new notes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const f = await fixture(), a = await f.seed('old-reviewed', '已分析但无需改写的日记。'), b = await f.seed('old-changed', '这一版本尚未分析。');
    const work = f.host.maintenanceWork;
    work.seed({ records: [{ kind: 'organize', sources: [{ id: a.id, checksum: a.checksum }, { id: b.id, checksum: 'f'.repeat(32) }] }] });
    expect(work.stats({ kind: 'organize' }).ready).toBe(1);
    const failed = work.claim({ kind: 'organize', jobId: 'failure', limit: 24 }); expect(failed.items.map((n: { id: string }) => n.id)).toEqual([b.id]);
    work.release({ kind: 'organize', jobId: 'failure', reason: '模型证据无效。' });
    expect(work.stats({ kind: 'organize' })).toMatchObject({ ready: 0, retrying: 1 });
    const c = await f.seed('new-not-blocked', '另一篇新增日记，正常继续。'); expect(work.claim({ kind: 'organize', jobId: 'other-work', limit: 24 }).items.map((n: { id: string }) => n.id)).toEqual([c.id]);
    vi.setSystemTime(Date.now() + 300001); expect(work.stats({ kind: 'organize' }).ready).toBe(1);
    expect(work.claim({ kind: 'organize', jobId: 'retry-failed-version', limit: 24 }).items).toEqual(failed.items);
  } finally { vi.useRealTimers(); }
});

it('does not acknowledge a changed version using an older batch, and rejects unclaimed completion', async () => {
  const f = await fixture(), a = await f.seed('racing-edit', '最初的日记。'), work = f.host.maintenanceWork;
  const first = work.claim({ kind: 'organize', jobId: 'old-snapshot', limit: 24 });
  const changed = await f.host.update(f.rt, { operationId: 'user-edits-during-planning', sourceEventId: 'user-edits-during-planning', id: a.id, expectedChecksum: a.checksum, content: '用户刚刚明确更正了安排。', expectedSourceRevision: '0' });
  work.complete({ kind: 'organize', jobId: 'old-snapshot', sources: first.items });
  expect(work.claim({ kind: 'organize', jobId: 'new-snapshot', limit: 24 }).items).toEqual([{ id: a.id, checksum: changed.checksum }]);
  expect(() => work.complete({ kind: 'organize', jobId: 'new-snapshot', sources: [{ id: a.id, checksum: a.checksum }] })).toThrow('unclaimed');
});

it('keeps incremental selection on its pending index with 100,000 retained diary records', async () => {
  const f = await fixture(), work = f.host.maintenanceWork;
  const insert = f.host.db.prepare('INSERT INTO mutations(id,hash,state,checksum,created_at,source_event,content,tags_json) VALUES(?,?,?,?,?,?,?,?)');
  f.host.db.transaction(() => {
    for (let i = 0; i < 100000; i++) { const id = createHash('sha256').update('scale-' + i).digest('hex'); insert.run(id, id, i < 90000 ? 'archived' : 'indexed', 'a'.repeat(32), '2026-10-01T00:00:00Z', 'scale-' + i, '历史日记。', '[]'); }
    f.host.db.prepare("UPDATE maintenance_work SET state='reviewed'").run();
  })();
  const a = await f.seed('only-new-a', '今天新增的第一篇。'), b = await f.seed('only-new-b', '今天新增的第二篇。');
  expect(work.stats({ kind: 'organize' }).ready).toBe(2);
  const batch = work.claim({ kind: 'organize', jobId: 'large-history', limit: 24 }); expect(batch.items.map((n: { id: string }) => n.id).sort()).toEqual([a.id, b.id].sort());
  work.complete({ kind: 'organize', jobId: 'large-history', sources: batch.items }); expect(work.claim({ kind: 'organize', jobId: 'large-history-again', limit: 24 }).items).toEqual([]);
  const explain = f.host.db.prepare(`EXPLAIN QUERY PLAN SELECT w.note_id FROM maintenance_work w JOIN mutations m ON m.id=w.note_id WHERE w.kind=? AND w.state='pending' AND w.available_at<=? AND ${work.eligible()} ORDER BY w.available_at,w.sequence LIMIT 24`).all('organize', Date.now());
  expect(JSON.stringify(explain)).toContain('maintenance_work_ready'); expect(JSON.stringify(explain)).not.toMatch(/SCAN [mw](?:\b| )/u);
});

it('reserves semantically related historical context and pending reviews across both maintenance kinds', async () => {
  const f = await fixture(), old = await f.seed('historical-context', '用户原计划去湖边，尚未出发。'), unrelated = await f.seed('unrelated-history', '另一件不相关的往事。'), work = f.host.maintenanceWork;
  work.seed({ records: [{ kind: 'organize', sources: [old, unrelated] }] });
  const fresh = await f.seed('new-seed', '用户改为博物馆，尚未订票。');
  const batch = work.claim({ kind: 'organize', jobId: 'with-context', limit: 24 }); expect(batch.items.map((n: { id: string }) => n.id)).toEqual([fresh.id]);
  const oldPath = f.host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(old.id).note_path;
  expect(() => work.associate({ kind: 'organize', jobId: 'with-context', retrieval: { result: { content: [{ type: 'text', text: `[路径: ${pathToFileURL(path.join(f.home, 'dailynote', oldPath)).href}]\n[路径: file:///C:/outside/Companion/private.txt]` }] } } })).toThrow('current native retrieval');
  const related = work.associate({ kind: 'organize', jobId: 'with-context', retrieval: {
    engine: 'DailyNoteManager.Associate', sourceRevision: batch.revision, items: [{ ...old, seedIds: [fresh.id] }],
  } });
  expect(related.items).toEqual([{ id: old.id, checksum: old.checksum }]);
  work.complete({ kind: 'organize', jobId: 'with-context', sources: [...batch.items, ...related.items], reserved: [old.id, fresh.id] });
  expect(work.claim({ kind: 'organize', jobId: 'duplicate-plan', limit: 24 }).items).toEqual([]);
  expect(work.claim({ kind: 'dream', jobId: 'other-kind', limit: 24 }).items.map((n: { id: string }) => n.id)).toEqual([unrelated.id]);
  work.complete({ kind: 'organize', jobId: 'with-context', sources: [...batch.items, ...related.items], reserved: [] });
  expect(work.stats({ kind: 'organize' }).ready).toBe(0); expect(work.stats({ kind: 'dream' }).ready).toBe(2);
});

it('restores omitted historical context without turning it into new maintenance work', async () => {
  const f = await fixture(), old = await f.seed('omitted-context', '只作关联背景的旧记忆。'), work = f.host.maintenanceWork;
  work.seed({ records: [{ kind: 'organize', sources: [old] }] });
  await f.seed('omitted-new', '本批新日记。'); const batch = work.claim({ kind: 'organize', jobId: 'omit-context', limit: 24 });
  expect(work.associate({ kind: 'organize', jobId: 'omit-context', retrieval: {
    engine: 'DailyNoteManager.Associate', sourceRevision: batch.revision, items: [{ ...old, seedIds: [batch.items[0].id] }],
  } }).items).toHaveLength(1);
  work.complete({ kind: 'organize', jobId: 'omit-context', sources: batch.items });
  expect(work.stats({ kind: 'organize' }).ready).toBe(0); expect(f.host.db.prepare("SELECT state FROM maintenance_work WHERE kind='organize' AND note_id=?").get(old.id).state).toBe('reviewed');
});

it('does not leave unchanged surviving sources claimed after another source is withdrawn', async () => {
  const f = await fixture(), a = await f.seed('withdrawn-in-batch', '这篇随后撤回。'), b = await f.seed('surviving-in-batch', '独立来源仍然保留。'), work = f.host.maintenanceWork;
  work.claim({ kind: 'organize', jobId: 'expired-snapshot', limit: 24 }); f.host.stageWithdrawal({ noteIds: [a.id] });
  expect(work.stats({ kind: 'organize' }).ready).toBe(1); expect(work.claim({ kind: 'organize', jobId: 'fresh-after-withdrawal', limit: 24 }).items).toEqual([{ id: b.id, checksum: b.checksum }]);
});
it('releases obsolete pending reviews after withdrawal without requeueing their historical context', async () => {
  const f = await fixture(), old = await f.seed('review-context', '旧记忆只作背景。'), work = f.host.maintenanceWork; work.seed({ records: [{ kind: 'organize', sources: [old] }] });
  const fresh = await f.seed('review-new', '本批新增日记。'), batch = work.claim({ kind: 'organize', jobId: 'review-expired', limit: 24 });
  const related = work.associate({ kind: 'organize', jobId: 'review-expired', retrieval: {
    engine: 'DailyNoteManager.Associate', sourceRevision: batch.revision, items: [{ ...old, seedIds: [fresh.id] }],
  } });
  work.complete({ kind: 'organize', jobId: 'review-expired', sources: [...batch.items, ...related.items], reserved: [old.id, fresh.id] });
  const withdrawn = await f.seed('unrelated-withdrawal', '随后撤回的独立日记。'); f.host.stageWithdrawal({ noteIds: [withdrawn.id] });
  expect(work.claim({ kind: 'organize', jobId: 'after-review-expired', limit: 24 }).items).toEqual([{ id: fresh.id, checksum: fresh.checksum }]);
  expect(f.host.db.prepare("SELECT state FROM maintenance_work WHERE kind='organize' AND note_id=?").get(old.id).state).toBe('reviewed');
});
it('fences maintenance mutations at the host FIFO with the real tombstone revision and preserves legacy callers', async () => {
  const f = await fixture(), note = await f.seed('a', '旧内容仍有效。');
  f.host.stageWithdrawal({ sourceEventIds: ['unrelated-source'] });
  const update = { operationId: 'stale', id: note.id, expectedChecksum: note.checksum, content: '不应写入。', sourceEventId: 'stale-write', expectedSourceRevision: '0' };
  await expect(f.host.update(f.rt, update)).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' });
  expect((await f.host.readNote({ id: note.id })).checksum).toBe(note.checksum);
  await expect(f.host.update(f.rt, { ...update, expectedSourceRevision: '-1' })).rejects.toThrow('revision');
  const { expectedSourceRevision: _revision, ...legacy } = update; void _revision;
  expect(await f.host.update(f.rt, { ...legacy, operationId: 'legacy' })).toMatchObject({ state: 'indexed' });
});
it('archives exactly one note with CAS and index-absence receipts while retaining source siblings and no tombstones', async () => {
  const f = await fixture(), a = await f.seed('a', '同源事实A', 'shared-root'), b = await f.seed('b', '同源事实B', 'shared-root');
  const input = { operationId: 'archive-a', id: a.id, expectedChecksum: a.checksum, expectedSourceRevision: '0' };
  const receipt = await f.host.maintenance.archive(f.rt, input);
  expect(receipt).toMatchObject({ state: 'archived', retained: true, checksum: a.checksum });
  expect(await f.host.readNote({ id: a.id })).toMatchObject({ indexState: 'archived', content: '同源事实A' });
  expect(await f.host.readNote({ id: b.id })).toMatchObject({ indexState: 'indexed', content: '同源事实B' }); expect(f.host.tombstones()).toMatchObject({ revision: '0', sourceEventIds: [] });
  expect(await f.host.maintenance.archive(f.rt, input)).toEqual(receipt); expect(await readdir(path.join(f.home, 'dailynote/已整理'))).toHaveLength(1);
  expect(f.host.catalog({}).liveEligibleCount).toBe(1);
});
it('keeps archive partial when delete indexing fails and resumes the same durable copy without duplication', async () => {
  const f = await fixture(), note = await f.seed('a', '原件内容保留。'); const input = { operationId: 'archive-index', id: note.id, expectedChecksum: note.checksum, expectedSourceRevision: '0' };
  f.rt.setFailDelete(true); expect(await f.host.maintenance.archive(f.rt, input)).toMatchObject({ state: 'partial' });
  expect(f.host.catalog({}).liveEligibleCount).toBe(0);
  expect(() => f.host.maintenance.assertReadable()).toThrow('index receipt');
  await expect(f.host.readNote({ id: note.id })).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
  f.rt.setFailDelete(false); expect(await f.host.maintenance.archive(f.rt, input)).toMatchObject({ state: 'archived', retained: true });
  expect(() => f.host.maintenance.assertReadable()).not.toThrow();
  expect(await readdir(path.join(f.home, 'dailynote/已整理'))).toHaveLength(1);
});
it('rejects stale archive CAS without moving any file', async () => {
  const f = await fixture(), note = await f.seed('a', '旧日记。');
  await f.host.update(f.rt, { operationId: 'update', id: note.id, expectedChecksum: note.checksum, content: '新的真实版本。', sourceEventId: 'correction' });
  await expect(f.host.maintenance.archive(f.rt, { operationId: 'archive', id: note.id, expectedChecksum: note.checksum, expectedSourceRevision: '0' })).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
  expect((await f.host.readNote({ id: note.id })).content).toBe('新的真实版本。');
});
it('writes approved insight with an explicit non-fact label and directional parent withdrawal lineage', async () => {
  const f = await fixture(), a = await f.seed('a', '用户的计划。'), b = await f.seed('b', '独立另一事实。');
  const input = { operationId: 'insight', sources: [{ id: a.id, expectedChecksum: a.checksum }], content: '这也许象征对探索的期待。', tags: '探索', sourceEventId: 'dream-insight', expectedSourceRevision: '0' };
  const result = await f.host.maintenance.insight(f.rt, input); expect(result).toMatchObject({ state: 'indexed' });
  expect(await f.host.readNote({ id: result.id })).toMatchObject({ content: expect.stringContaining('梦境感悟（非用户事实）') });
  expect(await f.host.maintenance.insight(f.rt, input)).toEqual(result);
  f.host.stageWithdrawal({ noteIds: [a.id] }); expect(f.host.blocked('note', result.id)).toBe(true); expect(f.host.blocked('note', b.id)).toBe(false);
});
it('rechecks parent checksum after a prepared insight crashes or its index fails, without creating a second stale insight', async () => {
  const f = await fixture(), a = await f.seed('a', '尚未执行的原计划。');
  const input = { operationId: 'insight-stale', sources: [{ id: a.id, expectedChecksum: a.checksum }], content: '候选感悟。', sourceEventId: 'insight-stale', expectedSourceRevision: '0' };
  f.rt.setFailIndex(true); expect(await f.host.maintenance.insight(f.rt, input)).toMatchObject({ state: 'unknown' }); f.rt.setFailIndex(false);
  await f.host.update(f.rt, { operationId: 'parent-update', id: a.id, expectedChecksum: a.checksum, content: '计划已经明确取消。', sourceEventId: 'parent-correction' });
  const count = f.host.db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
  await expect(f.host.maintenance.insight(f.rt, input)).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' }); expect(f.host.db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n).toBe(count);
});
it('can approve insight after its parents were organized, and parent withdrawal never walks backward into independent siblings', async () => {
  const f = await fixture(), a = await f.seed('a', '用户计划去博物馆。'), b = await f.seed('b', '另一作者讨论路线但尚未行动。');
  const merged = await f.host.organize(f.rt, { operationId: 'organize-first', sources: [a, b].map(note => ({ id: note.id, expectedChecksum: note.checksum })),
    content: '用户计划去博物馆，另一作者仅讨论路线，尚未行动。', sourceEventId: 'merged', expectedSourceRevision: '0' }); expect(merged.state).toBe('indexed');
  const insight = await f.host.maintenance.insight(f.rt, { operationId: 'insight-after-archive', sources: [a, b].map(note => ({ id: note.id, expectedChecksum: note.checksum })),
    content: '梦境联想：也许在探索新的方向，并非用户事实。', sourceEventId: 'insight-after-archive', sourceMessageIds: ['message-a', 'message-b'], expectedSourceRevision: '0' });
  expect(insight.state).toBe('indexed'); expect(await f.host.readNote({ id: a.id })).toMatchObject({ indexState: 'archived' });
  const result = await f.host.forget(f.rt, { id: a.id, companionId: 'owner' }); f.host.completeWithdrawal();
  expect(result.relatedIds).toContain(insight.id); expect(result.relatedIds).toContain(merged.id); expect(result.relatedIds).not.toContain(b.id);
  expect(await f.host.readNote({ id: b.id })).toMatchObject({ indexState: 'archived', content: b.content });
});
it('lets a real source withdrawal clean a pending old-epoch update without replaying it or losing its original receipt', async () => {
  const f = await fixture(), a = await f.seed('a', '原用户事实。'), b = await f.seed('b', '另一独立事实。');
  f.rt.setFailIndex(true);
  expect(await f.host.update(f.rt, { operationId: 'pending-update', id: a.id, expectedChecksum: a.checksum, content: '已写文件但索引待确认。', sourceEventId: 'maintenance-update', expectedSourceRevision: '0' })).toMatchObject({ state: 'pending' });
  f.rt.setFailIndex(false); f.host.stageWithdrawal({ noteIds: [a.id] });
  const result = await f.host.repairWithdrawals(f.rt, 'owner'); expect(result.relatedIds).toContain(a.id); f.host.completeWithdrawal();
  expect(f.host.db.prepare('SELECT state FROM managed_operations WHERE operation_id=?').get('pending-update').state).toBe('withdrawn');
  const audit = f.host.db.prepare('SELECT prior_state,prior_receipt FROM maintenance_reconciliations WHERE operation_id=?').get('pending-update'); expect(audit.prior_state).toBe('pending'); expect(JSON.parse(audit.prior_receipt).indexed).toBe(false);
  expect(() => f.host.managed.assertReadable()).not.toThrow(); expect(await f.host.readNote({ id: b.id })).toMatchObject({ indexState: 'indexed', content: '另一独立事实。' });
});
it('releases an archive recall fence only after actual withdrawn-source cleanup, retaining its partial history', async () => {
  const f = await fixture(), note = await f.seed('a', '仍须可追溯的内容。');
  f.rt.setFailDelete(true); expect(await f.host.maintenance.archive(f.rt, { operationId: 'partial-archive', id: note.id, expectedChecksum: note.checksum, expectedSourceRevision: '0' })).toMatchObject({ state: 'partial' });
  f.host.stageWithdrawal({ noteIds: [note.id] }); expect(() => f.host.maintenance.assertReadable()).toThrow();
  f.rt.setFailDelete(false); await f.host.repairWithdrawals(f.rt, 'owner'); f.host.completeWithdrawal();
  expect(() => f.host.maintenance.assertReadable()).not.toThrow(); expect(f.host.db.prepare('SELECT state FROM maintenance_operations WHERE operation_id=?').get('partial-archive').state).toBe('withdrawn');
  expect(f.host.db.prepare('SELECT prior_state FROM maintenance_reconciliations WHERE operation_id=?').get('partial-archive').prior_state).toBe('partial');
});
it('observes old-epoch bytes and native receipts without replay: an unconfirmed index remains blocked', async () => {
  const f = await fixture(), note = await f.seed('a', '旧内容。'); f.rt.setFailIndex(true);
  expect(await f.host.update(f.rt, { operationId: 'unrelated-epoch', id: note.id, expectedChecksum: note.checksum, content: '新文件但未索引。', sourceEventId: 'maintenance-update', expectedSourceRevision: '0' })).toMatchObject({ state: 'pending' });
  f.rt.setFailIndex(false); f.host.stageWithdrawal({ sourceEventIds: ['unrelated-event'] });
  const writes = vi.spyOn(f.rt.kb, 'runExternalFileMutation'); await f.host.repairWithdrawals(f.rt, 'owner'); f.host.completeWithdrawal();
  expect(writes).not.toHaveBeenCalled(); expect(f.host.db.prepare('SELECT state FROM managed_operations WHERE operation_id=?').get('unrelated-epoch').state).toBe('unknown');
  expect(() => f.host.managed.assertReadable()).toThrow();
});
it('reconciles an actually indexed old-epoch result from exact bytes/probes without repeating its write', async () => {
  const f = await fixture(), note = await f.seed('a', '原内容。'), originalSync = f.host.sync.bind(f.host); let loseReceipt = true;
  f.host.sync = async (...args: unknown[]) => { const result = await originalSync(...args); if (loseReceipt) { loseReceipt = false; throw Object.assign(new Error('Receipt lost after native commit'), { code: 'TEST_RECEIPT_LOSS' }); } return result; };
  expect(await f.host.update(f.rt, { operationId: 'indexed-before-epoch', id: note.id, expectedChecksum: note.checksum, content: '真正索引完成的内容。', sourceEventId: 'maintenance-update', expectedSourceRevision: '0' })).toMatchObject({ state: 'pending' });
  f.host.stageWithdrawal({ sourceEventIds: ['unrelated-event'] }); const writes = vi.spyOn(f.rt.kb, 'runExternalFileMutation');
  await f.host.repairWithdrawals(f.rt, 'owner'); f.host.completeWithdrawal();
  expect(writes).not.toHaveBeenCalled(); expect(f.host.db.prepare('SELECT state FROM managed_operations WHERE operation_id=?').get('indexed-before-epoch').state).toBe('indexed');
  expect(await f.host.readNote({ id: note.id })).toMatchObject({ indexState: 'indexed', content: '真正索引完成的内容。' });
});
