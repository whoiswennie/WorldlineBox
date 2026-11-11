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
it('runs the preserved DreamWaveEngine against only verified owned sources and retains original wave roles/scores', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const f = await fixture(), a = await f.seed('a', '用户的博物馆计划，尚未预约。'), b = await f.seed('b', '伙伴讨论博物馆路线，尚未执行。'), outside = await f.seed('outside', '本批不允许进入梦境的日记。');
  const wave = await f.host.maintenance.dreamRecall(f.rt, { sources: [a, b].map(note => ({ id: note.id, expectedChecksum: note.checksum })), expectedSourceRevision: '0' });
  expect(wave).toMatchObject({ engine: 'DreamWaveEngine', namespace: 'Companion', examined: 2 }); expect(f.rt.nativeQueries).toHaveBeenCalled();
  const hits = Object.values(wave.groups).flat() as Array<{ id: string; score?: number }>;
  expect(hits.some(hit => hit.id === a.id)).toBe(true); expect(hits.every(hit => [a.id, b.id].includes(hit.id))).toBe(true); expect(hits.some(hit => hit.id === outside.id)).toBe(false);
  expect(hits.filter(hit => hit.score !== undefined).every(hit => [0.81, 0.8].some(score => Math.abs(score - hit.score!) < 1e-9))).toBe(true);
  expect(wave.omitted.filteredCandidates).toBeGreaterThan(0); expect(JSON.stringify(wave)).not.toContain(f.home);
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
  const related = work.associate({ kind: 'organize', jobId: 'with-context', retrieval: { result: { content: [{ type: 'text', text: `[路径: ${pathToFileURL(path.join(f.home, 'dailynote', oldPath)).href}]\n[路径: file:///C:/outside/Companion/private.txt]` }] } } });
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
  const oldPath = f.host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(old.id).note_path;
  expect(work.associate({ kind: 'organize', jobId: 'omit-context', retrieval: { results: [{ fullPath: oldPath }] } }).items).toHaveLength(1);
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
  const oldPath = f.host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(old.id).note_path, related = work.associate({ kind: 'organize', jobId: 'review-expired', retrieval: { results: [{ fullPath: oldPath }] } });
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
