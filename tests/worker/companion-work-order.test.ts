import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { recordUrgentAttention } from '../helpers/companion-world-fixture';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '尊重来源', model: '', avatar: 'sister', proactive: false }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function open(file: string) { const store = new CompanionsStore(file, seeds); stores.add(store); return store; }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-work-order-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = open(filename), world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'UTC' } });
  return { store, filename, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function advance(store: CompanionsStore, milliseconds: number) { vi.setSystemTime(Date.now() + milliseconds); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function actor(store: CompanionsStore) { return store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!; }
function source(f: ReturnType<typeof fixture>, content = '请帮我执行这项检查。') { return f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content, replyDirective: 'none' }); }

it('respects opting out of autonomous visits while a genuine current player request can still initiate one', () => {
  const f = fixture();
  expect(() => f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '自行拜访' } })).toThrow('未开启主动联系');
  const self = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '我自己想去拜访。', replyDirective: 'none' });
  expect(() => f.store.request({ type: 'world.tool', ...f.scope, sourceMessageId: self.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: self.content } })).toThrow('未开启主动联系');
  const message = source(f, '请去拜访 Bob。');
  expect(f.store.request({ type: 'world.tool', ...f.scope, sourceMessageId: message.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '按玩家实际委托拜访' } }).world!.visits).toHaveLength(1);
});

it('answers chat in place using a phone and resumes the paused walking route without reserving a computer', () => {
  const f = fixture(), home = f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.id === 'home_alice')!;
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: home.objects.find(object => object.kind === 'sofa')!.id } });
  advance(f.store, 600); const before = actor(f.store), message = source(f, '今天过得怎么样？');
  const work = f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'phone_chat', kind: 'chat', sourceMessageId: message.id }).worldWork!;
  if (work.status !== 'ready') advance(f.store, 1800);
  const ready = f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: work.workId }).worldWork!;
  expect(ready.status).toBe('ready'); expect(ready.computerId).toBeUndefined();
  const during = actor(f.store); expect(during.communication).toMatchObject({ channel: 'phone', phase: 'responding', recipientIds: ['user'] });
  expect(during.artAction).toBe('phoneTypingStanding'); expect(during.position).toEqual(before.position);
  advance(f.store, 3000); expect(actor(f.store).position).toEqual(during.position);
  expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).filter(object => object.kind === 'computer').every(computer => !computer.reservedBy)).toBe(true);
  f.store.request({ type: 'world.work.end', companionId: 'alice', workId: work.workId });
  advance(f.store, 5000); expect(actor(f.store).communication).toBeUndefined(); expect(actor(f.store).position).not.toEqual(during.position);
});

it('uses the seated phone while resting and wakes for verified urgency without travelling to a computer', () => {
  const f = fixture(), sofa = f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.id === 'home_alice')!.objects.find(object => object.kind === 'sofa')!;
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: sofa.id } }); advance(f.store, 10000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'interact', furnitureId: sofa.id, interaction: 'rest' } }); advance(f.store, 1500);
  const message = source(f, '休息时聊聊。'); expect(f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'rest_chat', kind: 'chat', sourceMessageId: message.id }).worldWork!.status).toBe('ready');
  expect(actor(f.store).artAction).toBe('phoneTypingSeated'); f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'rest_chat' });
  vi.setSystemTime('2026-10-15T23:30:00Z'); f.store.request({ type: 'world.tick' }); advance(f.store, 10000);
  const bedPosition = actor(f.store).position, ordinary = source(f, '普通事情明天说。');
  expect(f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'sleep_chat', kind: 'chat', sourceMessageId: ordinary.id }).worldWork!.status).toBe('waiting');
  const urgent = source(f, '紧急，请现在醒来帮我。'); recordUrgentAttention(f.store, 'alice', urgent);
  expect(f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'urgent_chat', kind: 'chat', sourceMessageId: urgent.id }).worldWork!.status).not.toBe('ready');
  advance(f.store, 3000); expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'urgent_chat' }).worldWork!.status).toBe('ready');
  expect(actor(f.store).position).toEqual(bedPosition); expect(actor(f.store).destinationId).not.toBe('alice_computer');
});

