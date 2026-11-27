import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(path.resolve('resources/vcp-memory/package.json'));
const { BotHost } = require('./lib/bot-host.cjs');
const roots: string[] = [], hosts: Array<{ close(): void }> = [];
afterEach(async () => { for (const host of hosts.splice(0)) host.close(); for (const root of roots.splice(0)) {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('bot-managed-')) throw new Error('Unexpected owned test root');
  await rm(root, { recursive: true, force: true });
} });
const md5 = (text: string) => createHash('md5').update(text).digest('hex');
interface Receipt { path: string; exists: boolean; checksum?: string; completeVectors?: boolean; completeTags?: boolean }
// Index receipts are a local seam here; real files, SQLite, CAS, process exits,
// provenance and recovery are exercised. This does not measure VCP relevance.
function runtime(home: string) {
  const index = new Map<string, Receipt>(), pending = new Set<string>(); let failIndex = false, failDelete = false;
  const relative = (file: string) => path.relative(path.join(home, 'dailynote'), file).replaceAll('\\', '/');
  const flush = async () => {
    if (failIndex) throw Object.assign(new Error('Index transport unavailable'), { code: 'TEST_INDEX_FAILURE' });
    for (const file of pending) { const text = await readFile(file, 'utf8'); index.set(relative(file), { path: relative(file), exists: true, checksum: md5(text), completeVectors: true, completeTags: true }); }
    pending.clear();
  };
  const kb = { config: { ignorePrefixes: ['已整理'] }, pendingFiles: pending, _flushBatch: flush, ingestionPipeline: { drain: async () => {} },
    probeIngestionFiles: async (paths: string[]) => paths.map(value => index.get(value) ?? { path: value, exists: false }),
    runExternalFileMutation: async (_name: string, fn: () => Promise<{ mutationPaths: { upserts: string[]; deletes: string[] } }>, options: { waitForIndex?: boolean }) => {
      const result = await fn();
      if (result.mutationPaths.deletes.length && failDelete) throw Object.assign(new Error('Delete receipt unavailable'), { code: 'TEST_DELETE_FAILURE' });
      for (const file of result.mutationPaths.deletes) index.delete(relative(file));
      for (const file of result.mutationPaths.upserts) pending.add(file);
      if (options.waitForIndex) await flush(); return result;
    } };
  return { config: { DEFAULT_TIMEZONE: 'Asia/Shanghai' }, kb, index, start: async () => {},
    setFailIndex(value: boolean) { failIndex = value; }, setFailDelete(value: boolean) { failDelete = value; },
    _require: () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined }), exec: () => {} }) }),
    callTool: async (_name: string, input: { Date: string; Content: string; Tag: string; fileName: string }) => {
      const dir = path.join(home, 'dailynote/Companion'); await mkdir(dir, { recursive: true });
      const explicit = /^\[(\d\d):(\d\d):(\d\d)\]\n/u.exec(input.Content);
      const time = explicit ? explicit.slice(1).join('_') : '12_00_00', body = explicit ? input.Content : '[12:00]\n' + input.Content;
      const filename = `${input.Date}-${time}-${input.fileName}.txt`, file = path.join(dir, filename);
      await writeFile(file, `[${input.Date}] - Companion\n${body}\nTag: ${input.Tag}`, { flag: 'wx' }); pending.add(file);
      return { status: 'success', result: { folder: 'Companion', fileName: filename } };
    } };
}
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-managed-')); roots.push(home);
  const host = new BotHost(home); hosts.push(host); const rt = runtime(home);
  const seed = async (key: string, content: string, tags = '整理,偏好') => {
    const receipt = await host.remember(rt, { sourceEventId: key, sourceMessageIds: [], content, tags }); await host.sync(rt, { id: receipt.id }); return host.readNote({ id: receipt.id });
  };
  return { home, host, rt, seed };
}
it('CAS-updates only an owned physical note, keeps provenance and an immutable operation receipt, and refuses stale versions', async () => {
  const f = await fixture(), note = await f.seed('source-a', '当前上限20分钟。'), other = await f.seed('other', '不能修改的另一篇。');
  const input = { operationId: 'update-once', id: note.id, expectedChecksum: note.checksum, content: '更正为12分钟。', tags: '更正,偏好', sourceEventId: 'correction', sourceMessageIds: ['correction-message'] };
  const result = await f.host.update(f.rt, input);
  expect(result).toMatchObject({ status: 'success', state: 'indexed', id: note.id, indexed: true }); expect(result.checksum).not.toBe(note.checksum);
  expect(await f.host.readNote({ id: note.id })).toMatchObject({ content: input.content, checksum: result.checksum, tags: ['更正', '偏好'] });
  expect(await f.host.update(f.rt, input)).toEqual(result);
  await expect(f.host.update(f.rt, { ...input, content: '不能复用原操作号。' })).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
  expect(await f.host.update(f.rt, { ...input, operationId: 'stale-update' })).toMatchObject({ status: 'conflict', updated: false, actualChecksum: result.checksum });
  expect((await f.host.readNote({ id: other.id })).content).toBe(other.content);
  expect(f.host.operationReceipt({ operationId: input.operationId })).toEqual({ found: true, receipt: result });
  expect(f.host.operationReceipt({ operationId: input.operationId, kind: 'update', input })).toEqual({ found: true, receipt: result });
  expect(() => f.host.operationReceipt({ operationId: input.operationId, kind: 'update', input: { ...input, content: '不同的修订' } })).toThrow(/parameters differ/);
  expect(await f.host.remember(f.rt, { sourceEventId: 'source-a', sourceMessageIds: [], content: '当前上限20分钟。' })).toMatchObject({ checksum: result.checksum, state: 'indexed' });
  expect((await f.host.readNote({ id: note.id })).content).toBe(input.content);
  const sources = f.host.db.prepare('SELECT kind,id FROM mutation_sources WHERE note_id=?').all(note.id);
  expect(sources).toEqual(expect.arrayContaining([{ kind: 'event', id: 'source-a' }, { kind: 'event', id: 'correction' }, { kind: 'message', id: 'correction-message' }]));
});

