import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { COMPANION_ACTIVITY_HANDOFF_NOTICE } from '../../src/shared/companion-activity-task';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const owned: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => {
  for (const f of owned.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); }
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-activity-handoff-')), filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, ['a', 'b', 'c'].map(id => ({ id, name: id, persona: '尊重边界', description: '',
    avatar: 'sister' as const, active: true, proactive: false, model: '' })));
  const db = new (Database as { new(file: string): CompanionConnection })(filename); owned.push({ root, store, db });
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['a', 'b', 'c']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', meals: [], habits: [], sleepAt: '23:59', wakeAt: '00:01' } });
  }
  const advance = (ms = 2000) => { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); };
  advance(10000);
  const scope = { companionId: 'a', conversationId: store.openPrivate('a').id };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请联系b并继续完成这项完整目标。', replyDirective: 'none' });
  const query = { type: 'activity.handoff' as const, ...scope, sourceMessageId: source.id, sourceChecksum: sha(source.content) };
  const start = () => store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id, clientId: 'actual_goal', title: '持续原目标', goal: source.content }).activityTask!;
  const send = () => {
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', 'b'] }).socialConversation!;
    const command = { type: 'social.send' as const, companionId: 'a', conversationId: room.id, channel: 'phone' as const,
      content: '一起核对完成这个目标吧。', clientId: 'actual_initial_call', authorizationMessageId: source.id,
      agentSource: { conversationId: source.conversationId, messageId: source.id } };
    const result = store.request(command);
    const task = store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: source.id, deliveryClientId: command.clientId, operation: 'message' }).activityTask!;
    return { room, command, task, result };
  };
  const state = () => JSON.stringify({
    tasks: db.prepare('SELECT * FROM companion_activity_tasks ORDER BY id').all(),
    effects: db.prepare('SELECT * FROM companion_social_outbox ORDER BY client_id').all(),
    messages: db.prepare('SELECT * FROM messages ORDER BY sequence').all(),
    metadata: db.prepare('SELECT * FROM metadata ORDER BY key').all(),
  });
  return { store, db, scope, source, query, start, send, advance, state };
}

it.each(['queued', 'running', 'waiting'] as const)('acknowledges the exact real %s task without dispatching or changing durable state', status => {
  const f = fixture(), task = f.start();
  if (status !== 'queued') {
    const leased = f.store.request({ type: 'activity.claim' }).activityTask!;
    expect(leased.id).toBe(task.id);
    if (status === 'waiting') f.store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!,
      decision: { status: 'continue', action: null, wait: { kind: 'delay', seconds: 300 }, summary: '等待真实条件后继续。' } });
  }
  const before = f.state(), result = f.store.request(f.query);
  expect(companionStorageResponseSchema.safeParse(result).success).toBe(true);
  expect(result.activityHandoff).toMatchObject({ task: { id: task.id, status, historyAvailable: true }, existingEffect: false,
    executor: 'background_activity', newVirtualActionDispatched: false, notice: COMPANION_ACTIVITY_HANDOFF_NOTICE });
  expect(f.store.request(f.query)).toEqual(result); expect(f.state()).toBe(before);
});

it.each(['pending', 'sent'] as const)('recognizes only an actual seeded %s social receipt and retains original retry fingerprint checks', status => {
  const f = fixture(), sent = f.send();
  expect(sent.result.socialPending).toBe(true);
  if (status === 'sent') { f.advance(); expect(f.store.request(sent.command).socialMessage).toBeDefined(); }
  expect(f.db.prepare('SELECT status FROM companion_social_outbox WHERE client_id=?').get(sent.command.clientId)).toEqual({ status });
  const before = f.state(), result = f.store.request({ ...f.query, clientId: sent.command.clientId });
  expect(result.activityHandoff).toMatchObject({ task: { id: sent.task.id }, existingEffect: true, newVirtualActionDispatched: false });
  expect(f.store.request({ ...f.query, clientId: 'unrecorded_call' }).activityHandoff?.existingEffect).toBe(false);
  expect(f.state()).toBe(before);
  const retried = f.store.request(sent.command);
  if (status === 'sent') expect(retried.socialMessage!.message.id).toBe((f.db.prepare('SELECT message_id FROM companion_social_outbox WHERE client_id=?').get(sent.command.clientId) as { message_id: string }).message_id);
  expect(() => f.store.request({ ...sent.command, content: '同ID冒充新动作。' })).toThrow('重试标识');
  expect(f.db.prepare('SELECT count(*) AS n FROM companion_social_outbox').get()).toEqual({ n: 1 });
});