it('walks from the sofa and sits at the computer for an urgent phone request own action, while a distinct urgent message can still interrupt', () => {
  const f = fixture(), home = f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.id === 'home_alice')!;
  const sofa = home.objects.find(object => object.kind === 'sofa')!, computer = home.objects.find(object => object.kind === 'computer')!;
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: sofa.id } }); advance(f.store, 10000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'interact', furnitureId: sofa.id, interaction: 'rest' } }); advance(f.store, 1500);
  const original = source(f, '这件事紧急，请现在只读检查文件并告诉我真实结果。'); recordUrgentAttention(f.store, 'alice', original);
  expect(f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'task_chat', kind: 'chat', sourceMessageId: original.id }).worldWork!.status).toBe('ready');
  expect(actor(f.store).artAction).toBe('phoneTypingSeated'); const before = actor(f.store).position;
  const action = f.store.createAction({ ...f.scope, sourceMessageId: original.id, title: '真实只读检查', status: 'queued' }, { prompt: original.content, supplements: [], waitForActionIds: [] });
  f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'task_action', kind: 'action', sourceMessageId: original.id });
  const positions = new Set<string>(); let ready = false, walked = false;
  for (let index = 0; index < 100; index++) {
    const world = advance(f.store, 250), self = world.actors.find(actor => actor.companionId === 'alice')!;
    positions.add(JSON.stringify(self.position));
    if (self.activity === 'walking') { walked = true; expect(self.artAction).toBe('run'); expect(self.communication?.phase).not.toBe('responding'); }
    expect(world.works.find(work => work.workId === 'task_chat')!.status).toBe('waiting');
    if (world.works.find(work => work.workId === 'task_action')!.status === 'ready') { ready = true; break; }
  }
  expect(walked).toBe(true); expect(positions.size).toBeGreaterThan(3); expect(ready).toBe(true);
  expect(actor(f.store).position).not.toEqual(before); expect(actor(f.store).position).toEqual(computer.anchor);
  expect(actor(f.store)).toMatchObject({ activity: 'working', artAction: 'work', route: [] });
  expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).find(object => object.id === computer.id)!.reservedBy).toBe('alice');
  const urgent = source(f, '另有急事，现在先回我一句。'); recordUrgentAttention(f.store, 'alice', urgent);
  expect(f.store.request({ type: 'world.work.begin', ...f.scope, workId: 'new_urgent_chat', kind: 'chat', sourceMessageId: urgent.id }).worldWork!.status).toBe('ready');
  expect(actor(f.store)).toMatchObject({ activity: 'working', artAction: 'phoneTypingSeated', position: computer.anchor });
  f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'new_urgent_chat' });
  f.store.updateAction(action.id, { status: 'succeeded', result: '实际文件检查完成。' });
  f.store.request({ type: 'world.work.end', companionId: 'alice', workId: 'task_action' }); advance(f.store, 2000);
  expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: 'task_chat' }).worldWork!.status).toBe('ready');
});

