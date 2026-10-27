import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionSocialJob } from '../../src/shared/companion-social';

const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-social-topic-')) throw Error('Unexpected fixture'); rmSync(root, { recursive: true, force: true }); }
  vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-social-topic-')); roots.push(root); const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, ['alice', 'bob', 'carol'].map(id => ({ id, name: id, persona: '独立伙伴', description: '', model: '', avatar: 'sister', proactive: true, active: true }))); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob', 'carol']) { const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } }); }
  advance(store, 10000);
  const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'alice', title: '独立话题', kind: 'discussion', participantIds: ['bob'] }).topic!;
  store.request({ type: 'topic.join', conversationId: room.id, readerId: 'bob', topicId: topic.id });
  return { store, filename, room, topic };
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function inspect(filename: string, sql: string, ...args: unknown[]): Record<string, unknown> {
  const db = new Database(filename); try { const value = db.prepare(sql).get(...args) as { data: string }; return JSON.parse(value.data); } finally { db.close(); }
}
function pending(store: CompanionsStore, conversationId: string, companionId: string, clientId: string, topicId?: string | null) {
  if (topicId !== undefined) store.request({ type: 'topic.activate', conversationId, readerId: companionId, topicId });
  const command = { type: 'social.send' as const, conversationId, companionId, clientId, channel: 'phone' as const, content: '真实待发来信 ' + clientId };
  expect(store.request(command).socialPending).toBe(true); return command;
}
function source(f: ReturnType<typeof fixture>) { const send = pending(f.store, f.room.id, 'alice', 'original', f.topic.id); advance(f.store, 1300); return f.store.request(send).socialMessage!.message; }
function pause(f: ReturnType<typeof fixture>, readerId: string) { const topic = f.store.request({ type: 'topic.read', conversationId: f.room.id, readerId, topicId: f.topic.id }).topic!; f.store.request({ type: 'topic.pause', conversationId: f.room.id, readerId, topicId: f.topic.id, expectedRevision: topic.revision }); }
function resume(f: ReturnType<typeof fixture>, readerId: string) { const topic = f.store.request({ type: 'topic.read', conversationId: f.room.id, readerId, topicId: f.topic.id }).topic!; f.store.request({ type: 'topic.resume', conversationId: f.room.id, readerId, topicId: f.topic.id, expectedRevision: topic.revision }); }
function finish(store: CompanionsStore, job: CompanionSocialJob) { advance(store, 1300); store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null }); }

it('rejects a discussion group topic on a private destination before persisting a send', () => {
  const f = fixture();
  const group = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob', 'carol'] }).socialConversation!;
  const topic = f.store.request({ type: 'topic.create', conversationId: group.id, readerId: 'alice', title: '小组讨论', kind: 'discussion', participantIds: ['carol'] }).topic!;
  f.store.request({ type: 'topic.join', conversationId: group.id, readerId: 'carol', topicId: topic.id });
  const source = f.store.appendMessage({ conversationId: group.id, topicId: topic.id, authorId: 'carol', content: '请给 bob 单独回复讨论结果。', replyDirective: 'none' });
  const command = { type: 'social.send' as const, conversationId: f.room.id, companionId: 'alice', clientId: 'foreign-destination',
    channel: 'phone' as const, content: '单独回复讨论结果。', topicId: topic.id, agentSource: { conversationId: group.id, messageId: source.id } };
  expect(() => f.store.request(command)).toThrow('本次未发送：目标会话或话题端口对本人无效');
  const db = new Database(f.filename);
  try {
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM companion_social_outbox WHERE client_id=?) AS queued,(SELECT COUNT(*) FROM messages WHERE client_id=?) AS sent")
      .get(command.clientId, command.clientId)).toEqual({ queued: 0, sent: 0 });
  } finally { db.close(); }
});

it('reports a legacy foreign-topic outbox as cancelled and keeps same-client retries retired', () => {
  const f = fixture(), command = pending(f.store, f.room.id, 'alice', 'legacy-destination', f.topic.id);
  const otherRoom = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'carol'] }).socialConversation!;
  const otherTopic = f.store.request({ type: 'topic.create', conversationId: otherRoom.id, readerId: 'alice', title: '另一讨论入口', kind: 'discussion' }).topic!;
  const db = new Database(f.filename);
  try { db.prepare("UPDATE companion_social_outbox SET data=json_set(data,'$.topicId',?) WHERE client_id=?").run(otherTopic.id, command.clientId); }
  finally { db.close(); }
  const result = f.store.request(command);
  expect(result).toMatchObject({ ok: false, error: '本次未发送：目标会话或话题端口对本人无效，请核对目标入口后重新发送。' });
  expect({ pending: result.socialPending, message: result.socialMessage, retry: f.store.request(command) })
    .toEqual({ pending: undefined, message: undefined, retry: result });
  const reopened = new Database(f.filename);
  try {
    expect(reopened.prepare('SELECT status,message_id FROM companion_social_outbox WHERE client_id=?').get(command.clientId))
      .toEqual({ status: 'cancelled', message_id: null });
  } finally { reopened.close(); }
});

