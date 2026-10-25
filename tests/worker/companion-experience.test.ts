import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { companionRecallCapabilities } from '../../src/main/companions/structured-agent';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { companionsRequestSchema } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

const seeds = ['alice', 'bob'].map(id => ({ id, name: id, persona: '认真', description: '', model: '', avatar: 'sister' as const, active: true, proactive: false }));
let root: string, file: string, store: CompanionsStore;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'companion-experience-')); file = path.join(root, 'state.sqlite'); store = new CompanionsStore(file, seeds); });
afterEach(() => { vi.useRealTimers(); store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-experience-')) throw Error('Unsafe fixture'); removeOwnedDirectorySync(root); });
const scope = (owner = 'alice') => ({ companionId: owner, conversationId: store.openPrivate(owner).id });
function action(owner = 'alice', title = '真实任务') {
  const current = scope(owner), source = store.appendMessage({ conversationId: current.conversationId, authorId: 'user', content: '请整理资料 SOURCE_PRIVATE', replyDirective: 'none' });
  const readset = captureCompanionExecutionReadset(current, { context: { user: JSON.stringify({ messages: [source] }) } });
  const task = store.request({ type: 'action.create', action: { ...current, sourceMessageId: source.id, title, status: 'queued' }, checkpoint: { prompt: source.content, executionReadset: readset, supplements: [], waitForActionIds: [] } }).action!;
  return { task, source, current };
}
function items(owner = 'alice', limit = 100) {
  const day = store.request({ type: 'experience.days', companionId: owner, limit: 31 }).experienceDays!.days[0]!.day;
  return store.request({ type: 'experience.list', companionId: owner, day, limit }).experiencePage!;
}
function sql(run: (db: CompanionConnection) => void) { const db = new (Database as { new(file: string): CompanionConnection })(file); try {
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  run(db);
} finally { db.close(); } }
function messageEntries(owner = 'alice') {
  return store.request({ type: 'experience.days', companionId: owner, limit: 31 }).experienceDays!.days.flatMap(({ day }) =>
    store.request({ type: 'experience.list', companionId: owner, day, limit: 100 }).experiencePage!.items).filter(entry => entry.source.kind === 'message');
}

it('archives only the actual author formal private and group messages with exact source access and withdraws stale bodies', () => {
  const current = scope(), authorization = store.appendMessage({ conversationId: current.conversationId, authorId: 'user', content: '请回复本人资料。', replyDirective: 'none' });
  const privateBody = '这是我实际正式发布的私聊正文。';
  const privateInput = { conversationId: current.conversationId, authorId: 'alice', content: privateBody, clientId: 'one_formal_private_reply',
    executionReadset: captureCompanionExecutionReadset(current, { context: { user: JSON.stringify({ messages: [authorization] }) } }) };
  const privateMessage = store.request({ type: 'message.append', message: privateInput }).message!;
  const group = store.createConversation('实际讨论群', ['alice', 'bob']);
  const groupMessage = store.request({ type: 'message.append', message: { conversationId: group.id, authorId: 'alice', content: '我投给 Bob。这仅是本次游戏的正式发言。' } }).message!;
  const bobMessage = store.request({ type: 'message.append', message: { conversationId: group.id, authorId: 'bob', content: 'Bob 本人正式发言。' } }).message!;
  store.appendMessage({ conversationId: group.id, authorId: 'alice', content: '失败消息不算正式发言。', status: 'failed' });
  store.appendMessage({ conversationId: group.id, authorId: 'alice', content: '系统式通知不属于正文。', kind: 'notice' });
  store.appendMessage({ conversationId: group.id, authorId: 'system', content: '真实系统消息。' });
  const entries = messageEntries(); expect(entries.map(entry => entry.source.id).sort()).toEqual([privateMessage.id, groupMessage.id].sort());
  expect(messageEntries('bob').map(entry => entry.source.id)).toEqual([bobMessage.id]);
  const entry = entries.find(item => item.source.id === groupMessage.id)!;
  expect(entry).toMatchObject({ kind: 'activity', origin: 'action', status: 'completed', title: '在实际讨论群发言',
    source: { kind: 'message', id: groupMessage.id, conversationId: group.id, version: 1 } });
  const detail = store.request({ type: 'experience.read', companionId: 'alice', id: entry.id });
  expect(detail.experienceDetail!.sections).toContainEqual({ title: '经历记录', text: groupMessage.content });
  expect(JSON.stringify(detail.experienceDetail)).toContain('不因此变成现实事实');
  expect(detail.memorySources?.map(source => source.id)).toEqual([groupMessage.id]);
  expect(() => store.request({ type: 'experience.read', companionId: 'bob', id: entry.id })).toThrow('不属于');
  const renamed = store.request({ type: 'experience.rename', companionId: 'alice', id: entry.id, title: '自己的发言标题', expectedRevision: entry.revision }).experienceEntry!;
  store.request({ type: 'message.append', message: privateInput });
  expect(messageEntries()).toHaveLength(2);
  // Isolated persisted edit simulates a real message revision; the old body
  // must be unavailable even before its new projection has been drained.
  sql(db => db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('修订后的正式发言。', groupMessage.id));
  expect(JSON.stringify(store.request({ type: 'experience.read', companionId: 'alice', id: entry.id }))).not.toContain(groupMessage.content);
  // This second SQLite connection deliberately has no host TEMP producer.
  // A changed source must stay unavailable, rather than exposing its v1 body
  // or pretending that the normal producer delivered a v2 snapshot.
  expect(store.request({ type: 'experience.read', companionId: 'alice', id: entry.id })).toMatchObject({ memorySources: [],
    experienceDetail: { entry: { status: 'withdrawn', source: { version: 1 } } } });
  sql(db => expect(db.prepare('SELECT title,custom_title FROM companion_experiences WHERE id=?').get(entry.id)).toMatchObject({ title: renamed.title, custom_title: 1 }));
  store.request({ type: 'memory.forget', companionId: 'alice', conversationId: group.id, sourceMessageIds: [groupMessage.id] });
  expect(store.request({ type: 'experience.read', companionId: 'alice', id: entry.id })).toMatchObject({ memorySources: [], experienceDetail: { entry: { status: 'withdrawn' } } });
  expect(JSON.stringify(store.request({ type: 'experience.read', companionId: 'alice', id: entry.id }))).not.toContain('修订后的正式发言。');
  expect(store.request({ type: 'memory.snapshot', ...current }).memorySnapshot!.notes).toEqual([]);
});

it('publishes an identical draft only on loop done and backfills real historical completion once across restart and legacy replay', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-20T12:00:00Z');
  const current = scope(), source = store.appendMessage({ conversationId: current.conversationId, authorId: 'user', content: '请正常回复。', replyDirective: 'none' });
  const text = '同一个气泡的完整正式发言。', draft = store.appendMessage({ conversationId: current.conversationId, authorId: 'alice', content: text, loopStep: 0 });
  const incomplete = store.appendMessage({ conversationId: current.conversationId, authorId: 'alice', content: '尚未正式完成的草稿。', loopStep: 0 });
  const checkpoint = { ...current, sourceMessageId: source.id, messageId: draft.id, status: 'running' as const,
    turns: [{ text, rawText: text, calls: [] }], supplements: [] };
  store.request({ type: 'loop.save', checkpoint });
  expect(messageEntries()).toEqual([]);
  vi.setSystemTime('2026-10-21T16:00:00Z');
  const done = { ...checkpoint, status: 'done' as const };
  store.request({ type: 'loop.save', checkpoint: done });
  expect(messageEntries().map(entry => entry.source.id)).toEqual([draft.id]);
  sql(db => expect(db.prepare('SELECT revision,content FROM messages WHERE id=?').get(draft.id)).toMatchObject({ revision: 1, content: text }));
  const historicalDirect = store.appendMessage({ conversationId: current.conversationId, authorId: 'alice', content: '旧版直接正式发言。' });
  store.close();
  // Simulate upgrading a pre-message-projection installation: actual source
  // messages and done checkpoints stay intact; only derived archive rows reset.
  sql(db => { db.prepare("DELETE FROM companion_experience_archive WHERE id IN(SELECT id FROM companion_experiences WHERE json_extract(entry,'$.source.kind')='message')").run();
    db.prepare("DELETE FROM companion_experiences WHERE json_extract(entry,'$.source.kind')='message'").run();
    db.prepare("DELETE FROM companion_experience_projection WHERE source='messages'").run();
    db.prepare("DELETE FROM companion_experience_backfill WHERE source='messages'").run(); });
  vi.setSystemTime('2026-10-25T12:00:00Z'); store = new CompanionsStore(file, seeds);
  for (let n = 0; n < 100 && !store.backfillTraceIndex(200); n++) { /* normal bounded upgrade drain */ }
  const backfilled = messageEntries(); expect(backfilled.map(entry => entry.source.id).sort()).toEqual([draft.id, historicalDirect.id].sort());
  expect(backfilled.find(entry => entry.source.id === draft.id)?.occurredAt).toBe('2026-10-21T16:00:00.000Z');
  expect(backfilled.find(entry => entry.source.id === historicalDirect.id)?.occurredAt).toBe(historicalDirect.createdAt);
  expect(backfilled.some(entry => entry.source.id === incomplete.id)).toBe(false);
  const entry = backfilled.find(item => item.source.id === draft.id)!;
  store.request({ type: 'experience.rename', companionId: 'alice', id: entry.id, title: '保留自己的旧发言标题', expectedRevision: entry.revision });
  store.request({ type: 'loop.save', checkpoint: done }); store.close(); store = new CompanionsStore(file, seeds);
  const stable = messageEntries().find(item => item.source.id === draft.id)!;
  expect(stable).toMatchObject({ id: entry.id, title: '保留自己的旧发言标题', occurredAt: entry.occurredAt });
  // An unchanged already-done legacy checkpoint has no publication updatedAt;
  // replay must fall back to its real message creation, never today's stamp.
  sql(db => db.prepare("UPDATE metadata SET value=json_remove(value,'$.updatedAt') WHERE key=?").run('message-loop/' + draft.id));
  store.request({ type: 'loop.save', checkpoint: done });
  sql(db => expect(JSON.parse(String((db.prepare('SELECT value FROM metadata WHERE key=?').get('message-loop/' + draft.id) as { value: string }).value)).updatedAt).toBe(draft.createdAt));
  expect(messageEntries()).toHaveLength(2);
});

it('indexes concurrent real producers without collisions and paginates by owner and stable cursor, retaining names and files across restart', () => {
  const tasks = Array.from({ length: 5 }, (_, n) => action('alice', '任务' + n)); action('bob', 'Bob独立任务');
  const first = items('alice', 2), second = store.request({ type: 'experience.list', companionId: 'alice', day: first.day, limit: 2, cursor: first.nextCursor }).experiencePage!;
  const pages = [first, second];
  while (pages.at(-1)!.hasMore) pages.push(store.request({ type: 'experience.list', companionId: 'alice', day: first.day, limit: 2, cursor: pages.at(-1)!.nextCursor }).experiencePage!);
  const all = pages.flatMap(page => page.items).filter(item => item.source.kind === 'action');
  expect(new Set(all.map(item => item.id)).size).toBe(5); expect(all.every(item => item.companionId === 'alice')).toBe(true);
  expect(() => store.request({ type: 'experience.list', companionId: 'bob', day: first.day, limit: 2, cursor: first.nextCursor })).toThrow('游标');
  const entry = all.find(item => item.source.id === tasks[0]!.task.id)!;
  const renamed = store.request({ type: 'experience.rename', companionId: 'alice', id: entry.id, title: '我自己的经历标题', expectedRevision: entry.revision }).experienceEntry!;
  expect(() => store.request({ type: 'experience.rename', companionId: 'bob', id: entry.id, title: '冒名', expectedRevision: entry.revision })).toThrow('不属于');
  expect(() => store.request({ type: 'experience.rename', companionId: 'alice', id: entry.id, title: '过期修改', expectedRevision: entry.revision })).toThrow('版本');
  store.request({ type: 'action.update', id: tasks[0]!.task.id, patch: { status: 'failed', error: '实际失败原因' } });
  store.close(); store = new CompanionsStore(file, seeds);
  const detail = store.request({ type: 'experience.read', companionId: 'alice', id: entry.id }).experienceDetail!;
  expect(detail.entry).toMatchObject({ title: renamed.title, status: 'failed' }); expect(JSON.stringify(detail)).toContain('实际失败原因');
  expect(existsSync(path.join(root, detail.entry.archiveRelativePath, 'index.json'))).toBe(true);
  expect(readFileSync(path.join(root, detail.entry.archiveRelativePath, 'detail.md'), 'utf8')).toContain(renamed.title);
});

it('archives the original schedule title and prompt together with actual delivery, without manufacturing another memory', () => {
  const current = scope(), prompt = '提醒我喝温水，然后舒展肩颈。';
  const schedule = store.request({ type: 'schedule.create', ...current, entries: [{ title: '喝水休息', prompt, runAt: new Date(Date.now() - 1000).toISOString(), timeZone: 'Asia/Shanghai' }] }).schedules![0]!;
  const due = store.request({ type: 'schedule.due.claim' }).scheduleOccurrence!; expect(due.scheduleId).toBe(schedule.id);
  const message = store.appendMessage({ conversationId: current.conversationId, authorId: 'alice', content: '记得喝温水，舒展一下肩颈。', clientId: 'schedule_' + due.id });
  store.request({ type: 'schedule.occurrence.update', id: due.id, leaseToken: due.leaseToken, status: 'done', messageId: message.id });
  const entry = items().items.find(item => item.source.kind === 'schedule')!;
  expect(entry).toMatchObject({ title: '喝水休息', status: 'completed', origin: 'system' });
  const detail = store.request({ type: 'experience.read', companionId: 'alice', id: entry.id }).experienceDetail!;
  expect(detail.sections).toContainEqual({ title: '原始日程任务', text: prompt }); expect(JSON.stringify(detail)).toContain(message.content);
  expect(store.request({ type: 'memory.snapshot', ...current }).memorySnapshot!.notes).toEqual([]);
});

it('records capture and index processing separately, and withholds withdrawn memory bodies', () => {
  const current = scope(), source = store.appendMessage({ conversationId: current.conversationId, authorId: 'user', content: '撤回前的真实事实。', replyDirective: 'none' });
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const note = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: [], relatedMemoryIds: [], sourceChecksums: job.sourceChecksums }] }).memories![0]!;
  const outbox = store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  const page = items(), processing = page.items.filter(item => item.source.kind === 'memory_processing');
  expect(processing.some(item => item.title === '记忆抽取' && item.status === 'completed')).toBe(true);
  expect(processing.some(item => item.title === '记忆索引同步' && item.status === 'completed')).toBe(true);
  const entry = page.items.find(item => item.source.kind === 'memory' && item.source.id === note.id)!;
  store.request({ type: 'experience.rename', companionId: 'alice', id: entry.id, title: source.content, expectedRevision: entry.revision });
  store.request({ type: 'memory.forget', ...current, sourceMessageIds: [source.id] });
  expect(items().items.find(item => item.id === entry.id)).toMatchObject({ title: '引用资料已撤回的经历', status: 'withdrawn' });
  expect(JSON.stringify(store.request({ type: 'experience.read', companionId: 'alice', id: entry.id }))).not.toContain(source.content);
});

