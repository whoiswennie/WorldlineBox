import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import BetterSqlite3 from 'better-sqlite3';

const Database = BetterSqlite3 as { new (filename: string, options: { readonly: true }): CompanionConnection };

const members = ['alice', 'bob', 'carol', 'daria', 'erin', 'fran', 'gale', 'hana'];
const seeds: CompanionSeed[] = [...members, 'observer'].map(id => ({ id, name: id, description: '', persona: '保持本人身份，自主决定是否回应。', avatar: 'sister', model: '', active: true, proactive: false }));
const roots: string[] = [], stores = new Set<CompanionsStore>();
const readers = new Set<CompanionConnection>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => {
  for (const reader of readers) reader.close(); readers.clear();
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-group-participation-')) throw Error('Unexpected fixture path'); rmSync(root, { recursive: true, force: true }); }
  vi.useRealTimers();
});
function advance(store: CompanionsStore, ms = 6000) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function fixture(selected = members, withTopic = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-group-participation-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, seeds); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of members) { const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } }); }
  advance(store, 10000);
  const playerRoom = store.openPrivate('alice'), source = store.appendMessage({ conversationId: playerRoom.id, authorId: 'user', content: '请让群里每位伙伴自主谈一个露营建议。私人详情PRIVATE_GROUP_CANARY不得分享。', replyDirective: 'none' });
  const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: selected }).socialConversation!;
  const topic = withTopic ? store.request({ type: 'topic.create', conversationId: room.id, readerId: 'alice', title: '露营讨论', kind: 'discussion', participantIds: selected.filter(id => id !== 'alice') }).topic : undefined;
  if (topic) for (const readerId of selected.filter(id => id !== 'alice')) store.request({ type: 'topic.join', conversationId: room.id, readerId, topicId: topic.id });
  const command = { type: 'social.send' as const, companionId: 'alice', conversationId: room.id, content: '大家各自谈一个露营建议；不想发言可以不回应。', channel: 'phone' as const, authorizationMessageId: source.id, clientId: 'group-seed' };
  expect(store.request(command).socialPending).toBe(true); advance(store); const first = store.request(command).socialMessage!;
  return { store, filename, source, playerRoom, room, first, topic };
}
function complete(store: CompanionsStore, job: CompanionSocialJob, text: string | null, nextRecipientId?: string) {
  advance(store); return companionStorageResponseSchema.parse(store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text, ...(nextRecipientId ? { nextRecipientId } : {}) }));
}
function claim(store: CompanionsStore) { return companionStorageResponseSchema.parse(store.request({ type: 'social.job.claim' })).socialJob; }
function drain(store: CompanionsStore, text: (job: CompanionSocialJob, index: number) => string | null, next?: (job: CompanionSocialJob) => string) {
  const jobs: CompanionSocialJob[] = [];
  for (let index = 0; index < 24; index++) { advance(store); const job = claim(store); if (!job) break;
    jobs.push(job); complete(store, job, text(job, index), next?.(job)); }
  return jobs;
}

it('offers all seven real recipients a first turn even when each independently chooses silence', () => {
  const f = fixture(), jobs = drain(f.store, () => null);
  expect(jobs.map(job => job.companionId).sort()).toEqual(members.slice(1).sort());
  expect(new Set(jobs.map(job => job.chainId)).size).toBe(1);
  expect(jobs.every(job => job.memberIds.length === 8 && !job.memberIds.includes('observer'))).toBe(true);
  expect(jobs.every(job => job.origin?.initiatorKind === 'human_player')).toBe(true);
  expect(JSON.stringify(jobs)).not.toContain('PRIVATE_GROUP_CANARY');
  expect(f.store.request({ type: 'social.messages', conversationId: f.room.id }).socialMessagePage!.items).toHaveLength(1);
  expect(f.store.request({ type: 'actions' }).actions).toEqual([]);
});