it('rechecks cross-diary evidence on a resumed annotation and withdraws the derived tracked note with that evidence', async () => {
  const f = await fixture(), target = await f.seed('track-original', '周五可能试运行。'), evidence = await f.seed('track-result', '试运行已经结束。');
  const unrelated = await f.seed('unrelated-track', '单独的演出安排。');
  const annotation = { operationId: 'annotate', sourceEventId: 'tracking', expectedSourceRevision: '0', id: target.id, expectedChecksum: target.checksum,
    evidenceSources: [{ id: evidence.id, expectedChecksum: evidence.checksum }], content: '周五可能试运行。\n状态注记：已结束。' };
  await f.host.managed.makePlan(annotation, 'update');
  const corrected = await f.host.update(f.rt, { operationId: 'correct-result', sourceEventId: 'correcting', id: evidence.id,
    expectedChecksum: evidence.checksum, content: '周五试运行已结束并提交报告。' });
  expect(await f.host.update(f.rt, annotation)).toMatchObject({ state: 'conflict' });
  expect(await f.host.readNote({ id: target.id })).toMatchObject({ checksum: target.checksum });
  const resumed = { ...annotation, operationId: 'annotate-with-current-version', evidenceSources: [{ id: evidence.id, expectedChecksum: corrected.checksum }] };
  const annotated = await f.host.update(f.rt, resumed);
  expect(annotated).toMatchObject({ state: 'indexed', id: target.id });
  expect(await f.host.update(f.rt, resumed)).toEqual(annotated);
  await expect(f.host.update(f.rt, { ...resumed, operationId: 'circular-track', id: evidence.id, expectedChecksum: corrected.checksum,
    evidenceSources: [{ id: target.id, expectedChecksum: annotated.checksum }] })).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
  const removed = await f.host.forget(f.rt, { id: evidence.id, companionId: 'owner' });
  expect(removed.relatedIds.sort()).toEqual([target.id, evidence.id].sort());
  await expect(f.host.readNote({ id: target.id })).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
  expect(await f.host.readNote({ id: unrelated.id })).toMatchObject({ checksum: unrelated.checksum, indexState: 'indexed' });
});