it('upgrades an existing ordinary computer route to a verified urgent run without moving its path or skipping the seat', () => {
  const f = fixture(), home = f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.id === 'home_alice')!;
  const sofa = home.objects.find(object => object.kind === 'sofa')!, computer = home.objects.find(object => object.kind === 'computer')!;
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'move', destinationId: sofa.id } }); advance(f.store, 10000);
  f.store.request({ type: 'world.tool', ...f.scope, arguments: { action: 'interact', furnitureId: sofa.id, interaction: 'rest' } }); advance(f.store, 1500);
  const message = source(f, '现在有急事，请只读检查文件。');
  const action = f.store.createAction({ ...f.scope, sourceMessageId: message.id, title: '检查文件', status: 'queued' }, { prompt: message.content, supplements: [], waitForActionIds: [] });
  let ordinary = actor(f.store);
  for (let index = 0; index < 16 && ordinary.activity !== 'walking'; index++) { advance(f.store, 100); ordinary = actor(f.store); }
  expect(ordinary).toMatchObject({ activity: 'walking', locomotion: 'walk', movementSpeed: 2.4 });
  expect(ordinary.route.length).toBeGreaterThan(0); expect(ordinary.position).not.toEqual(computer.anchor);
  recordUrgentAttention(f.store, 'alice', message);
  const work = f.store.request({ type: 'world.work.begin', ...f.scope, sourceMessageId: message.id, workId: 'late_urgent_action', kind: 'action' }).worldWork!;
  const upgraded = actor(f.store);
  expect(work.status).toBe('moving'); expect(upgraded.position).toEqual(ordinary.position); expect(upgraded.route).toEqual(ordinary.route);
  expect(upgraded).toMatchObject({ activity: 'walking', locomotion: 'run', movementSpeed: 4.8, artAction: 'run' });
  const running = advance(f.store, 125).actors.find(actor => actor.companionId === 'alice')!;
  const distance = Math.hypot(running.position.x - upgraded.position.x, running.position.y - upgraded.position.y);
  expect(distance).toBeCloseTo(.6, 6);
  let seated = false, ready = false;
  for (let index = 0; index < 100; index++) {
    const world = advance(f.store, 125), self = world.actors.find(actor => actor.companionId === 'alice')!;
    if (self.activity === 'seating') seated = true;
    if (world.works.find(work => work.workId === 'late_urgent_action')?.status === 'ready') { ready = true; break; }
  }
  expect(seated).toBe(true); expect(ready).toBe(true); expect(actor(f.store)).toMatchObject({ activity: 'working', artAction: 'work', position: computer.anchor, route: [] });
  expect(f.store.getAction(action.id).status).toBe('queued'); // Physical readiness cannot fabricate task execution.
});

it('persists form publication, isolates ownership, holds focus until actual completion and binds one real action', () => {
  const f = fixture(), order = f.store.request({ type: 'work-order.create', ...f.scope, title: '核对清单', instruction: '只读取清单，不修改文件。', clientId: 'create_once' }).workOrder!;
  expect(order).toMatchObject({ publisherId: 'user', execution: 'external', status: 'accepted', revision: 1 });
  expect(f.store.getMessage(order.sourceMessageId).content).toContain('只读取清单');
  expect(f.store.request({ type: 'work-order.create', ...f.scope, title: order.title, instruction: order.instruction, clientId: 'create_once' }).workOrder!.id).toBe(order.id);
  const foreign = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id };
  expect(() => f.store.request({ type: 'work-order.cancel', ...foreign, id: order.id, expectedRevision: 1 })).toThrow('另一个');
  const claim = companionStorageResponseSchema.parse(f.store.request({ type: 'work-order.claim', companionId: 'alice' })).workOrderClaim!;
  advance(f.store, 10000); expect(actor(f.store).activity).toBe('working');
  expect(() => f.store.request({ type: 'work-order.complete', id: order.id, leaseToken: claim.leaseToken, result: '伪造完成' })).toThrow('实际行动');
  const input = { ...f.scope, workOrderId: order.id, sourceMessageId: order.sourceMessageId, title: order.title, status: 'running' as const };
  const action = f.store.createAction(input); expect(f.store.createAction(input).id).toBe(action.id);
  const running = f.store.request({ type: 'work-order.list', ...f.scope }).workOrderPage!.items[0]!;
  f.store.updateAction(action.id, { stage: '读取中' }); expect(f.store.request({ type: 'work-order.list', ...f.scope }).workOrderPage!.items[0]!.revision).toBe(running.revision);
  f.store.updateAction(action.id, { status: 'succeeded', result: '实际校验：3 项通过。' });
  expect(f.store.request({ type: 'work-order.complete', id: order.id, leaseToken: claim.leaseToken }).workOrder).toMatchObject({ status: 'completed', actionId: action.id, result: '实际校验：3 项通过。' });
  advance(f.store, 2500); expect(actor(f.store).activity).not.toBe('working');
  f.store.close(); stores.delete(f.store); const reopened = open(f.filename);
  expect(reopened.request({ type: 'work-order.list', ...f.scope, includeHistory: true }).workOrderPage!.items[0]).toMatchObject({ id: order.id, status: 'completed' });
});

