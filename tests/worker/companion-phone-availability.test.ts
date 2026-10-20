import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '尊重真实来源。', description: '', model: '', avatar: 'sister', proactive: true }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-phone-')); roots.push(root); const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const settings = store.request({ type: 'world.snapshot' }).world!.settings; store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const id of ['alice', 'bob']) { const scope = { companionId: id, conversationId: store.openPrivate(id).id }, initial = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: initial.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } }); }
  advance(store, 10000); const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  return { store, scope, room };
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function actor(store: CompanionsStore) { return store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!; }
function routine(f: ReturnType<typeof fixture>, kind: 'rest' | 'study') {
  const initial = f.store.request({ type: 'routine.get', ...f.scope }).routine!;
  f.store.request({ type: 'routine.configure', ...f.scope, expectedRevision: initial.revision, patch: { habits: [{ id: 'afternoon', title: '私人活动', at: '10:00', durationMinutes: 30, kind }] } }); advance(f.store, 10000);
}
it.each(['resting', 'habit', 'walking'] as const)('sends peer phone messages while %s, using the real phone pose and preserving the route/activity', activity => {
  const f = fixture();
  if (activity === 'walking') { f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: 'alice_computer' } }); advance(f.store, 2000); }
  else routine(f, activity === 'resting' ? 'rest' : 'study');
  const before = actor(f.store); expect(before.activity).toBe(activity);
  expect(f.store.request({ type: 'routine.get', ...f.scope }).routine!.runtime.canRespond).toBe(true);
  const practice = f.store.request({ type: 'routine.get', ...f.scope }).routine!.habitProgress[0]?.practicedMinutes;
  const send = { type: 'social.send' as const, companionId: 'alice', conversationId: f.room.id, channel: 'phone' as const, content: '现在用手机和你打个招呼。', clientId: 'available_' + activity };
  expect(f.store.request(send).socialPending).toBe(true); advance(f.store, 20);
  const during = companionStorageResponseSchema.parse(f.store.request({ type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === 'alice')!;
  expect(during.position).toEqual(before.position); expect(during.communication?.phase).toBe('typing');
  expect(during.artAction).toBe(activity === 'resting' ? 'phoneTypingSeated' : 'phoneTypingStanding');
  if (activity === 'habit') expect(f.store.request({ type: 'routine.get', ...f.scope }).routine!.habitProgress[0]!.practicedMinutes).toBeCloseTo(practice!, 9);
  advance(f.store, 1300); expect(f.store.request({ type: 'social.job.claim' }).socialMessage?.message.content).toBe(send.content);
  advance(f.store, 1000);
  const after = actor(f.store); expect(after.communication?.phase).not.toBe('typing');
  if (activity === 'walking') expect(after.position).not.toEqual(before.position); else expect(after.activity).toBe(activity);
  expect(f.store.listAction()).toEqual([]);
});

it('allows a factual delegated continuation during a reading habit without inventing activity or a user message', () => {
  const f = fixture(), source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请你问 Bob 能否一起读书，随后告诉我他的回复。', replyDirective: 'none' });
  const send = { type: 'social.send' as const, companionId: 'alice', conversationId: f.room.id, channel: 'phone' as const, content: 'Bob，你愿意一起读书吗？', authorizationMessageId: source.id, clientId: 'delegation_before_reading' };
  f.store.request(send); advance(f.store, 1300);
  const bob = f.store.request({ type: 'social.job.claim' }).socialJob!; advance(f.store, 1300);
  const response = f.store.request({ type: 'social.job.complete', id: bob.id, leaseToken: bob.leaseToken!, text: '愿意，等你有空再一起读。' }).socialMessage!;
  const stop = f.store.request({ type: 'social.job.claim' }).socialJob!; advance(f.store, 1300); f.store.request({ type: 'social.job.complete', id: stop.id, leaseToken: stop.leaseToken!, text: null });
  routine(f, 'study'); expect(actor(f.store).activity).toBe('habit');
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(notice.evidence.messageId).toBe(response.message.id); advance(f.store, 1);
  expect(actor(f.store)).toMatchObject({ activity: 'idle', artAction: 'phoneTypingStanding', communication: { phase: 'typing', recipientIds: ['user'] } });
  const complete = { type: 'social.notification.complete' as const, id: notice.id, leaseToken: notice.leaseToken!, text: 'Bob 回复愿意一起读书，我们还没有开始。' };
  const actual = f.store.request(complete).message!; expect(actual).toMatchObject({ authorId: 'alice', conversationId: f.scope.conversationId, replyToId: source.id });
  expect(f.store.request(complete).message!.id).toBe(actual.id); advance(f.store, 1000); expect(actor(f.store).activity).toBe('habit');
  expect(f.store.messages({ conversationId: f.scope.conversationId }).messages.filter(message => message.content === complete.text)).toHaveLength(1);
});