it.each(['unseeded', 'missing', 'cancelled', 'foreign', 'wrong_room', 'checksum', 'source_field', 'published_bytes'] as const)('does not claim an existing effect for %s receipt evidence', invalidation => {
  const f = fixture(), sent = f.send();
  f.advance(); f.store.request(sent.command);
  expect(f.store.request({ ...f.query, clientId: sent.command.clientId }).activityHandoff?.existingEffect).toBe(true);
  if (invalidation === 'unseeded') {
    const row = f.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(sent.task.id) as { data: string };
    const data = JSON.parse(row.data); data.seededSocialClientIds = [];
    f.db.prepare('UPDATE companion_activity_tasks SET data=? WHERE id=?').run(JSON.stringify(data), sent.task.id);
  } else if (invalidation === 'missing') f.db.prepare('DELETE FROM companion_social_outbox WHERE client_id=?').run(sent.command.clientId);
  else if (invalidation === 'cancelled') f.db.prepare("UPDATE companion_social_outbox SET status='cancelled' WHERE client_id=?").run(sent.command.clientId);
  else if (invalidation === 'foreign') f.db.prepare("UPDATE companion_social_outbox SET companion_id='b' WHERE client_id=?").run(sent.command.clientId);
  else if (invalidation === 'wrong_room') f.db.prepare('UPDATE companion_social_outbox SET conversation_id=? WHERE client_id=?').run(f.source.conversationId, sent.command.clientId);
  else if (invalidation === 'checksum') f.db.prepare("UPDATE companion_social_outbox SET data=json_set(data,'$.authorizationChecksum',?) WHERE client_id=?").run('0'.repeat(64), sent.command.clientId);
  else if (invalidation === 'source_field') f.db.prepare("UPDATE companion_social_outbox SET data=json_set(data,'$.agentSource.messageId','forged_source') WHERE client_id=?").run(sent.command.clientId);
  else f.db.prepare("UPDATE messages SET content='revised published body' WHERE id=(SELECT message_id FROM companion_social_outbox WHERE client_id=?)").run(sent.command.clientId);
  expect(f.store.request({ ...f.query, clientId: sent.command.clientId }).activityHandoff).toMatchObject({ task: { id: sent.task.id }, existingEffect: false });
});

it.each(['owner', 'room', 'source', 'checksum', 'source_revised', 'source_withdrawn', 'inactive', 'cancelled', 'failed', 'succeeded', 'duplicate'] as const)('does not hand off when %s invalidates the unique active original goal', invalidation => {
  const f = fixture(), task = f.start(), query = { ...f.query };
  expect(f.store.request(query).activityHandoff?.task.id).toBe(task.id);
  if (invalidation === 'owner') query.companionId = 'b';
  else if (invalidation === 'room') query.conversationId = f.store.openPrivate('b').id;
  else if (invalidation === 'source') query.sourceMessageId = 'not_actual_source';
  else if (invalidation === 'checksum') query.sourceChecksum = '0'.repeat(64);
  else if (invalidation === 'source_revised') f.db.prepare("UPDATE messages SET content='same ID revised human request' WHERE id=?").run(f.source.id);
  else if (invalidation === 'source_withdrawn') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  else if (invalidation === 'inactive') f.db.prepare("UPDATE companions SET data=json_set(data,'$.active',json('false')) WHERE id='a'").run();
  else if (invalidation === 'cancelled') f.store.request({ type: 'activity.cancel', ...f.scope, id: task.id });
  else if (invalidation === 'failed' || invalidation === 'succeeded') {
    const leased = f.store.request({ type: 'activity.claim' }).activityTask!;
    if (invalidation === 'failed') f.store.request({ type: 'activity.fail', id: task.id, leaseToken: leased.leaseToken!, error: '真实终态失败', terminal: true });
    else f.store.request({ type: 'activity.commit', id: task.id, leaseToken: leased.leaseToken!, decision: { status: 'complete', action: null, wait: null, summary: '本轮实际目标完成。' } });
  } else f.store.request({ type: 'activity.start', ...f.scope, sourceMessageId: f.source.id, clientId: 'second_actual_task', title: '第二份独立任务', goal: f.source.content });
  expect(f.store.request(query).activityHandoff).toBeUndefined();
});

it('does not let a revised same-ID human source match the old task even with its newly current hash', () => {
  const f = fixture(); f.start();
  f.db.prepare("UPDATE messages SET content='new human contents under same ID' WHERE id=?").run(f.source.id);
  expect(f.store.request({ ...f.query, sourceChecksum: sha('new human contents under same ID') }).activityHandoff).toBeUndefined();
});

it('returns only an actual motion handoff acknowledgement and does not invent or repeat a native movement receipt', () => {
  const f = fixture();
  const result = f.store.request({ type: 'activity.motion.ensure', ...f.scope, sourceMessageId: f.source.id,
    arguments: { action: 'move', destinationId: 'a_door' } });
  const before = f.state();
  expect(f.store.request({ ...f.query, clientId: 'motion_' + sha('a:' + f.source.id) }).activityHandoff)
    .toMatchObject({ task: { id: result.activityTask!.id, step: 1 }, existingEffect: false, newVirtualActionDispatched: false });
  expect(f.state()).toBe(before);
});

it('does not treat a current peer message as a new human delegation or match a task by title', () => {
  const f = fixture(); f.start();
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'a', content: f.source.content, replyDirective: 'none' });
  expect(f.store.request({ ...f.query, sourceMessageId: source.id, sourceChecksum: sha(source.content) }).activityHandoff).toBeUndefined();
});