it('prioritizes each first opportunity over repeated model nominations and caps only the finite continuation', () => {
  const f = fixture(), jobs = drain(f.store, job => `我是${job.companionId}，建议核对营地天气。`, job => job.companionId === 'bob' ? 'alice' : 'bob');
  expect(jobs.slice(0, 7).map(job => job.companionId).sort()).toEqual(members.slice(1).sort());
  expect(jobs.length).toBeGreaterThanOrEqual(8); expect(jobs.length).toBeLessThanOrEqual(9);
  expect(new Set(jobs.map(job => job.id)).size).toBe(jobs.length);
  const messages = f.store.request({ type: 'social.messages', conversationId: f.room.id }).socialMessagePage!.items;
  expect(messages).toHaveLength(jobs.length + 1);
  expect(messages.every(item => members.includes(item.message.authorId) && item.recipientIds.length === 7)).toBe(true);
  expect(() => complete(f.store, jobs[0]!, '重复提交')).toThrow('租约');
  expect(f.store.request({ type: 'work.list' }).works).toEqual([]);
});

it('persists unoffered opportunities across restart without replaying completed replies', () => {
  const f = fixture(), before: string[] = [];
  for (let index = 0; index < 2; index++) { const job = claim(f.store)!; before.push(job.companionId); complete(f.store, job, null); }
  f.store.close(); stores.delete(f.store); const restarted = new CompanionsStore(f.filename, seeds); stores.add(restarted);
  const after = drain(restarted, () => null).map(job => job.companionId);
  expect([...before, ...after].sort()).toEqual(members.slice(1).sort()); expect(after.some(id => before.includes(id))).toBe(false);
});

it('does not let one paused first recipient block the other six or consume their chances', () => {
  const f = fixture(members, true), topic = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic!.id, readerId: 'bob' }).topic!;
  f.store.request({ type: 'topic.pause', conversationId: f.room.id, topicId: topic.id, readerId: 'bob', expectedRevision: topic.revision });
  const others = drain(f.store, () => null);
  expect(others.map(job => job.companionId).sort()).toEqual(members.slice(2).sort());
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'bob' }).topic!;
  f.store.request({ type: 'topic.resume', conversationId: f.room.id, topicId: topic.id, readerId: 'bob', expectedRevision: current.revision });
  const resumed = drain(f.store, () => null); expect(resumed.map(job => job.companionId)).toEqual(['bob']); expect(resumed[0]!.attempts).toBe(1);
});

it('revokes every outstanding opportunity when the original actual player authorization is forgotten', () => {
  const f = fixture(); const first = claim(f.store)!; complete(f.store, first, null);
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.playerRoom.id, sourceMessageIds: [f.source.id] });
  expect(drain(f.store, () => '不该发布')).toEqual([]);
  expect(f.store.request({ type: 'social.messages', conversationId: f.room.id }).socialMessagePage!.items).toHaveLength(1);
});

it('preserves the two-person finite three-reply contract', () => {
  const f = fixture(['alice', 'bob']), jobs = drain(f.store, job => `本人${job.companionId}回复。`);
  expect(jobs.map(job => job.companionId)).toEqual(['bob', 'alice', 'bob']);
});

it('settles an exhausted eight-attempt first recipient without stranding the six peers or author summary', () => {
  const f = fixture(), jobs: CompanionSocialJob[] = [];
  for (let index = 0; index < 20; index++) {
    advance(f.store, 300001); const job = claim(f.store); if (!job) break; jobs.push(job);
    if (job.companionId === 'bob') f.store.request({ type: 'social.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '实际离线重试失败' });
    else complete(f.store, job, `本人${job.companionId}建议核查露营装备。`);
  }
  expect(jobs.filter(job => job.companionId === 'bob').map(job => job.attempts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(jobs.filter(job => job.companionId !== 'bob' && job.companionId !== 'alice').map(job => job.companionId).sort()).toEqual(members.slice(2).sort());
  expect(jobs.filter(job => job.companionId === 'alice')).toHaveLength(1);
  expect(f.store.request({ type: 'social.messages', conversationId: f.room.id }).socialMessagePage!.items.some(item => item.message.authorId === 'bob')).toBe(false);
  expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
});

function waitingSummary() {
  const f = fixture(['alice', 'bob', 'carol'], true);
  const task = f.store.request({ type: 'activity.social.ensure', companionId: 'alice', conversationId: f.playerRoom.id,
    sourceMessageId: f.source.id, deliveryClientId: 'group-seed', operation: 'message' }).activityTask!;
  for (let index = 0; index < 2; index++) { const job = claim(f.store)!; expect(job.companionId).not.toBe('alice'); complete(f.store, job, `我是${job.companionId}，愿意讨论露营计划。`); }
  const summary = claim(f.store)!; expect(summary.companionId).toBe('alice');
  const question = complete(f.store, summary, 'Bob，请你自己决定是否愿意核对路线；不想回应也可以。').socialMessage!;
  advance(f.store);
  const leased = f.store.request({ type: 'activity.claim' }).activityTask!; expect(leased.id).toBe(task.id);
  const observed = f.store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! });
  expect(observed.activityMessages?.some(message => message.id === question.message.id)).toBe(true);
  const waiting = f.store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!, expectedStep: leased.step,
    decision: { status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '已实际询问本人意见，等待真实回应。' } }).activityTask!;
  expect(waiting.status).toBe('waiting');
  return { ...f, task: waiting, summary, question };
}