it('binds native experience reads and rename to self, budgets the body, and retains real provenance through withdrawal', async () => {
  const { task, source, current } = action();
  store.request({ type: 'action.update', id: task.id, patch: { status: 'succeeded', result: 'SOURCE_PRIVATE' + '实际内容'.repeat(3000) } });
  const instance = Object.create(CompanionService.prototype) as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
  Object.assign(instance, { storage: { request: async (command: CompanionStorageCommand) => store.request(command) }, sourceValidationRevision: 0, evidenceRevision: 0,
    memory: { contextValid: async () => true, schedule: () => undefined, invalidate: async () => undefined }, resettingCompanions: new Set(), options: { report: () => undefined }, changed: () => undefined });
  const capability = companionRecallCapabilities(command => instance.call(command), current), entry = items().items.find(item => item.source.id === task.id)!;
  const call = { id: 'read_experience', name: 'world', arguments: JSON.stringify({ action: 'experience', parameters: { action: 'read', id: entry.id } }) };
  const result = await capability.execute(call) as CompanionStorageResponse & { truncated: boolean };
  expect(result.truncated).toBe(true); expect(result.experienceDetail!.sections.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(8000);
  const proof = captureCompanionExecutionReadset(current, { turns: [{ text: '', rawText: '', calls: [call], results: [{ callId: call.id, content: JSON.stringify(result) }] }] });
  expect(proof.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: source.id })]));
  await expect(capability.execute({ ...call, arguments: JSON.stringify({ action: 'experience', parameters: { action: 'read', id: entry.id, companionId: 'bob' } }) })).rejects.toThrow();
  expect(companionsRequestSchema.safeParse({ type: 'experience.publish', companionId: 'alice', id: 'fake', title: '伪造完成', status: 'completed', summary: '无真实执行' }).success).toBe(false);
  store.request({ type: 'memory.forget', ...current, sourceMessageIds: [source.id] });
  const after = await capability.execute(call) as CompanionStorageResponse;
  expect(after.experienceDetail!.entry.status).toBe('completed'); expect(JSON.stringify(after)).not.toContain('SOURCE_PRIVATE');
});