it('pages the maintenance inventory by verified source identity, including reviewed notes and omitting unfinished and withdrawn records', async () => {
  const f = await fixture(), notes = [];
  for (let n = 0; n < 9; n++) notes.push(await f.seed('inventory-' + n, '库存第' + n + '条。'));
  const [pending, archived, stale, unowned, busy, approved, other, last, revoked] = notes;
  f.host.db.prepare("UPDATE mutations SET state='pending' WHERE id=?").run(pending.id);
  f.host.db.prepare("UPDATE mutations SET state='archived' WHERE id=?").run(archived.id);
  f.host.db.prepare("UPDATE mutations SET state='unknown' WHERE id=?").run(stale.id);
  f.host.db.prepare('DELETE FROM mutation_sources WHERE note_id=?').run(unowned.id);
  await f.host.managed.makePlan({ operationId: 'inventory-uncommitted', sourceEventId: 'unfinished', id: busy.id,
    expectedChecksum: busy.checksum, content: '修改仍未提交。' }, 'update');
  f.host.db.prepare("UPDATE maintenance_work SET state='reviewed' WHERE note_id=?").run(approved.id);
  f.host.db.prepare("UPDATE maintenance_work SET state='derived' WHERE note_id=?").run(other.id);
  f.host.db.prepare("INSERT INTO tombstones(kind,id,created_at) VALUES('event',?,?)").run('inventory-8', new Date().toISOString());
  const page = f.host.catalog({ indexedOnly: true, limit: 2 });
  expect(page.items).toHaveLength(2);
  expect(page.items[1].afterCursor).toBe(page.nextCursor);
  const fromMiddle = f.host.catalog({ indexedOnly: true, cursor: page.items[0].afterCursor, limit: 2 });
  expect(fromMiddle.items[0].id).toBe(page.items[1].id);
  expect([page.items[0], ...fromMiddle.items].map(row => row.id).sort()).toEqual([approved.id, other.id, last.id].sort());
  expect(fromMiddle.nextCursor).toBeUndefined();
  expect(JSON.stringify(page)).not.toContain(revoked.id);
  expect(() => f.host.catalog({ indexedOnly: true, limit: 21 })).toThrow();
});

