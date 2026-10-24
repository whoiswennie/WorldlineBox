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
function sql(run: (db: CompanionConnection) => void) { const db = new (Database as { new(file: string): CompanionConnection })(file); try { run(db); } finally { db.close(); } }

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
