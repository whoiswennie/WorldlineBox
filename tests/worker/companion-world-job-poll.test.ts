import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionStorageCommandSchema, companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

const roots: string[] = [], stores: CompanionsStore[] = [], connections: CompanionConnection[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-24T02:00:00Z'); vi.spyOn(Math, 'random').mockReturnValue(.99); });
afterEach(() => {
  vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('world-job-poll-')) throw Error('Unexpected fixture root.'); rmSync(root, { recursive: true, force: true }); }
  vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'world-job-poll-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真', model: '', avatar: 'sister' as const, active: true, proactive: false }))); stores.push(store);
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename); connections.push(db);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '上午去公园。下午去图书馆。', replyDirective: 'none' });
  const capture = store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
  const notes = store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken, notes: ['上午去公园。', '下午去图书馆。'].map(content => ({ artifactKind: 'episode_memory' as const, content,
    tags: ['实际来源'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] })) }).memories!;
  const index = () => { for (let n = 0; n < 50; n++) { const out = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!out) return; store.request({ type: 'memory.outbox.complete', id: out.id, leaseToken: out.leaseToken, indexed: true }); } throw Error('Unexpected index backlog.'); }; index();
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '01:00', wakeAt: '07:00', meals: [], habits: [] } });
  for (const ms of [10000, 6000]) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
  const job = store.request({ type: 'world.job.claim', kind: 'dream', excludedCompanionIds: ['bob'] }).worldJob!;
  expect(job).toBeDefined(); expect(notes).toHaveLength(2); expect(job.sourceMemoryIds).toEqual(expect.arrayContaining(notes.map(note => note.id)));
  const command = { type: 'world.job.poll' as const, companionId: 'alice', id: job.id, leaseToken: job.leaseToken! };
  const poll = () => store.request(command);
  return { store, db, scope, source, notes, job, command, poll, index };
}

it('freshly batches repeated physical source rows without hydrating job proposals or message bodies', () => {
  const f = fixture(), sql = 'SELECT * FROM messages WHERE id IN(SELECT value FROM json_each(?))';
  f.db.prepare("UPDATE companion_world_jobs SET data=json_set(data,'$.proposals.real.privateBody','PRIVATE_PROPOSAL_BODY') WHERE id=?").run(f.job.id);
  const prototype = Object.getPrototypeOf(f.db), prepare = prototype.prepare; let batches = 0, physicalRows = 0;
  vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    const statement = Reflect.apply(prepare, this, args) as ReturnType<CompanionConnection['prepare']>;
    if (args[0] === sql) {
      const all = statement.all;
      vi.spyOn(statement, 'all').mockImplementation((...bindings: unknown[]) => { const values = Reflect.apply(all, statement, bindings) as unknown[]; batches++; physicalRows += values.length; return values; });
    }
    return statement;
  });
  const first = f.poll(); expect(first).toMatchObject({ ok: true, worldJobPoll: { current: true } });
  expect(Object.keys(first).sort()).toEqual(['ok', 'worldJobPoll']); expect(companionStorageResponseSchema.safeParse(first).success).toBe(true);
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE_PROPOSAL_BODY|上午去公园|下午去图书馆|memoryVersions|worldJob"/u);
  expect(batches).toBe(1); expect(physicalRows).toBe(1);
  expect(f.poll().worldJobPoll?.current).toBe(true); expect(batches).toBe(2); expect(physicalRows).toBe(2);
  expect(f.store.request({ type: 'world.job.check', id: f.job.id, leaseToken: f.job.leaseToken! }).worldJob).toBeDefined();
});