it('keeps peer work internal, accepts explicitly, appends a real completion once and rejects withdrawn evidence', () => {
  const f = fixture(), room = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  const message = f.store.appendMessage({ conversationId: room.id, authorId: 'bob', content: '请帮我整理这段共同讨论的摘要。', replyDirective: 'none' });
  const scope = { companionId: 'alice', conversationId: room.id };
  const offer = f.store.request({ type: 'work-order.create', ...scope, sourceMessageId: message.id, title: '共同摘要', instruction: message.content }).workOrder!;
  expect(offer).toMatchObject({ execution: 'internal', publisherId: 'bob', status: 'offered' }); expect(f.store.request({ type: 'work-order.claim' }).workOrderClaim).toBeUndefined();
  expect(() => f.store.request({ type: 'work-order.update', ...f.scope, id: offer.id, expectedRevision: 1, patch: { instruction: '玩家改写伙伴要求' } })).toThrow('内部工作');
  f.store.request({ type: 'work-order.accept', ...scope, id: offer.id, expectedRevision: 1 });
  const claim = f.store.request({ type: 'work-order.claim' }).workOrderClaim!;
  expect(() => f.store.createAction({ ...scope, workOrderId: offer.id, sourceMessageId: message.id, title: '越权现实行动', status: 'queued' })).toThrow('现实执行权限');
  const request = { type: 'work-order.complete' as const, id: offer.id, leaseToken: claim.leaseToken, result: '依据共同讨论完成的摘要。' };
  const done = f.store.request(request); expect(done.message).toMatchObject({ authorId: 'alice', content: request.result });
  expect(f.store.request(request).workOrder!.completionMessageId).toBe(done.message!.id);
  const second = f.store.request({ type: 'work-order.create', ...scope, sourceMessageId: message.id, title: '另一项摘要', instruction: '整理同一来源' }).workOrder!;
  f.store.request({ type: 'work-order.accept', ...scope, id: second.id, expectedRevision: 1 }); const revoked = f.store.request({ type: 'work-order.claim' }).workOrderClaim!;
  f.store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [message.id] });
  expect(() => f.store.request({ type: 'work-order.complete', id: second.id, leaseToken: revoked.leaseToken, result: '不得复活秘密' })).toThrow('撤回');
});

it('recovers a durable unfinished claim, rejects stale leases and cancels paused action before resuming', () => {
  const f = fixture(), order = f.store.request({ type: 'work-order.create', ...f.scope, title: '恢复工作', instruction: '检查文件。' }).workOrder!;
  const first = f.store.request({ type: 'work-order.claim', leaseMs: 1000 }).workOrderClaim!;
  f.store.close(); stores.delete(f.store); vi.setSystemTime(Date.now() + 2000); const reopened = open(f.filename);
  const next = reopened.request({ type: 'work-order.claim' }).workOrderClaim!; expect(next.order.id).toBe(order.id); expect(next.leaseToken).not.toBe(first.leaseToken);
  expect(() => reopened.request({ type: 'work-order.fail', id: order.id, leaseToken: first.leaseToken, error: '迟到失败' })).toThrow('租约');
  const action = reopened.createAction({ ...f.scope, workOrderId: order.id, sourceMessageId: order.sourceMessageId, title: order.title, status: 'running' });
  const running = reopened.request({ type: 'work-order.list', ...f.scope }).workOrderPage!.items[0]!;
  const paused = reopened.request({ type: 'work-order.pause', ...f.scope, id: order.id, expectedRevision: running.revision, paused: true }).workOrder!;
  expect(() => reopened.request({ type: 'work-order.pause', ...f.scope, id: order.id, expectedRevision: paused.revision, paused: false })).toThrow('尚未停止');
  reopened.updateAction(action.id, { status: 'cancelled', error: '实际已停止' });
  const refreshed = reopened.request({ type: 'work-order.list', ...f.scope }).workOrderPage!.items[0]!;
  const resumed = reopened.request({ type: 'work-order.pause', ...f.scope, id: order.id, expectedRevision: refreshed.revision, paused: false }).workOrder!;
  expect(resumed.status).toBe('accepted'); expect(resumed.actionId).toBe(action.id); expect(reopened.request({ type: 'work-order.claim' }).workOrderClaim!.order.id).toBe(order.id);
});

