import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionActivityTaskService } from '../../src/main/companions/activity-task-service';
const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', persona: '尊重实际结果', description: '', model: '', avatar: 'sister', active: true, proactive: true }];
let worldService: CompanionWorldService | undefined;
let root: string, store: CompanionsStore, service: CompanionActivityTaskService | undefined;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-16T10:00:00Z'); root = mkdtempSync(path.join(tmpdir(), 'companion-agent-service-')); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds.map(seed => ({ ...seed, active: true }))); });
afterEach(async () => { await service?.close(); service = undefined; await worldService?.close(); worldService = undefined; store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-agent-service-')) throw new Error('Invalid cleanup'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function setup(fetchFn: typeof fetch) {
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const world = store.request({ type: 'world.snapshot' }).world!; store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '去自己的沙发坐一会儿，完成后告诉我。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id, clientId: 'independent_goal', title: '坐到沙发', goal: source.content }).activityTask!;
  service = new CompanionActivityTaskService({ request: async input => store.request(input),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake-local-key', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), fetchFn, excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  return { ...scope, task };
}
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
it.each([{ initiallyQueued: true, offline: false }, { initiallyQueued: false, offline: false }, { initiallyQueued: true, offline: true }])('continues a visit through a real reply, permission, exit travel and actual arrival, %j', async ({ initiallyQueued, offline }) => {
  vi.setSystemTime('2026-10-16T13:40:00Z');
  let targetId = ''; const purposes: string[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    purposes.push(data.purpose);
    if (data.purpose === 'world_decision') {
      const pending = data.world.visits.find((visit: { hostId: string; status: string }) => visit.hostId === data.companion.id && visit.status === 'requested');
      return response({ action: pending ? { action: 'respond', requestId: pending.id, decision: 'allow', reason: '有空，欢迎来玩。' } : null, reason: '按实际请求回应。', appraisals: [] });
    }
    if (data.purpose === 'world_social') return response({ text: data.identity.self.id === targetId ? '我有空，欢迎来一起看书。' : null, reason: '依据真实来信回应。' });
    if (data.purpose === 'world_social_notification') return response({ text: null, eventId: data.confirmedEvent.eventId, initiatorId: 'user' });
    if (data.purpose === 'visit_peer_speech') {
      expect(JSON.stringify(data)).not.toMatch(/PRIVATE_PLAYER_SECRET|PRIVATE_UNSENT_PLAYER_DRAFT/);
      return response({ text: data.channel === 'face_to_face' ? '我到了，很高兴见到你。' : '想来找你玩，现在方便吗？' });
    }
    if (data.purpose === 'world_message_authorization') return response({ allowed: true, intent: 'visit', confidence: .99, evidence: [data.source.content], reason: '原委托明确要求本人拜访。' });
    expect(data.purpose).toBe('activity_task_step');
    if (data.task.step > 0) expect(data.task.visitTargetId).toBe(targetId);
    if (data.task.step === 0) return response({ status: 'continue', action: { action: 'message', recipientIds: [targetId], text: '我想去找你玩，现在方便吗？' },
      wait: { kind: 'reply', targetCompanionId: targetId }, summary: '先发一条必要问候，再继续原拜访目标。' });
    if (!data.recentPeerMessages.some((message: { authorId: string }) => message.authorId === targetId))
      return response({ status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: targetId }, summary: '已留言，等待真实回复。' });
    const visit = data.world.visits.find((visit: { guestId: string; hostId: string }) => visit.guestId === 'alice' && visit.hostId === targetId);
    if (!visit) return response({ status: 'continue', action: { action: 'visit', targetCompanionId: targetId, reason: '我想来找你玩，现在方便吗？' },
      wait: { kind: 'permission', targetCompanionId: targetId }, summary: '根据实际回信申请拜访许可。' });
    if (data.task.visitInteractionAt) return response({ status: 'complete', action: null, wait: null, summary: '我到了Bob的小屋，已经和她当面打招呼、收到回应。' });
    if (data.task.visitArrivedAt) {
      const self = data.world.actors.find((actor: { companionId: string }) => actor.companionId === 'alice');
      const host = data.world.perception.people.find((person: { companionId: string; visible: boolean }) => person.companionId === targetId && person.visible);
      if (!host || Math.hypot(self.position.x - host.position.x, self.position.y - host.position.y) > 4) return response({ status: 'continue', action: { action: 'move', position: host ? { x: host.position.x + 1, y: host.position.y + 1 } : { x: self.position.x, y: Math.max(8, self.position.y - 3) } }, wait: { kind: 'arrival' }, summary: '根据本地感知探索并走近房主。' });
      if (!data.task.history.some((item: { action: string; ok: boolean }) => item.action === 'social' && item.ok)) return response({ status: 'continue', action: { action: 'social', targetCompanionId: targetId, kind: 'greet', text: 'PRIVATE_UNSENT_PLAYER_DRAFT' }, wait: { kind: 'reply', targetCompanionId: targetId }, summary: '当面打招呼并等待真实回应。' });
      return response({ status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: targetId }, summary: '等待面对面回应。' });
    }
    expect(visit.status).toBe('allowed');
    return response({ status: 'continue', action: { action: 'travel', targetSceneId: visit.destination.sceneId, entryId: visit.destination.entryId }, wait: { kind: 'arrival' }, summary: '从自己的出口前往获准的场景入口。' });
  });
  const base = setup(fetchFn); store.request({ type: 'activity.cancel', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id });
  const target = store.createCompanion({ name: 'Bob', description: '', persona: '友好且如实回应', model: '', avatar: 'sister', proactive: false });
  targetId = target.id; store.setCompanionActive(targetId, true);
  const host = { companionId: targetId, conversationId: store.openPrivate(targetId).id }, routine = store.request({ type: 'routine.get', ...host }).routine!;
  store.request({ type: 'routine.configure', ...host, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const scope = { companionId: base.companionId, conversationId: base.conversationId };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '去找Bob玩吧。PRIVATE_PLAYER_SECRET', replyDirective: 'none' });
  const task = initiallyQueued ? store.request({ type: 'activity.visit.ensure', ...scope, sourceMessageId: source.id, targetId,
    initialMessage: { text: '我想去找你玩，现在方便吗？', clientId: 'agent_visit_first_message' } }).activityTask!
    : store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id, clientId: 'explicit_visit_agent', title: '拜访Bob', goal: source.content }).activityTask!;
  const get = () => store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); };
  for (const person of [scope, host]) {
    const routine = store.request({ type: 'routine.get', ...person }).routine!;
    store.request({ type: 'routine.configure', ...person, expectedRevision: routine.revision, patch: { habits: [{ id: 'soft_rest', title: '午后休息', kind: 'rest', at: '13:30', durationMinutes: 25 }] } });
  }
  advance(30000);
  expect(store.request({ type: 'world.snapshot' }).world!.actors.every(actor => actor.routinePhase === 'resting')).toBe(true);
  if (offline) {
    const running = store.request({ type: 'activity.claim' }).activityTask!;
    store.request({ type: 'activity.commit', id: running.id, leaseToken: running.leaseToken!, decision: { status: 'continue',
      action: { action: 'visit', targetCompanionId: targetId, reason: '有空时想来找你玩。' }, wait: { kind: 'permission', targetCompanionId: targetId }, summary: '等待正式许可' } });
    store.close(); vi.setSystemTime(Date.now() + 3 * 3600000);
    store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds.map(seed => ({ ...seed, active: true })));
    store.request({ type: 'activity.recover' });
    expect(Date.parse(task.deadline)).toBeLessThan(Date.now());
    await service!.tick(); expect(fetchFn).not.toHaveBeenCalled();
    expect(get()).toMatchObject({ status: 'waiting', step: 2 });
  }
  vi.useFakeTimers();
  worldService = new CompanionWorldService({ request: async input => store.request(input), fetchFn,
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }), changed: vi.fn(), wakeWaiting: vi.fn(), report: error => { throw error; } });
  for (let iteration = 0; iteration < 150 && get().status !== 'succeeded'; iteration++) {
    await worldService.tick(); await service!.tick();
    await vi.advanceTimersByTimeAsync(1600); store.request({ type: 'world.tick' });
  }
  expect(get(), JSON.stringify(get())).toMatchObject({ status: 'succeeded', visitTargetId: targetId });
  expect(store.request({ type: 'world.observe', ...scope }).world!.actors[0]!.sceneId).toBe('home_' + targetId);
  expect(get().visitArrivedAt).toBeDefined(); expect(get().visitInteractionAt).toBeDefined();
  expect(get().stage).toContain('双方当面交流'); expect(get().stage).not.toMatch(/茶|烧水|看书/);
  expect(purposes.filter(purpose => purpose === 'world_message_authorization').length).toBe(initiallyQueued ? 0 : 1);
  expect(purposes).toContain('world_decision'); expect(purposes).toContain('world_social');
  const room = store.request({ type: 'social.conversations', companionId: scope.companionId }).socialConversationPage!.items[0]!;
  const exchanged = store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.items;
  expect(JSON.stringify(exchanged)).not.toMatch(/PRIVATE_PLAYER_SECRET|PRIVATE_UNSENT_PLAYER_DRAFT/);
  expect(['alice', targetId].every(id => exchanged.some(item => item.channel === 'face_to_face' && item.message.authorId === id))).toBe(true);
  expect(store.request({ type: 'activity.list', ...scope }).activityTasks?.filter(task => task.sourceMessageId === source.id)).toHaveLength(1);
  expect(store.messages({ conversationId: scope.conversationId }).messages.filter(message => message.content === source.content)).toHaveLength(1);
});
it('rejects an out-of-scope draft without sending it or ending the goal, then lets the planner correct its next action', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'world_message_authorization') return response({ allowed: false, intent: 'message', confidence: .99, evidence: [data.source.content], reason: '原请求只要求自己去沙发坐一会儿。' });
    expect(data.purpose).toBe('activity_task_step');
    if (data.task.step === 0) return response({ status: 'continue', action: { action: 'message', recipientIds: ['unrelated'], text: 'PRIVATE_UNSENT' }, wait: null, summary: '错误的额外联系' });
    expect(data.task.history[0]).toMatchObject({ action: 'message', ok: false });
    expect(data.task.history[0].result).toContain('原任务仍保留');
    if (data.task.step === 1) return response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '回到原本的移动目标' });
    return response({ status: 'complete', action: null, wait: null, summary: '已走到自己的沙发旁。' });
  });
  const scope = setup(fetchFn), get = () => store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(1));
  expect(get().status).toBe('queued');
  vi.setSystemTime(Date.now() + 2000); await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(2));
  vi.setSystemTime(Date.now() + 20000); store.request({ type: 'world.tick' }); await service!.tick();
  await vi.waitFor(() => expect(get().status).toBe('succeeded'));
  expect(store.request({ type: 'social.conversations', companionId: scope.companionId }).socialConversationPage!.items).toHaveLength(0);
});
it('runs a native model planning loop, sleeps without model polling, then continues and reports without any new player message', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.purpose).toBe('activity_task_step'); expect(data.originalRequest.authorId).toBe('user');
    if (data.task.step === 0) return response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '先走到沙发' });
    if (data.task.step === 1) { expect(data.world.actors[0].route).toEqual([]); return response({ status: 'continue', action: { action: 'interact', furnitureId: 'alice_sofa', interaction: 'sit' }, wait: { kind: 'delay', seconds: 2 }, summary: '实际坐一会儿' }); }
    return response({ status: 'complete', action: null, wait: null, summary: '已经走到沙发并坐下休息了。' });
  });
  const scope = setup(fetchFn), get = () => store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await service!.tick(); await vi.waitFor(() => expect(get().status).toBe('waiting'));
  for (let tick = 0; tick < 20; tick++) await service!.tick(); expect(fetchFn).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 20000); store.request({ type: 'world.tick' });
  await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(2)); expect(get().status).toBe('waiting');
  vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' }); await service!.tick();
  await vi.waitFor(() => expect(get().status).toBe('succeeded')); expect(fetchFn).toHaveBeenCalledTimes(3);
  const messages = store.request({ type: 'messages', conversationId: scope.conversationId, limit: 30 }).messages!;
  expect(messages.filter(message => message.content.includes('已经走到沙发并坐下'))).toHaveLength(1);
  expect(messages.filter(message => message.content === '去自己的沙发坐一会儿，完成后告诉我。')).toHaveLength(1);
});
it('rejects an in-flight result after cancellation, rather than dispatching its late movement', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetchFn = vi.fn<typeof fetch>(() => pending), scope = setup(fetchFn);
  await service!.tick(); await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  store.request({ type: 'activity.cancel', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }); service!.cancel(scope.task.id);
  resolve(response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '旧规划' }));
  await service!.close();
  expect(store.request({ type: 'world.observe', companionId: scope.companionId, conversationId: scope.conversationId }).world!.actors[0]!.route).toHaveLength(0);
  expect(store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!.status).toBe('cancelled');
});