it('offers one bounded actual summary-source processing turn after an explicit observed reply wait, including silence and restart', () => {
  for (const response of ['我自己愿意核对路线。', null]) {
    const f = waitingSummary();
    const read = new Database(f.filename, { readonly: true }); readers.add(read);
    const parent = () => read.prepare('SELECT used,status,data FROM companion_social_chains WHERE id=?').get(f.summary.chainId) as { used: number; status: string; data: string };
    const messages = () => read.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(f.room.id) as { n: number };
    const beforeCount = messages().n;
    advance(f.store); expect(f.store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
    const job = claim(f.store);
    expect(job?.companionId).toBe('bob'); expect(job?.sourceMessageId).toBe(f.question.message.id);
    expect(job?.chainId).not.toBe(f.summary.chainId); expect(messages().n).toBe(beforeCount);
    expect(parent()).toMatchObject({ status: 'done', used: 4 }); expect(JSON.parse(parent().data).maxMessages).toBe(5);
    expect(JSON.parse(parent().data).replyReservations).toBeUndefined();
    complete(f.store, job!, response);
    expect(messages().n).toBe(beforeCount + Number(response !== null));
    f.store.close(); stores.delete(f.store); const restarted = new CompanionsStore(f.filename, seeds); stores.add(restarted);
    for (let tick = 0; tick < 3; tick++) { advance(restarted); restarted.request({ type: 'activity.claim' }); expect(claim(restarted)).toBeUndefined(); }
    expect(parent()).toMatchObject({ status: 'done', used: 4 });
    const jobs = read.prepare("SELECT COUNT(*) AS n FROM companion_social_jobs WHERE companion_id='bob' AND json_extract(data,'$.sourceMessageId')=?").get(f.question.message.id) as { n: number };
    expect(jobs.n).toBe(1);
    const child = read.prepare('SELECT data,status FROM companion_social_chains WHERE id=?').get(job!.chainId) as { data: string; status: string };
    expect(JSON.parse(child.data).maxMessages).toBe(2); expect(child.status).toBe('done');
    read.close(); readers.delete(read);
  }
});

it('rechecks the original activity source before publishing a pending summary-source response', () => {
  const f = waitingSummary(); advance(f.store); const job = claim(f.store)!;
  expect(job?.sourceMessageId).toBe(f.question.message.id);
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.playerRoom.id, sourceMessageIds: [f.source.id] });
  expect(() => complete(f.store, job, '撤回后不得发布')).toThrow();
  expect(f.store.request({ type: 'social.messages', conversationId: f.room.id }).socialMessagePage!.items.some(item => item.message.content === '撤回后不得发布')).toBe(false);
});

