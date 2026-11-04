import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
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
      const filename = `${input.Date}-12_00_00-${input.fileName}.txt`, file = path.join(dir, filename);
      await writeFile(file, `[${input.Date}] - Companion\n[12:00]\n${input.Content}\nTag: ${input.Tag}`, { flag: 'wx' }); pending.add(file);
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