it.each(['content-revision', 'annotation-only', 'forget', 'membership', 'observer', 'active'] as const)('keeps the exact current memory and authority boundary after %s', change => {
  const f = fixture(); expect(f.poll().worldJobPoll?.current).toBe(true);
  if (change === 'content-revision') f.db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.contentRevision',json_extract(data,'$.contentRevision')+1) WHERE id=?").run(f.notes[0]!.id);
  if (change === 'annotation-only') f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: f.notes[0]!.id, expectedVersion: f.notes[0]!.version, tags: ['整理标注'], diaryName: '当前日记' });
  if (change === 'forget') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  if (change === 'membership') f.db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(f.scope.conversationId, 'alice');
  if (change === 'observer') f.db.prepare('DELETE FROM vcp_source_observers WHERE message_id=? AND companion_id=?').run(f.source.id, 'alice');
  if (change === 'active') f.store.request({ type: 'companion.set-active', id: 'alice', active: false });
  expect(f.poll().worldJobPoll?.current).toBe(change === 'annotation-only');
});

it.each(['revision', 'checksum', 'conversationId'] as const)('retains conflicting exact tuples for a repeated source (%s)', field => {
  const f = fixture(), next = field === 'revision' ? 999 : field === 'checksum' ? '0'.repeat(64) : f.store.openPrivate('bob').id;
  f.db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,?,?) WHERE id=?").run('$.sources[0].' + field, next, f.notes[1]!.id);
  expect(f.poll().worldJobPoll?.current).toBe(false);
});

it('keeps complete legacy-version checks instead of granting a content-revision shortcut', () => {
  const f = fixture();
  f.db.prepare("UPDATE companion_world_jobs SET data=json_set(data,'$.memoryVersions',json(?)) WHERE id=?").run(JSON.stringify(f.notes.map(note => ({ id: note.id, version: note.version }))), f.job.id);
  expect(f.poll().worldJobPoll?.current).toBe(true);
  f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: f.notes[0]!.id, expectedVersion: f.notes[0]!.version, tags: ['另一标注'], diaryName: '当前日记' });
  expect(f.poll().worldJobPoll?.current).toBe(false);
});

it('rechecks a real source action and its execution ancestry rather than trusting the note header', () => {
  const f = fixture(), parent = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '完成当前核对。', replyDirective: 'none' });
  const executionReadset = captureCompanionExecutionReadset(f.scope, { context: { user: JSON.stringify({ messages: [parent] }) } });
  const action = f.store.request({ type: 'action.create', action: { ...f.scope, sourceMessageId: parent.id, title: '真实核对', status: 'queued' }, checkpoint: { prompt: parent.content, executionReadset } }).action!;
  f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '已核对正式资料。' } });
  const source = f.store.request({ type: 'messages', conversationId: f.scope.conversationId }).messages!.find(message => message.actionId === action.id)!;
  const note = f.store.request({ type: 'memory.record', ...f.scope, candidate: { artifactKind: 'episode_memory', content: '已核对正式资料。', tags: [], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: '已核对正式资料。' }] } }).memories![0]!; f.index();
  f.store.request({ type: 'world.job.bind-memories', id: f.job.id, leaseToken: f.job.leaseToken!, memoryVersions: [...f.notes, note].map(note => ({ id: note.id, version: note.version })) });
  expect(f.poll().worldJobPoll?.current).toBe(true);
  f.store.request({ type: 'execution.invalidate', kind: 'action', companionId: 'alice', id: action.id });
  expect(f.poll().worldJobPoll?.current).toBe(false);
});

it('rejects wrong or expired leases and remains a strictly private scalar protocol', () => {
  const f = fixture();
  expect(f.store.request({ ...f.command, leaseToken: 'wrong_lease' }).worldJobPoll?.current).toBe(false);
  expect(f.store.request({ ...f.command, companionId: 'bob' }).worldJobPoll?.current).toBe(false);
  expect(companionsRequestSchema.safeParse(f.command).success).toBe(false);
  expect(companionStorageCommandSchema.safeParse({ ...f.command, worldJob: f.job }).success).toBe(false);
  vi.setSystemTime(Date.now() + 121000); expect(f.poll().worldJobPoll?.current).toBe(false);
});

