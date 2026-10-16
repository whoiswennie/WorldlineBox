import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionActivityTask, ActivityDecision } from '../../src/shared/companion-activity-task';
const seeds: CompanionSeed[] = ['alice','bob'].map(id => ({ id, name: id, persona: '友好且尊重边界', description: '', model: '', avatar: 'sister', proactive: true }));
let root: string, filename: string, store: CompanionsStore;
let alice: { companionId: string; conversationId: string }, bob: typeof alice;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-16T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-activity-')); filename = path.join(root, 'state.sqlite'); store = new CompanionsStore(filename, seeds);
  alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }; bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const scope of [alice,bob]) { const routine = store.request({ type: 'routine.get', ...scope }).routine!; store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', meals: [], habits: [], sleepAt: '23:00', wakeAt: '07:00' } }); }
});
afterEach(() => { store?.close(); const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-activity-')) throw new Error('Invalid cleanup'); rmSync(resolved, { recursive: true, force: true }); vi.useRealTimers(); });
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function start(clientId = 'goal_one') {
  const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '去联系bob，问到地址后走到她家门口，等允许再决定进入。', replyDirective: 'none' });
  const input = { type: 'activity.start', ...alice, clientId, sourceMessageId: source.id, title: '去bob家做客', goal: source.content } as const;
  return { input, task: store.request(input).activityTask!, source };
}
function claim() { return store.request({ type: 'activity.claim' }).activityTask; }
function commit(task: CompanionActivityTask, decision: ActivityDecision) { return store.request({ type: 'activity.commit', id: task.id, leaseToken: task.leaseToken!, decision }).activityTask!; }
function shareAddress() {
  store.request({ type: 'world.tool', ...bob, arguments: { action: 'share_address', recipientIds: ['alice'] } });
  store.request({ type: 'social.job.claim' }); advance(1600);
  const delivery = store.request({ type: 'social.job.claim' });
  if (delivery.socialJob) { advance(1600); store.request({ type: 'social.job.complete', id: delivery.socialJob.id, leaseToken: delivery.socialJob.leaseToken!, text: null }); }
  advance(6000);
}
it('has private intrinsic home memory; contacts and permits never grant addresses or move actors', () => {
  const own = store.request({ type: 'world.observe', ...alice }).world!;
  expect(own.knownAddresses?.map(address => address.companionId)).toEqual(['alice']);
  expect(own.homeMemory?.ownerId).toBe('alice'); expect(own.homeMemory?.objects.some(object => object.kind === 'bed')).toBe(true);
  expect(own.residents.find(role => role.companionId === 'bob')).not.toHaveProperty('homeSceneId');
  expect(() => store.request({ type: 'world.tool', ...alice, arguments: { action: 'navigate', targetCompanionId: 'bob' } })).toThrow('住址');
  expect(() => store.request({ type: 'world.tool', ...alice, arguments: { action: 'move', destinationId: 'bob_entrance' } })).toThrow('地址');
  const world = store.request({ type: 'world.tool', ...alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '想过来坐坐，方便吗' } }).world!;
  const visit = world.visits.find(visit => visit.guestId === 'alice')!;
  store.request({ type: 'world.tool', ...bob, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '可以' } });
  const after = advance(40000); expect(after.actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('home_alice');
  expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(1);
  shareAddress(); const known = store.request({ type: 'world.observe', ...alice }).world!.knownAddresses!;
  expect(known.find(address => address.companionId === 'bob')).toMatchObject({ source: 'owner_shared', entrance: { sceneId: 'commons' } });
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'navigate', targetCompanionId: 'bob' } });
  advance(40000); const atDoor = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!;
  expect(atDoor.sceneId).toBe('commons'); expect(atDoor.route).toHaveLength(0);
  advance(5000); expect(store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.sceneId).toBe('commons');
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'enter', targetCompanionId: 'bob' } });
  expect(advance(8000).actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('home_bob');
});
it('resumes a goal from real arrival across restart, keeps UUID and effects idempotent, then reports without another user message', () => {
  shareAddress(); const { input, task } = start(); expect(store.request(input).activityTask!.id).toBe(task.id);
  const leased = claim()!;
  const waiting = commit(leased, { status: 'continue', action: { action: 'navigate', targetCompanionId: 'bob' }, wait: null, summary: '前往门口' });
  expect(waiting.status).toBe('waiting'); expect(waiting.step).toBe(1);
  expect(() => commit(leased, { status: 'complete', action: null, wait: null, summary: '重复回执' })).toThrow('租约');
  advance(1500); expect(claim()).toBeUndefined(); const before = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.position;
  store.close(); store = new CompanionsStore(filename, seeds); store.request({ type: 'activity.recover' });
  expect(store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.position).toEqual(before);
  advance(40000); const resumed = claim()!; expect(resumed.id).toBe(task.id); expect(resumed.stage).toContain('抵达');
  const done = commit(resumed, { status: 'complete', action: null, wait: null, summary: '已经到门口，按要求没有擅自进去。' });
  expect(done.status).toBe('succeeded'); const messages = store.request({ type: 'messages', conversationId: alice.conversationId, limit: 50 }).messages!;
  expect(messages.filter(message => message.authorId === 'alice' && message.content.includes('已完成'))).toHaveLength(1);
  expect(messages.filter(message => message.authorId === 'user' && message.content === input.goal)).toHaveLength(1);
});
it('waits on genuine peer replies, learns an address only after delivery, and revokes it on forgetting', () => {
  const { task } = start(); const running = claim()!;
  commit(running, { status: 'continue', action: { action: 'message', recipientIds: ['bob'], text: '想去你家坐坐，可以分享地址吗？' }, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '询问地址' });
  advance(1600); expect(claim()).toBeUndefined();
  const delivery = store.request({ type: 'social.job.claim' }); advance(1600);
  const job = delivery.socialJob ?? store.request({ type: 'social.job.claim' }).socialJob!; expect(job.companionId).toBe('bob');
  expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(1);
  advance(1600); const sent = store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '可以，给你地址。', shareAddress: true }).socialMessage!;
  expect(sent.message.content).toContain('commons'); advance(1600);
  const next = claim()!; expect(next.id).toBe(task.id); const context = store.request({ type: 'activity.observe', id: next.id, leaseToken: next.leaseToken! });
  expect(context.activityMessages?.some(message => message.id === sent.message.id)).toBe(true);
  expect(context.world!.knownAddresses).toHaveLength(2);
  store.request({ type: 'memory.forget', companionId: 'alice', conversationId: sent.message.conversationId, sourceMessageIds: [sent.message.id] });
  expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(1);
  expect(() => commit(next, { status: 'complete', action: null, wait: null, summary: '不能回传已撤回资料' })).toThrow('来源');
});
it('cancels withdrawn sources, rejects foreign owners, caps repeated failures and empty plans', () => {
  const { task, source } = start(); expect(() => store.request({ type: 'activity.cancel', ...bob, id: task.id })).toThrow('其他');
  const first = claim()!;
  store.request({ type: 'memory.forget', ...alice, sourceMessageIds: [source.id] });
  expect(() => commit(first, { status: 'continue', action: { action: 'leave' }, wait: null, summary: '旧目标' })).toThrow('来源');
  expect(store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask!.goal).not.toContain(source.content);
  advance(121000); expect(claim()).toBeUndefined(); expect(store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask!.status).toBe('cancelled');
  start('goal_two'); for (let attempt = 0; attempt < 3; attempt++) { const current = claim()!; const result = commit(current, { status: 'continue', action: { action: 'navigate', targetCompanionId: 'bob' }, wait: null, summary: '猜地址不应成功' }); if (attempt === 2) expect(result.status).toBe('failed'); advance(1600); }
  start('empty_goal'); const empty = commit(claim()!, { status: 'continue', action: null, wait: null, summary: '空循环' }); expect(empty.status).toBe('failed');
});
it('stops only its own pending route on cancellation and times out waits without endless polling', () => {
  shareAddress(); const { task } = start(); commit(claim()!, { status: 'continue', action: { action: 'navigate', targetCompanionId: 'bob' }, wait: null, summary: '导航' });
  advance(1000); const position = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.position;
  store.request({ type: 'activity.cancel', ...alice, id: task.id }); const actor = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!;
  expect(actor.route).toHaveLength(0); expect(actor.position).toEqual(position);
  start('waiting_goal'); commit(claim()!, { status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '等待来信' });
  advance(1600); expect(claim()).toBeUndefined(); advance(300001);
  const expired = claim()!; expect(expired.stage).toContain('超时'); expect(expired.status).toBe('running');
  commit(expired, { status: 'blocked', action: null, wait: null, summary: '没有等到回复，先不打扰。' });
  advance(5000); expect(claim()).toBeUndefined();
});
it('continues a newly issued route when a just-received phone conversation releases its pose', () => {
  store.request({ type: 'world.tool', ...bob, arguments: { action: 'share_address', recipientIds: ['alice'] } });
  store.request({ type: 'social.job.claim' }); advance(1600); const reply = store.request({ type: 'social.job.claim' }).socialJob!;
  advance(1600); store.request({ type: 'social.job.complete', id: reply.id, leaseToken: reply.leaseToken!, text: null });
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'navigate', targetCompanionId: 'bob' } });
  const arrived = advance(40000).actors.find(actor => actor.companionId === 'alice')!;
  expect(arrived.sceneId).toBe('commons'); expect(arrived.route).toHaveLength(0);
});
it('resumes and finishes a route accepted during a long player phone lease', () => {
  const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '一边聊一边走到沙发旁。', replyDirective: 'none' });
  store.request({ type: 'world.work.begin', ...alice, kind: 'chat', workId: 'short_phone', sourceMessageId: source.id });
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'move', destinationId: 'alice_sofa' } });
  advance(12000); store.request({ type: 'world.work.end', companionId: 'alice', workId: 'short_phone' });
  const self = advance(12000).actors.find(actor => actor.companionId === 'alice')!;
  expect(self.route).toHaveLength(0); expect(self.activity).toBe('idle');
});
