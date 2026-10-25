import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { companionsRequestSchema } from '../../src/shared/companions';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const owned: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
const services: CompanionWorldService[] = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const f of owned.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); }
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-activity-social-route-')), filename = path.join(root, 'messages.sqlite');
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
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请联系b核对读书讨论安排，并持续完成这项完整目标。', replyDirective: 'none' });
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
  return { store, db, scope, source, query, start, send, advance, state, filename }; 
}


function peerEvent(f: ReturnType<typeof fixture>) {
  const sent = f.send(); f.advance(); f.store.request(sent.command);
  const responder = f.store.request({ type: 'social.job.claim' }).socialJob!; expect(responder.companionId).toBe('b');
  f.advance();
  const reply = f.store.request({ type: 'social.job.complete', id: responder.id, leaseToken: responder.leaseToken!,
    text: '我已核对实际安排，原计划可以继续。' }).socialMessage!.message;
  f.advance();
  return { ...sent, reply };
}
const rows = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT * FROM companion_activity_social_inbox ORDER BY rowid').all() as Array<{
  task_id: string; message_id: string; status: string; observed_lease: string | null }>;

it('routes the original ongoing discussion through the normal social worker without a second model, then observes and consumes the durable event once', async () => {
  const f = fixture(), event = peerEvent(f), messagesBefore = f.store.request({ type: 'messages', conversationId: event.room.id, limit: 100 }).messages;
  const requests: string[] = [], fetchFn = vi.fn<typeof fetch>(async () => { throw Error('A routed event must not open another model brain.'); });
  const service = new CompanionWorldService({ request: async command => { requests.push(command.type); return f.store.request(command); }, fetchFn,
    configFor: async () => ({ apiFormat: 'openai_chat', baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture' }),
    changed: vi.fn(), wakeWaiting: vi.fn(), report: vi.fn(), blocked: owner => owner !== 'a' }); services.push(service);
  await service.tick();
  await vi.waitFor(async () => { await service.tick(); expect(requests).toContain('activity.social.route'); }, { timeout: 3000 });
  await vi.waitFor(() => expect(rows(f)).toEqual([expect.objectContaining({ task_id: event.task.id, message_id: event.reply.id, status: 'pending' })]));
  f.advance(2000);
  await vi.waitFor(() => expect(f.db.prepare("SELECT status FROM companion_social_jobs WHERE companion_id='a' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ status: 'done' }), { timeout: 3000 });
  await service.close();
  expect(requests).toContain('social.job.complete'); expect(fetchFn).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'messages', conversationId: event.room.id, limit: 100 }).messages).toEqual(messagesBefore);
  expect((f.db.prepare('SELECT COUNT(*) AS n FROM companion_activity_tasks').get() as { n: number }).n).toBe(1);
  const claimed = f.store.request({ type: 'activity.claim' }).activityTask!; expect(claimed.id).toBe(event.task.id);
  const observed = f.store.request({ type: 'activity.observe', id: claimed.id, leaseToken: claimed.leaseToken! });
  expect(observed.activityMessages?.some(message => message.id === event.reply.id)).toBe(true);
  expect(rows(f)[0]).toMatchObject({ status: 'pending', observed_lease: claimed.leaseToken });
  // Recovery reclaims the original task. An observed but uncommitted event stays pending.
  f.store.request({ type: 'activity.recover' });
  const recovered = f.store.request({ type: 'activity.claim' }).activityTask!; expect(recovered.id).toBe(claimed.id);
  expect(recovered.leaseToken).not.toBe(claimed.leaseToken);
  expect(f.store.request({ type: 'activity.observe', id: recovered.id, leaseToken: recovered.leaseToken! }).activityMessages)
    .toContainEqual(expect.objectContaining({ id: event.reply.id }));
  f.store.request({ type: 'activity.commit', id: recovered.id, leaseToken: recovered.leaseToken!, expectedStep: recovered.step,
    decision: { status: 'continue', action: null, wait: { kind: 'delay', seconds: 300 }, summary: '已读取本人目标的新来信，稍后按原计划继续。' } });
  expect(rows(f)[0]?.status).toBe('consumed');
  f.store.request({ type: 'activity.recover' });
  expect(f.store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
  expect(rows(f)).toHaveLength(1);
});

it('requires the exact live owner lease and goal lineage, keeps a running task lease, and refuses a withdrawn event', () => {
  const f = fixture(), event = peerEvent(f), job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(job.companionId).toBe('a');
  const command = { type: 'activity.social.route' as const, companionId: 'a', conversationId: event.room.id, jobId: job.id, leaseToken: job.leaseToken! };
  expect(companionsRequestSchema.safeParse(command).success).toBe(false); // Renderer/model request surface cannot invoke this host hook.
  expect(f.store.request({ ...command, leaseToken: 'different_lease' }).activitySocialRoute).toBeUndefined();
  expect(f.store.request({ ...command, companionId: 'b' }).activitySocialRoute).toBeUndefined();
  expect(rows(f)).toEqual([]);
  const original = f.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(event.task.id) as { data: string };
  const task = JSON.parse(original.data); task.status = 'running'; task.leaseToken = 'actual_activity_lease'; task.leaseUntil = Date.now() + 120000;
  f.db.prepare("UPDATE companion_activity_tasks SET status='running',data=? WHERE id=?").run(JSON.stringify(task), event.task.id);
  expect(f.store.request(command).activitySocialRoute).toEqual({ taskId: event.task.id, sourceMessageId: event.reply.id });
  expect(f.store.request(command).activitySocialRoute).toEqual({ taskId: event.task.id, sourceMessageId: event.reply.id });
  expect(rows(f)).toHaveLength(1);
  expect((f.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(event.task.id) as { data: string }).data).toBe(JSON.stringify(task));
  f.advance();
  f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null });
  f.store.request({ type: 'memory.forget', companionId: 'a', conversationId: event.room.id, sourceMessageIds: [event.reply.id] });
  f.store.request({ type: 'activity.recover' });
  const resumed = f.store.request({ type: 'activity.claim' }).activityTask;
  if (resumed) expect(f.store.request({ type: 'activity.observe', id: resumed.id, leaseToken: resumed.leaseToken! }).activityMessages?.some(m => m.id === event.reply.id)).toBe(false);
  expect(rows(f)[0]?.status).toBe('cancelled');
});

it('rejects an old terminal proposal when another exact goal event arrives after observation', () => {
  const f = fixture(), event = peerEvent(f), owner = f.store.request({ type: 'social.job.claim' }).socialJob!;
  const route = (job: typeof owner) => f.store.request({ type: 'activity.social.route', companionId: 'a', conversationId: event.room.id,
    jobId: job.id, leaseToken: job.leaseToken! });
  expect(route(owner).activitySocialRoute?.taskId).toBe(event.task.id);
  f.advance(); f.store.request({ type: 'social.job.complete', id: owner.id, leaseToken: owner.leaseToken!, text: null });
  const first = f.store.request({ type: 'activity.claim' }).activityTask!;
  f.store.request({ type: 'activity.observe', id: first.id, leaseToken: first.leaseToken! });
  f.store.request({ type: 'activity.commit', id: first.id, leaseToken: first.leaseToken!, expectedStep: first.step,
    decision: { status: 'continue', action: { action: 'message', recipientIds: ['b'], text: '请核对刚补充的安排。' }, wait: null,
      summary: '原目标继续，向本人实际联系人询问补充安排。' } });
  f.advance(); const nextPeer = f.store.request({ type: 'social.job.claim' }).socialJob!; expect(nextPeer.companionId).toBe('b');
  const running = f.store.request({ type: 'activity.claim' }).activityTask!; expect(running.id).toBe(first.id);
  f.store.request({ type: 'activity.observe', id: running.id, leaseToken: running.leaseToken! });
  f.advance();
  const newMessage = f.store.request({ type: 'social.job.complete', id: nextPeer.id, leaseToken: nextPeer.leaseToken!,
    text: '补充安排还没确认，先不要结束原目标。' }).socialMessage!.message;
  const nextOwner = f.store.request({ type: 'social.job.claim' }).socialJob!; expect(nextOwner.companionId).toBe('a');
  expect(route(nextOwner).activitySocialRoute?.sourceMessageId).toBe(newMessage.id);
  expect(() => f.store.request({ type: 'activity.commit', id: running.id, leaseToken: running.leaseToken!, expectedStep: running.step,
    decision: { status: 'complete', action: null, wait: null, summary: '依据旧观察结束。' } })).toThrow('尚未观察的新来信');
  expect(rows(f).filter(row => row.status === 'pending').map(row => row.message_id)).toEqual([newMessage.id]);
  expect(f.store.request({ type: 'activity.observe', id: running.id, leaseToken: running.leaseToken! }).activityMessages)
    .toContainEqual(expect.objectContaining({ id: newMessage.id }));
});