it.each(['reader', 'global'] as const)('does not claim or exhaust a %s-paused peer source and resumes the exact pending job', mode => {
  const f = fixture(), original = source(f);
  if (mode === 'reader') pause(f, 'bob');
  else { const db = new Database(f.filename); try { db.prepare("UPDATE companion_topics SET data=json_set(data,'$.status','paused') WHERE id=?").run(f.topic.id); } finally { db.close(); } }
  const other = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'bob', title: '另一个话题', kind: 'discussion', participantIds: ['alice'] }).topic!;
  f.store.request({ type: 'topic.join', conversationId: f.room.id, readerId: 'alice', topicId: other.id });
  const otherSend = pending(f.store, f.room.id, 'bob', 'another-topic', other.id); advance(f.store, 1300); f.store.request(otherSend);
  const available = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(available.companionId).toBe('alice'); expect(available.sourceMessageId).not.toBe(original.id); finish(f.store, available);
  for (let i = 0; i < 12; i++) { advance(f.store, 180001); expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined(); }
  const held = inspect(f.filename, "SELECT data FROM companion_social_jobs WHERE json_extract(data,'$.sourceMessageId')=?", original.id);
  expect(held).toMatchObject({ status: 'pending', attempts: 0, sourceMessageId: original.id });
  if (mode === 'reader') { expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, readerId: 'alice', topicId: f.topic.id }).topic!.status).toBe('active'); resume(f, 'bob'); }
  else { const db = new Database(f.filename); try { db.prepare("UPDATE companion_topics SET data=json_set(data,'$.status','active') WHERE id=?").run(f.topic.id); } finally { db.close(); } }
  const resumed = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(resumed).toMatchObject({ id: held.id, companionId: 'bob', sourceMessageId: original.id, attempts: 1 });
});

it('holds a paused sender outbox, clears its typing lane and continues ordinary work before resuming the frozen topic', () => {
  const f = fixture(); pending(f.store, f.room.id, 'alice', 'paused-sender', f.topic.id); pause(f, 'alice');
  const ordinary = pending(f.store, f.room.id, 'bob', 'ordinary', null); advance(f.store, 1300);
  const ready = f.store.request({ type: 'social.job.claim' });
  expect(ready.socialMessage!.message.topicId).toMatch(/^main_/u); expect(ready.socialJob!.companionId).toBe('alice');
  const held = inspect(f.filename, "SELECT data FROM companion_social_outbox WHERE client_id='paused-sender'");
  expect(held.typingNotBefore).toBeUndefined(); expect(held.topicId).toBe(f.topic.id);
  const db = new Database(f.filename); try { expect(db.prepare("SELECT status FROM companion_social_outbox WHERE client_id='paused-sender'").get()).toEqual({ status: 'pending' }); } finally { db.close(); }
  finish(f.store, ready.socialJob!); expect(f.store.request(ordinary).socialMessage).toBeDefined();
  resume(f, 'alice'); expect(f.store.request({ type: 'social.job.claim' }).socialMessage).toBeUndefined(); advance(f.store, 1300);
  const resumed = f.store.request({ type: 'social.job.claim' }).socialMessage!;
  expect(resumed.message.topicId).toBe(f.topic.id); expect(resumed.message.content).toContain('paused-sender');
});

it('releases a live paused reader lease and preserves its attempt count until an explicit resume', () => {
  const f = fixture(), original = source(f), running = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(running.attempts).toBe(1); pause(f, 'bob');
  expect(() => f.store.request({ type: 'social.job.complete', id: running.id, leaseToken: running.leaseToken!, text: 'stale paused reply' })).toThrow('租约');
  for (let i = 0; i < 12; i++) expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  expect(inspect(f.filename, 'SELECT data FROM companion_social_jobs WHERE id=?', running.id)).toMatchObject({ status: 'pending', attempts: 1 });
  resume(f, 'bob');
  expect(f.store.request({ type: 'social.job.claim' }).socialJob).toMatchObject({ id: running.id, sourceMessageId: original.id, attempts: 2 });
});

it.each(['closed', 'deleted', 'left'] as const)('cancels %s topic queued sends and peer jobs while another room still advances', terminal => {
  const f = fixture(), original = source(f); pending(f.store, f.room.id, 'bob', 'retired-sender', f.topic.id);
  const otherRoom = f.store.request({ type: 'social.conversation.ensure', companionId: 'carol', memberIds: ['alice', 'carol'] }).socialConversation!;
  pending(f.store, otherRoom.id, 'carol', 'unrelated', null);
  const topic = f.store.request({ type: 'topic.read', conversationId: f.room.id, readerId: 'alice', topicId: f.topic.id }).topic!;
  if (terminal === 'left') f.store.request({ type: 'topic.leave', conversationId: f.room.id, readerId: 'bob', topicId: topic.id });
  else f.store.request({ type: terminal === 'closed' ? 'topic.close' : 'topic.delete', conversationId: f.room.id, readerId: terminal === 'closed' ? 'alice' : 'user', topicId: topic.id, expectedRevision: topic.revision });
  expect(inspect(f.filename, "SELECT data FROM companion_social_jobs WHERE json_extract(data,'$.sourceMessageId')=?", original.id)).toMatchObject({ status: 'cancelled', attempts: 0 });
  if (terminal === 'left') f.store.request({ type: 'topic.join', conversationId: f.room.id, readerId: 'bob', topicId: topic.id });
  if (terminal === 'closed') { const latest = f.store.request({ type: 'topic.read', conversationId: f.room.id, readerId: 'alice', topicId: topic.id }).topic!; f.store.request({ type: 'topic.reopen', conversationId: f.room.id, readerId: 'alice', topicId: topic.id, expectedRevision: latest.revision }); }
  advance(f.store, 1300); const ready = f.store.request({ type: 'social.job.claim' });
  expect(ready.socialMessage!.message.conversationId).toBe(otherRoom.id); expect(ready.socialJob!.conversationId).toBe(otherRoom.id);
  expect(inspect(f.filename, "SELECT data FROM companion_social_jobs WHERE json_extract(data,'$.sourceMessageId')=?", original.id)).toMatchObject({ status: 'cancelled', attempts: 0 });
  const db = new Database(f.filename); try { expect(db.prepare("SELECT status FROM companion_social_outbox WHERE client_id='retired-sender'").get()).toEqual({ status: 'cancelled' }); } finally { db.close(); }
  finish(f.store, ready.socialJob!);
  expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
});
