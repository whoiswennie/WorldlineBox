import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionActivityTaskService } from '../../src/main/companions/activity-task-service';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
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
  service = new CompanionActivityTaskService({ request: async input => input.type === 'memory.search'
    ? { ok: true, memoryPage: { items: [], hasMore: false } } : store.request(input),
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
  worldService = new CompanionWorldService({ request: async input => input.type === 'memory.search' ? { ok: true, memoryPage: { items: [], hasMore: false },
    memoryContext: { text: '', revision: store.request({ type: 'memory.snapshot', companionId: input.companionId, conversationId: input.conversationId,
      beforeSequence: input.beforeSequence }).memorySnapshot!.revision, profileKey: 'fixture-vcp-profile' } } : store.request(input), fetchFn,
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

it.each(['private', 'group', 'world', 'world-private-owned', 'private-own-revise', 'private-own-organize'] as const)(
  'reads a real owned material and records sourced personal understanding within the original %s domain', async domain => {
    let materialId = '', sourceId = '', quote = '', learnedId = '';
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(data.purpose).toBe('activity_task_step');
      if (data.task.step === 0) return response({ status: 'continue', action: null, wait: null,
        memory: { operation: 'read', id: materialId }, summary: '先实际阅读这一份本人可见资料，再决定是否形成认识。' });
      const read = data.task.history.find((item: { action: string }) => item.action === 'memory.read');
      expect(read).toBeDefined();
      expect(read.ok).toBe(true);
      const actualRead = JSON.parse(read.result);
      expect(actualRead.memories[0]).toMatchObject({ id: materialId, version: 1, sourceMessageIds: [sourceId] });
      expect(actualRead.sources[0]).toMatchObject({ id: sourceId, content: expect.stringContaining(quote) });
      const ownMutation = domain === 'private-own-revise' || domain === 'private-own-organize';
      if (ownMutation && data.task.step === 1) return response({ status: 'continue', action: null, wait: null,
        memory: domain === 'private-own-organize' ? { operation: 'organize', ids: [materialId], tags: ['学习资料', '已核对出处'] }
          : { operation: 'revise', id: materialId, expectedVersion: 1, candidate: { diaryName: '学习资料', content: '阅读方法：' + quote,
            tags: ['学习资料', '已核对出处'], sourceMessageIds: [sourceId], evidence: [{ sourceMessageId: sourceId, quote }] } }, summary: '按实际阅读结果整理这一份资料。' });
      if (data.task.step === 1 || ownMutation && data.task.step === 2) return response({ status: 'continue', action: null, wait: null,
        memory: { operation: 'record', candidate: { diaryName: '自我认识', content: '读过这份有来源的资料后，我更愿意保留观察背景和原始出处，再形成有条件的个人判断。',
          tags: ['资料学习', '原始出处', '个人认识'], sourceMessageIds: [sourceId], relatedMemoryIds: [materialId], evidence: [{ sourceMessageId: sourceId, quote }] } },
        summary: '根据实际读到的资料，记录可以追溯和撤回的个人理解。' });
      const written = data.task.history.find((item: { action: string }) => item.action === 'memory.record');
      expect(written.ok).toBe(true); learnedId = JSON.parse(written.result).memories[0].id;
      return response({ status: 'complete', action: null, wait: null, summary: '已读完这份资料，并保存有原始来源的个人认识。' });
    });
    const base = setup(fetchFn); store.request({ type: 'activity.cancel', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id });
    await service!.close();
    const scope = { companionId: 'alice', conversationId: domain === 'group' ? store.createConversation('本人的学习小组', ['alice']).id
      : domain.startsWith('world') ? 'world_alice' : base.conversationId };
    const materialScope = domain === 'world-private-owned' ? { companionId: 'alice', conversationId: base.conversationId } : scope;
    const source = domain === 'world' ? store.request({ type: 'memory.world_query', ...scope, category: 'observations', query: '', limit: 2 }).memorySources![0]!
      : store.appendMessage({ conversationId: materialScope.conversationId, authorId: 'user',
        content: domain === 'world-private-owned' ? 'PRIVATE_MATERIAL_DETAIL' : '读资料时保存原始出处，区分实际观察、作者解释和自己的推测，不把一次观察升级为普遍结论。', replyDirective: 'none' });
    sourceId = source.id; quote = source.content.slice(0, 180);
    materialId = store.request({ type: 'memory.record', ...materialScope, candidate: { diaryName: '学习资料', content: source.content, tags: ['学习资料', '阅读方法'],
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!.id;
    const calls: CompanionStorageCommand[] = [];
    service = new CompanionActivityTaskService({ request: async input => { calls.push(input); return input.type === 'memory.search'
      ? { ok: true, memoryPage: { items: [], hasMore: false } } : store.request(input); },
      configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
      profiles: async () => ({ publicProfiles: [], visualInputs: [] }), fetchFn, excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
    const goal = '阅读本人可见资料 ' + materialId + '；只有实际读到内容后才用逐字证据形成个人认识，保持原来源范围。';
    const taskSource = domain.startsWith('world') ? undefined : store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: goal, replyDirective: 'none' });
    const task = store.request({ type: 'activity.start', ...scope, clientId: 'learn_material_' + domain,
      ...(taskSource ? { sourceMessageId: taskSource.id } : {}), title: '阅读指定的本人资料', goal }).activityTask!;
    const get = () => store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
    for (let step = 0; step < 15 && !['succeeded', 'failed'].includes(get().status); step++) {
      await service.tick(); await new Promise(resolve => setImmediate(resolve));
      vi.setSystemTime(Date.now() + 2000); store.request({ type: 'world.tick' });
    }
    expect(get().status).toBe('succeeded');
    expect(calls.find(input => input.type === 'memory.read')).toMatchObject({ ...scope, id: materialId });
    expect(calls.filter(input => input.type === 'memory.record')).toHaveLength(1);
    const learned = store.request({ type: 'memory.read', ...scope, id: learnedId }).memoryRead!.memory;
    expect(learned).toMatchObject({ diaryName: '自我认识', sourceConversationId: materialScope.conversationId });
    expect(learned.sources.map(item => item.messageId)).toEqual([sourceId]);
    expect(get().history.filter(item => item.action.startsWith('memory.')).map(item => item.action)).toEqual(domain === 'private-own-revise'
      ? ['memory.read', 'memory.revise', 'memory.record'] : domain === 'private-own-organize' ? ['memory.read', 'memory.organize', 'memory.record'] : ['memory.read', 'memory.record']);
    store.request({ type: 'memory.forget', ...materialScope, sourceMessageIds: [sourceId] });
    expect(() => store.request({ type: 'memory.read', ...scope, id: learnedId })).toThrow();
    expect(store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!.history).toEqual([]);
  });

it.each(['revise', 'forget'] as const)('rejects stale learning after a previously read material is externally %s during the next model inference', async change => {
  let materialId = '', planning = false, resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetchFn: typeof fetch = async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.task.step === 0) return response({ status: 'continue', action: null, wait: null, memory: { operation: 'read', id: materialId }, summary: '读取指定的本人资料。' });
    expect(data.task.history[0]).toMatchObject({ action: 'memory.read', ok: true }); planning = true; return pending;
  };
  const base = setup(fetchFn); store.request({ type: 'activity.cancel', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id }); await service!.close();
  const scope = { companionId: base.companionId, conversationId: base.conversationId };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '这是需要保留出处的原始阅读资料。', replyDirective: 'none' });
  const sourceId = source.id, quote = source.content;
  const candidate = { diaryName: '学习资料', content: source.content, tags: ['学习资料'], sourceMessageIds: [sourceId], evidence: [{ sourceMessageId: sourceId, quote }] };
  materialId = store.request({ type: 'memory.record', ...scope, candidate }).memories![0]!.id;
  const calls: CompanionStorageCommand[] = [];
  service = new CompanionActivityTaskService({ request: async input => { calls.push(input); return input.type === 'memory.search'
    ? { ok: true, memoryPage: { items: [], hasMore: false } } : store.request(input); },
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), fetchFn, excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  const request = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '阅读这份资料并形成有来源的个人认识。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: request.id, clientId: 'stale_learning_' + change,
    title: '阅读指定资料', goal: request.content + materialId }).activityTask!;
  for (let step = 0; step < 8 && !planning; step++) { await service.tick(); await new Promise(done => setImmediate(done));
    vi.setSystemTime(Date.now() + 2000); store.request({ type: 'world.tick' }); }
  expect(planning).toBe(true);
  if (change === 'forget') store.request({ type: 'memory.forget', ...scope, id: materialId });
  else store.request({ type: 'memory.revise', ...scope, id: materialId, expectedVersion: 1, candidate: { ...candidate, content: '管理员修订了资料解释，但保留同一份原始出处。' } });
  resolve(response({ status: 'continue', action: null, wait: null, summary: '这是基于旧资料版本的晚到认识。',
    memory: { operation: 'record', candidate: { ...candidate, diaryName: '自我认识', content: '不应落盘的旧版认识', relatedMemoryIds: [materialId] } } }));
  await vi.waitFor(() => expect(calls.some(command => command.type === 'activity.fail')).toBe(true));
  // A rejected in-flight lease is reclaimed by the durable scheduler, without publishing its old result.
  vi.setSystemTime(Date.now() + 122000); store.request({ type: 'world.tick' }); await service.tick();
  expect(calls.some(command => command.type === 'memory.record')).toBe(false);
  const stopped = store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
  expect(stopped).toMatchObject({ status: 'cancelled', history: [] });
  expect(store.request({ type: 'memory.browse', ...scope }).memoryPage!.items.some(hit => hit.memory.content === '不应落盘的旧版认识')).toBe(false);
});