it('retries a failed projection without blocking the actual producer and clears owner archives/intents on the normal reset', async () => {
  const bob = action('bob'), current = scope(), source = store.appendMessage({ conversationId: current.conversationId, authorId: 'user', content: '原授权', replyDirective: 'none' });
  const task = store.createAction({ ...current, sourceMessageId: source.id, title: '待投影任务', status: 'queued' });
  sql(db => db.prepare("UPDATE companion_experience_projection SET payload='broken' WHERE source_id=?").run(task.id));
  expect(store.request({ type: 'state' }).ok).toBe(true);
  sql(db => expect(db.prepare('SELECT attempts,error FROM companion_experience_projection WHERE source_id=?').get(task.id)).toMatchObject({ attempts: 1, error: expect.any(String) }));
  store.request({ type: 'action.update', id: task.id, patch: { status: 'failed', error: '真实终态仍可提交' } });
  expect(items().items.find(item => item.source.id === task.id)?.status).toBe('failed');
  const job = store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
  store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: job.id });
  for (let n = 0; n < 200 && store.request({ type: 'companion.reset.status', id: 'alice' }).reset!.status !== 'completed'; n++) await store.advanceReset();
  expect(store.request({ type: 'experience.days', companionId: 'alice', limit: 31 }).experienceDays!.days).toEqual([]);
  expect(existsSync(path.join(root, 'experiences', 'alice'))).toBe(false);
  expect(items('bob').items.some(item => item.source.id === bob.task.id)).toBe(true);
});