it('resets work and life state in batches, blocks stale completion and preserves another assignee', async () => {
  const f = fixture(), bob = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id };
  const order = f.store.request({ type: 'work-order.create', ...f.scope, title: '要重置的工作', instruction: '检查。' }).workOrder!;
  const claim = f.store.request({ type: 'work-order.claim', companionId: 'alice' }).workOrderClaim!;
  const other = f.store.request({ type: 'work-order.create', ...bob, title: '保留的工作', instruction: 'Bob自己的检查。' }).workOrder!;
  const defaults = f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeRules!;
  f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: defaults[0]!.id, expectedRevision: defaults[0]!.revision });
  const lifeRequest = { type: 'life-rule.create' as const, companionId: 'alice', clientId: 'new_after_factory_reset', rule: { title: '可重置的生活事件', enabled: true, startMinute: 600, endMinute: 660, probability: .5, action: 'rest' as const } };
  const oldLife = f.store.request(lifeRequest).lifeRule!;
  const started = f.store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
  expect(() => f.store.request({ type: 'work-order.fail', id: order.id, leaseToken: claim.leaseToken, error: '重置中的迟到回包' })).toThrow('重置');
  f.store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: started.id });
  for (let index = 0; index < 1000 && f.store.request({ type: 'companion.reset.status', id: 'alice' }).reset!.status !== 'completed'; index++) await f.store.advanceReset();
  expect(f.store.request({ type: 'companion.reset.status', id: 'alice' }).reset!.status).toBe('completed');
  expect(() => f.store.request({ type: 'work-order.complete', id: order.id, leaseToken: claim.leaseToken, result: '不能复活' })).toThrow('不存在');
  expect(f.store.request({ type: 'work-order.list', ...f.scope, includeHistory: true }).workOrderPage!.items).toEqual([]);
  expect(companionStorageResponseSchema.parse(f.store.request({ type: 'work-order.list', ...bob })).workOrderPage!.items[0]!.id).toBe(other.id);
  expect(f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeRules).toHaveLength(2);
  expect(f.store.request(lifeRequest).lifeRule!.id).not.toBe(oldLife.id);
});

it('does not claim a deleted custom contact or revive its late leased execution', () => {
  const f = fixture(), companion = f.store.createCompanion({ name: '临时伙伴', description: '', persona: '临时', model: '', avatar: 'custom', proactive: false });
  const scope = { companionId: companion.id, conversationId: f.store.openPrivate(companion.id).id };
  const order = f.store.request({ type: 'work-order.create', ...scope, title: '临时工作', instruction: '检查。' }).workOrder!;
  const claim = f.store.request({ type: 'work-order.claim', companionId: companion.id }).workOrderClaim!;
  f.store.deleteCompanion(companion.id);
  expect(f.store.request({ type: 'work-order.claim' }).workOrderClaim).toBeUndefined();
  expect(() => f.store.request({ type: 'work-order.complete', id: order.id, leaseToken: claim.leaseToken, result: '迟到完成' })).toThrow();
});