function exhaustedSummary() {
  const f = fixture(['alice', 'bob', 'carol'], true);
  for (let index = 0; index < 2; index++) { const job = claim(f.store)!; complete(f.store, job, `本人${job.companionId}已给出露营建议。`); }
  const summary = claim(f.store)!; expect(summary.companionId).toBe('alice');
  const question = complete(f.store, summary, 'Bob，请你自己决定是否愿意核对路线；Carol也可以补充装备建议。', 'carol').socialMessage!;
  const last = claim(f.store)!; expect(last.companionId).toBe('carol');
  complete(f.store, last, '我建议带备用照明，路线由Bob自己判断。');
  expect(claim(f.store)).toBeUndefined();
  const read = new Database(f.filename, { readonly: true }); readers.add(read);
  const parent = () => read.prepare('SELECT used,status,data FROM companion_social_chains WHERE id=?').get(summary.chainId) as { used: number; status: string; data: string };
  expect(parent()).toMatchObject({ used: 5, status: 'done' }); expect(JSON.parse(parent().data).maxMessages).toBe(5);
  return { ...f, summary, question, read, parent };
}
function waitForUnprocessedSummary(f: ReturnType<typeof exhaustedSummary>) {
  const task = f.store.request({ type: 'activity.social.ensure', companionId: 'alice', conversationId: f.playerRoom.id,
    sourceMessageId: f.source.id, deliveryClientId: 'group-seed', operation: 'message' }).activityTask!;
  advance(f.store);
  const leased = f.store.request({ type: 'activity.claim' }).activityTask!; expect(leased.id).toBe(task.id);
  const observed = f.store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! });
  expect(observed.activityMessages?.some(message => message.id === f.question.message.id)).toBe(true);
  return f.store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!, expectedStep: leased.step,
    decision: { status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '已读本人实际问题，等待Bob自主回应，不重复发问。' } }).activityTask!;
}

it('offers one task-authorized reply after an exhausted ordinary chain without changing that parent or adding a message', () => {
  const f = exhaustedSummary(), before = f.parent();
  const count = () => (f.read.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(f.room.id) as { n: number }).n;
  const beforeMessages = count(), task = waitForUnprocessedSummary(f);
  expect(f.parent()).toEqual(before); expect(count()).toBe(beforeMessages);
  const job = claim(f.store)!;
  expect(job).toMatchObject({ companionId: 'bob', sourceMessageId: f.question.message.id, remainingTurns: 1 });
  expect(job.chainId).not.toBe(f.summary.chainId);
  complete(f.store, job, '我愿意自己核对路线。');
  expect(f.parent()).toEqual(before); expect(count()).toBe(beforeMessages + 1);
  f.store.close(); stores.delete(f.store); const restarted = new CompanionsStore(f.filename, seeds); stores.add(restarted);
  for (let tick = 0; tick < 3; tick++) { advance(restarted); restarted.request({ type: 'activity.claim' }); expect(claim(restarted)).toBeUndefined(); }
  expect(f.parent()).toEqual(before);
  const jobs = f.read.prepare("SELECT data FROM companion_social_jobs WHERE companion_id='bob' AND json_extract(data,'$.sourceMessageId')=?").all(f.question.message.id) as { data: string }[];
  expect(jobs).toHaveLength(1); expect(JSON.parse(jobs[0]!.data).replyOpportunity.taskId).toBe(task.id);
  const child = f.read.prepare('SELECT used,status,data FROM companion_social_chains WHERE id=?').get(job.chainId) as { used: number; status: string; data: string };
  expect(child).toMatchObject({ used: 2, status: 'done' }); expect(JSON.parse(child.data).maxMessages).toBe(2);
});

it('does not extend an exhausted ordinary chain without a task wait and cancels its new ticket when that task is cancelled', () => {
  const f = exhaustedSummary(), before = f.parent();
  expect(f.store.request({ type: 'activity.list', companionId: 'alice', conversationId: f.playerRoom.id }).activityTasks).toEqual([]);
  for (let tick = 0; tick < 3; tick++) { advance(f.store); expect(claim(f.store)).toBeUndefined(); }
  const task = waitForUnprocessedSummary(f);
  const pending = f.read.prepare("SELECT id FROM companion_social_jobs WHERE companion_id='bob' AND json_extract(data,'$.sourceMessageId')=? AND status='pending'").all(f.question.message.id);
  expect(pending).toHaveLength(1);
  f.store.request({ type: 'activity.cancel', companionId: 'alice', conversationId: f.playerRoom.id, id: task.id });
  advance(f.store); expect(claim(f.store)).toBeUndefined(); expect(f.parent()).toEqual(before);
  expect(f.store.request({ type: 'social.messages', conversationId: f.room.id }).socialMessagePage!.items.filter(item => item.message.replyToId === f.question.message.id))
    .toHaveLength(1); // Only Carol's original independent reply, never an invented Bob answer.
});