it('uses the diary’s recorded local day for an inclusive indexed date range and keeps the range bound to its page cursor', async () => {
  const f = await fixture(), indexed = [];
  for (const [n, day] of ['2024-02-28','2024.02.29','2024-03-01','2024-03-01','2024-03-02','legacy'].entries()) {
    const note = await f.seed('dated-' + n, '海边日录第' + n + '篇。');
    const row = f.host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(note.id);
    const file = 'Companion/' + day + '-' + note.id + '.txt';
    await rename(f.host.notePath(row.note_path), f.host.notePath(file));
    f.host.db.prepare('UPDATE mutations SET note_path=?,created_at=? WHERE id=?')
      .run(file, day === 'legacy' ? '2024-02-29T16:00:01.123Z' : '2026-11-27T10:00:00.000Z', note.id);
    indexed.push({ id: note.id, day: day === 'legacy' ? '2024-03-01' : day.replaceAll('.', '-') });
  }
  const filter = { indexedOnly: true, fromDate: '2024-02-29', toDate: '2024-03-01', limit: 2 };
  const first = f.host.catalog(filter), rest = f.host.catalog({ ...filter, cursor: first.nextCursor });
  const matches = [...first.items, ...rest.items];
  expect(matches.map(note => note.id).sort()).toEqual(indexed.filter(note => note.day >= filter.fromDate && note.day <= filter.toDate).map(note => note.id).sort());
  expect(matches.map(note => note.diaryDate)).toEqual(['2024-03-01','2024-03-01','2024-03-01','2024-02-29']);
  expect(rest.nextCursor).toBeUndefined();
  expect(f.host.catalog({ indexedOnly: true, fromDate: '2024-03-02' }).items).toHaveLength(1);
  expect(f.host.catalog({ indexedOnly: true, toDate: '2024-02-28' }).items).toHaveLength(1);
  expect(() => f.host.catalog({ ...filter, toDate: '2024-03-02', cursor: first.nextCursor })).toThrow(/cursor/);
  expect(() => f.host.catalog({ indexedOnly: true, fromDate: '2026-02-29' })).toThrow(/date range/);
  expect(() => f.host.catalog({ indexedOnly: true, fromDate: '2024-03-01', toDate: '2024-02-29' })).toThrow(/date range/);
});
it('returns a durable pending receipt when indexing fails, and resumes the same operation without a second write identity', async () => {
  const f = await fixture(), note = await f.seed('source', '旧安排。'); f.rt.setFailIndex(true);
  const input = { operationId: 'pending-update', id: note.id, expectedChecksum: note.checksum, content: '新安排。', sourceEventId: 'new-source' };
  expect(await f.host.update(f.rt, input)).toMatchObject({ status: 'pending', state: 'pending', indexed: false, fileCommitted: true });
  f.rt.setFailIndex(false); await f.host.managed.repair(f.rt);
  expect(f.host.operationReceipt({ operationId: input.operationId })).toMatchObject({ found: true, receipt: { state: 'indexed' } });
  expect((await readdir(path.join(f.home, 'dailynote/Companion'))).filter(name => !name.startsWith('.'))).toHaveLength(1);
});
it('does not overwrite a third file version and blocks unknown-note reads and query admission', async () => {
  const f = await fixture(), note = await f.seed('source', '旧安排。'); f.rt.setFailIndex(true);
  const input = { operationId: 'interrupted', id: note.id, expectedChecksum: note.checksum, content: '待确认的新安排。', sourceEventId: 'update-source' };
  await f.host.update(f.rt, input);
  const raw = f.host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(note.id);
  const file = f.host.notePath(raw.note_path); await writeFile(file, '外部第三版本，不能覆盖。'); f.rt.setFailIndex(false);
  await expect(f.host.update(f.rt, input)).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
  expect(await readFile(file, 'utf8')).toBe('外部第三版本，不能覆盖。');
  await expect(f.host.readNote({ id: note.id })).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
  expect(() => f.host.managed.assertReadable()).toThrow(/reconciliation/);
  expect(f.host.operationReceipt({ operationId: input.operationId })).toMatchObject({ found: true, receipt: { state: 'unknown' } });
});
it('rejects a redirected managed directory without writing the external target', async () => {
  const f = await fixture(), note = await f.seed('source', '不能移动的原件。');
  const external = await mkdtemp(path.join(os.tmpdir(), 'bot-managed-')); roots.push(external);
  const dir = path.join(f.home, 'dailynote/Companion');
  await rm(dir, { recursive: true, force: true }); await symlink(external, dir, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(f.host.update(f.rt, { operationId: 'link-reject', id: note.id, expectedChecksum: note.checksum, content: '拒绝写入。', sourceEventId: 'new' })).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
  expect(await readdir(external)).toEqual([]);
});
it('indexes a new organized note before archiving exact originals and withdraws derived output with its parent source', async () => {
  const f = await fixture(), a = await f.seed('a', '蓝色收纳盒。'), b = await f.seed('b', '只整理西北角。');
  const input = { operationId: 'organize-once', sources: [{ id: a.id, expectedChecksum: a.checksum }, { id: b.id, expectedChecksum: b.checksum }],
    content: '使用蓝色收纳盒，仅整理西北角。', tags: '收纳,方案', sourceEventId: 'organized-source' };
  const result = await f.host.organize(f.rt, input);
  expect(result).toMatchObject({ status: 'success', state: 'indexed', archived: [a.id, b.id] });
  expect(await f.host.organize(f.rt, input)).toEqual(result);
  expect((await readdir(path.join(f.home, 'dailynote/Companion'))).filter(name => !name.startsWith('.'))).toHaveLength(1);
  expect(await readdir(path.join(f.home, 'dailynote/已整理'))).toHaveLength(2);
  expect([...f.rt.index.values()].filter(value => value.exists)).toHaveLength(1);
  expect((await f.host.readNote({ id: result.id })).content).toBe(input.content);
  expect(await f.host.forget(f.rt, { id: a.id, companionId: 'owner' })).toMatchObject({ forgotten: true, relatedIds: expect.arrayContaining([a.id, result.id]) });
  await expect(f.host.readNote({ id: result.id })).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
  expect(await f.host.readNote({ id: b.id })).toMatchObject({ id: b.id, content: b.content, indexState: 'archived' });
  expect(f.host.tombstones().sourceEventIds).not.toContain('b');
});
it('keeps a partial organize journal when deletion receipts fail and resumes without making a duplicate merged note', async () => {
  const f = await fixture(), note = await f.seed('source', '整理前的原文。'); f.rt.setFailDelete(true);
  const input = { operationId: 'partial-archive', sources: [{ id: note.id, expectedChecksum: note.checksum }], content: '整理后的独立记录。', sourceEventId: 'organized' };
  expect(await f.host.organize(f.rt, input)).toMatchObject({ status: 'partial', state: 'partial', indexed: false });
  f.rt.setFailDelete(false);
  expect(await f.host.organize(f.rt, input)).toMatchObject({ status: 'success', state: 'indexed', archived: [note.id] });
  expect(await readdir(path.join(f.home, 'dailynote/已整理'))).toHaveLength(1);
  expect((await readdir(path.join(f.home, 'dailynote/Companion'))).filter(name => !name.startsWith('.'))).toHaveLength(1);
});

it('recovers a lost DailyNote.create reply for the second volume without archiving prematurely or duplicating either output', async () => {
  const f = await fixture(), a = await f.seed('source-a', '开始尝试分批。'), b = await f.seed('source-b', '分批核对让更正更容易。');
  const input = { operationId: 'maintenance-pair', sourceEventId: 'pair-source', sources: [a, b].map(note => ({ id: note.id, expectedChecksum: note.checksum })),
    content: '先分批整理，随后完成核对。', tags: '项目甲,经过', crystal: { content: '分批核对可保留更正线索。', tags: ['项目甲','方法'] } };
  const call = f.rt.callTool; let creates = 0;
  f.rt.callTool = async (name, args) => { creates++; await call(name, args); throw Error('Lost DailyNote reply after file commit'); };
  const partial = await f.host.organize(f.rt, input);
  expect(partial).toMatchObject({ state: 'partial', indexed: false });
  expect((await f.host.readNote({ id: a.id })).indexState).toBe('indexed');
  expect(f.host.operationReceipt({ operationId: input.operationId }).receipt).not.toHaveProperty('crystal.indexed', true);
  f.host.close(); hosts.splice(hosts.indexOf(f.host), 1);
  const reopened = new BotHost(f.home); hosts.push(reopened);
  const chroniclePath = reopened.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(partial.id).note_path;
  f.rt.index.delete(chroniclePath);
  const done = await reopened.organize(f.rt, input);
  expect(f.rt.index.get(chroniclePath)).toMatchObject({ exists: true, completeVectors: true, completeTags: true });
  expect(done).toMatchObject({ state: 'indexed', crystal: { indexed: true }, archived: [a.id,b.id] });
  expect(creates).toBe(1); expect(await reopened.organize(f.rt, input)).toEqual(done);
  for (const [volume, tags] of [[done,['项目甲','经过']], [done.crystal,['项目甲','方法']]] as const) {
    expect(await reopened.readNote({ id: volume.id })).toMatchObject({ tags, indexState: 'indexed', checksum: volume.checksum });
    expect(reopened.db.prepare('SELECT state FROM maintenance_work WHERE note_id=?').all(volume.id)).toEqual([{state:'derived'},{state:'derived'}]);
  }
  expect(await readdir(path.join(f.home,'dailynote/Companion'))).toHaveLength(2);
  await expect(reopened.organize(f.rt, { ...input, crystal: { ...input.crystal, content: '不同的结论' } })).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
  const forgotten = await reopened.forget(f.rt, { id: b.id, companionId: 'owner' });
  expect(forgotten.relatedIds).toEqual(expect.arrayContaining([done.id, done.crystal.id]));
  expect(await readdir(path.join(f.home,'dailynote/Companion'))).toEqual([]);
  expect(await reopened.readNote({ id: a.id })).toMatchObject({ indexState: 'archived' });
});
it('revokes both planned volumes when an original event is withdrawn before DailyNote creates the second file', async () => {
  const f = await fixture(), note = await f.seed('original-event', '第一次在北门采样。');
  const input = { operationId: 'maintenance-interrupted-pair', sourceEventId: 'planned-pair', expectedSourceRevision: '0',
    sources: [{ id: note.id, expectedChecksum: note.checksum }], content: '采样地点是北门。', tags: '采样,经过', crystal: { content: '核对采样地点。', tags: ['采样','方法'] } };
  f.rt.callTool = async () => { throw Error('Native diary temporarily offline'); };
  const partial = await f.host.organize(f.rt, input);
  expect(partial).toMatchObject({ state: 'partial', indexed: false });
  const crystal = f.host.db.prepare('SELECT note_id FROM managed_operation_sources WHERE operation_id=? AND note_id NOT IN (?,?)').get(input.operationId, note.id, partial.id).note_id;
  const result = await f.host.withdrawSources(f.rt, { companionId: 'owner', sourceEventIds: ['original-event'] });
  expect(result.relatedIds).toEqual(expect.arrayContaining([note.id, partial.id, crystal]));
  expect(await readdir(path.join(f.home, 'dailynote/Companion'))).toEqual([]);
  expect(f.host.operationReceipt({ operationId: input.operationId })).toMatchObject({ found: true, receipt: { state: 'withdrawn' } });
  await expect(f.host.readNote({ id: crystal })).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
});
it('organizes twenty owned originals in one operation and rejects a twenty-first before creating any output', async () => {
  const f = await fixture(), sources: Array<{ id: string; expectedChecksum: string }> = [];
  for (let index = 0; index < 21; index++) {
    const note = await f.seed('observation-' + index, '采样记录 ' + index);
    sources.push({ id: note.id, expectedChecksum: note.checksum });
  }
  const input = { operationId: 'batch-size', sourceEventId: 'organized-batch', sources, content: '汇总记录前二十次采样。' };
  await expect(f.host.organize(f.rt, input)).rejects.toThrow(/twenty/u);
  expect(f.host.operationReceipt({ operationId: input.operationId })).toMatchObject({ found: false });
  const result = await f.host.organize(f.rt, { ...input, sources: sources.slice(0, 20) });
  expect(result).toMatchObject({ state: 'indexed', archived: sources.slice(0, 20).map(source => source.id) });
  expect(await f.host.readNote({ id: sources[20]!.id })).toMatchObject({ indexState: 'indexed' });
});
it('uses stable SQL keyset pages, exact tag filters and bounded Unicode previews without reading whole bodies', async () => {
  const f = await fixture();
  for (let index = 0; index < 5; index++) await f.seed('source-' + index, `项目${index}：` + '🐳'.repeat(400), index % 2 ? '工作,归档' : '偏好');
  const first = f.host.catalog({ limit: 2 }), second = f.host.catalog({ limit: 2, cursor: first.nextCursor }), third = f.host.catalog({ limit: 2, cursor: second.nextCursor });
  expect(new Set([...first.items, ...second.items, ...third.items].map(value => value.id)).size).toBe(5);
  expect(first.items.every((value: { content: string }) => Array.from(value.content).length <= 240)).toBe(true);
  expect(f.host.catalog({ tag: '工作', limit: 60 }).items).toHaveLength(2);
  expect(f.host.catalog({ query: '项目3' }).items).toHaveLength(1);
  expect(first.tags).toEqual(expect.arrayContaining([{ name: '偏好', count: 3 }, { name: '工作', count: 2 }]));
});

it('accepts the shared API catalog query limit and still treats SQL wildcard characters literally', async () => {
  const f = await fixture(), query = '查'.repeat(3997) + '%_\\';
  const note = await f.seed('long-filter', `开始${query}结束`);
  expect(f.host.catalog({ query, limit: 1 }).items.map((value: { id: string }) => value.id)).toEqual([note.id]);
  expect(f.host.catalog({ query: query.slice(0, 201), limit: 1 }).items).toHaveLength(1);
  expect(() => f.host.catalog({ query: '查'.repeat(4001) })).toThrow(/Invalid memory catalog filter/);
});

it('marks every source and organized output unknown, and fences legacy indexed metadata in catalog and list', async () => {
  const f = await fixture(), a = await f.seed('unknown-a', '第一份旧原文。'), b = await f.seed('unknown-b', '第二份旧原文。'),
    unrelated = await f.seed('unknown-unrelated', '独立且已确认的资料。');
  const input = { operationId: 'unknown-organize', sources: [{ id: a.id, expectedChecksum: a.checksum }, { id: b.id, expectedChecksum: b.checksum }],
    content: '已经写出但整理结果尚待核实的合并内容。', sourceEventId: 'unknown-organized-source' };
  f.rt.setFailDelete(true);
  const pending = await f.host.organize(f.rt, input);
  expect(pending).toMatchObject({ state: 'partial', fileCommitted: true });
  const plan = JSON.parse(f.host.db.prepare('SELECT plan_json FROM managed_operations WHERE operation_id=?').get(input.operationId).plan_json);
  await writeFile(f.host.notePath(plan.sources[0].archivePath), '归档过程后出现第三版本，不能猜测或覆盖。');
  f.rt.setFailDelete(false);
  await expect(f.host.organize(f.rt, input)).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
  const affected = [a.id, b.id, pending.id];
  for (const id of affected) {
    expect(f.host.db.prepare('SELECT state FROM mutations WHERE id=?').get(id).state).toBe('unknown');
    await expect(f.host.readNote({ id })).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
  }
  // An existing journal from the old implementation can still have indexed
  // output metadata. Reopening must fence it without rerunning any mutation.
  f.host.db.prepare("UPDATE mutations SET state='indexed' WHERE id=?").run(pending.id);
  f.host.close(); hosts.splice(hosts.indexOf(f.host), 1);
  const reopened = new BotHost(f.home); hosts.push(reopened);
  for (const rows of [reopened.catalog({ limit: 60 }).items, reopened.list()]) {
    for (const id of affected) expect(rows.find((value: { id: string }) => value.id === id)).toMatchObject({ id, content: '', indexState: 'unknown' });
    expect(rows.find((value: { id: string }) => value.id === unrelated.id)).toMatchObject({ content: unrelated.content, indexState: 'indexed' });
  }
  await expect(reopened.readNote({ id: pending.id })).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
  expect(reopened.operationReceipt({ operationId: input.operationId })).toMatchObject({ found: true, receipt: { state: 'unknown' } });
});

it('marks legacy tags unknown until they are extracted from an actually verified diary file', async () => {
  const f = await fixture(), note = await f.seed('legacy', '原先的旧记忆。', '真实旧标签,范围');
  f.host.db.prepare('UPDATE mutations SET tags_json=NULL WHERE id=?').run(note.id);
  expect(f.host.catalog({}).items[0]).toMatchObject({ tags: [], tagsKnown: false });
  expect(await f.host.readNote({ id: note.id })).toMatchObject({ tags: ['真实旧标签', '范围'] });
  expect(f.host.catalog({}).items[0]).toMatchObject({ tags: ['真实旧标签', '范围'], tagsKnown: true });
});

it('recovers an actual process exit after filesystem CAS but before its ledger acknowledgment', async () => {
  const f = await fixture(), note = await f.seed('crash-source', '崩溃前原话。'), input = { operationId: 'real-crash', id: note.id, expectedChecksum: note.checksum, content: '已写入的新原话。', sourceEventId: 'crash-correction' };
  f.host.close(); hosts.splice(hosts.indexOf(f.host), 1);
  const child = spawnSync(process.execPath, ['-e', `
    const {BotHost}=require(${JSON.stringify(path.resolve('resources/vcp-memory/lib/bot-host.cjs'))});
    const host=new BotHost(process.argv[1]);const runtime={start:async()=>{},kb:{runExternalFileMutation:async(_name,fn)=>{await fn();process.exit(73)}}};
    host.update(runtime,JSON.parse(process.argv[2])).catch(e=>{console.error(e);process.exit(74)});
  `, f.home, JSON.stringify(input)], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000 });
  expect(child.status, child.stderr).toBe(73);
  const reopened = new BotHost(f.home); hosts.push(reopened);
  expect(reopened.operationReceipt({ operationId: input.operationId })).toMatchObject({ found: true, receipt: { state: 'unknown', journalState: 'prepared' } });
  expect(await reopened.update(f.rt, input)).toMatchObject({ status: 'success', state: 'indexed' });
  expect((await reopened.readNote({ id: note.id })).content).toBe(input.content);
});