it('propagates storage availability failures without returning invalid or permanently withdrawing inputs', () => {
  const f = fixture(), prototype = Object.getPrototypeOf(f.db), prepare = prototype.prepare;
  const failed = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    if (args[0] === 'SELECT value FROM metadata WHERE key=?') throw Object.assign(new Error('controlled transport failure'), { code: 'SQLITE_IOERR' });
    return Reflect.apply(prepare, this, args);
  });
  expect(() => f.poll()).toThrow('controlled transport failure'); failed.mockRestore();
  expect(f.db.prepare('SELECT status FROM companion_world_jobs WHERE id=?').get(f.job.id)).toEqual({ status: 'running' });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'execution-source-invalid/%'").get()).toEqual({ n: 0 });
  expect(f.poll().worldJobPoll?.current).toBe(true);
});

it.each([{ kind: 'sqlite', basis: 'frozen' }, { kind: 'wrapped', basis: 'frozen' }, { kind: 'range', basis: 'frozen' }, { kind: 'unknown', basis: 'frozen' }, { kind: 'sqlite', basis: 'version' }] as const)('propagates deep legacy-readset $kind/$basis failures and restores the old call mode', ({ kind, basis }) => {
  const f = fixture(), parent = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '依据已有日记核对资料。', replyDirective: 'none' });
  const memory = f.notes[0]!, executionReadset = { ...captureCompanionExecutionReadset(f.scope, { context: { user: JSON.stringify({ messages: [parent] }) } }),
    ...(basis === 'version' ? { memories: [{ id: memory.id, version: memory.version }] } : { frozenMemories: [{ id: memory.id, version: memory.version, contentRevision: memory.contentRevision,
      sources: memory.sources.map(reference => ({ id: reference.messageId, conversationId: reference.conversationId, revision: reference.revision, checksum: reference.checksum })) }] }) };
  const action = f.store.request({ type: 'action.create', action: { ...f.scope, sourceMessageId: parent.id, title: '旧式完整依赖核对', status: 'queued' }, checkpoint: { prompt: parent.content, executionReadset } }).action!;
  f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '依真实日记完成核对。' } });
  const source = f.store.request({ type: 'messages', conversationId: f.scope.conversationId }).messages!.find(message => message.actionId === action.id)!;
  const note = f.store.request({ type: 'memory.record', ...f.scope, candidate: { artifactKind: 'episode_memory', content: '依真实日记完成核对。', tags: [], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: '依真实日记完成核对。' }] } }).memories![0]!; f.index();
  f.store.request({ type: 'world.job.bind-memories', id: f.job.id, leaseToken: f.job.leaseToken!, memoryVersions: [...f.notes, note].map(note => ({ id: note.id, version: note.version })) });
  expect(f.poll().worldJobPoll?.current).toBe(true);
  const saved = () => f.db.prepare('SELECT status,lease_until,data FROM companion_world_jobs WHERE id=?').get(f.job.id), before = saved();
  const statement = f.db.prepare('SELECT 1'), prototype = Object.getPrototypeOf(statement), get = prototype.get;
  const error = kind === 'range' ? new RangeError('deep validation budget unavailable') : kind === 'unknown' ? new Error('deep unknown availability')
    : kind === 'wrapped' ? new Error('deep wrapped availability', { cause: Object.assign(new Error('storage unavailable'), { code: 'SQLITE_IOERR' }) })
      : Object.assign(new Error('deep storage unavailable'), { code: 'SQLITE_IOERR' });
  const fault = vi.spyOn(prototype, 'get').mockImplementation(function(this: { source?: string }, ...args: unknown[]) {
    if (this.source === (basis === 'version' ? 'SELECT data FROM vcp_memory_notes WHERE id=?' : 'SELECT data FROM companion_memory_content_revisions WHERE note_id=? AND companion_id=? AND content_revision=?')) throw error;
    return Reflect.apply(get, this, args);
  });
  expect(() => f.poll()).toThrow(error.message); expect(saved()).toEqual(before);
  // The strict opt-in is restored even on failure. Existing generic callers
  // retain their previous boolean denial behavior, without permanent writes.
  expect(f.store.request({ type: 'world.job.check', id: f.job.id, leaseToken: f.job.leaseToken! }).worldJob).toBeUndefined();
  fault.mockRestore(); expect(f.poll().worldJobPoll?.current).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'execution-source-invalid/%'").get()).toEqual({ n: 0 });
});