it('keeps organized output source lineage durable before its first file is created, so parent forget wins after a process crash', async () => {
  const f = await fixture(), a = await f.seed('source-a', '只用蓝色盒子。'), b = await f.seed('source-b', '只整理西北角。');
  const input = { operationId: 'organize-crash', sources: [{ id: a.id, expectedChecksum: a.checksum }, { id: b.id, expectedChecksum: b.checksum }],
    content: '蓝色盒子和西北角的合并资料。', sourceEventId: 'organized-after-crash' };
  f.host.close(); hosts.splice(hosts.indexOf(f.host), 1);
  const child = spawnSync(process.execPath, ['-e', `
    const {BotHost}=require(${JSON.stringify(path.resolve('resources/vcp-memory/lib/bot-host.cjs'))});const host=new BotHost(process.argv[1]);
    const runtime={start:async()=>{},kb:{runExternalFileMutation:async(_name,fn)=>{await fn();process.exit(73)}}};
    host.organize(runtime,JSON.parse(process.argv[2])).catch(e=>{console.error(e);process.exit(74)});
  `, f.home, JSON.stringify(input)], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000 });
  expect(child.status, child.stderr).toBe(73);
  const reopened = new BotHost(f.home); hosts.push(reopened);
  const outputId = createHash('sha256').update(input.sourceEventId).digest('hex');
  const forgotten = await reopened.forget(f.rt, { id: a.id, companionId: 'owner' });
  expect(forgotten.relatedIds).toContain(outputId);
  await reopened.managed.repair(f.rt);
  expect(reopened.operationReceipt({ operationId: input.operationId })).toMatchObject({ found: true, receipt: { state: 'withdrawn' } });
  await expect(reopened.readNote({ id: outputId })).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
  expect(await reopened.readNote({ id: b.id })).toMatchObject({ id: b.id, content: b.content, indexState: 'indexed' });
});
