import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import type { CompanionActivityTask, ActivityDecision } from '../../src/shared/companion-activity-task';
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '友好且尊重边界', description: '', model: '', avatar: 'sister', proactive: true }));
const Database = BetterSqlite3 as {
    new (filename: string): CompanionConnection;
};
let root: string, filename: string, store: CompanionsStore;
let alice: {
    companionId: string;
    conversationId: string;
}, bob: typeof alice;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-10-16T10:00:00Z');
    root = mkdtempSync(path.join(tmpdir(), 'companion-activity-'));
    filename = path.join(root, 'state.sqlite');
    store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
    alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
    bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    for (const scope of [alice, bob]) {
        const routine = store.request({ type: 'routine.get', ...scope }).routine!;
        store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', meals: [], habits: [], sleepAt: '23:00', wakeAt: '07:00' } });
    }
});
afterEach(() => { store?.close(); const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-activity-'))
    throw new Error('Invalid cleanup'); rmSync(resolved, { recursive: true, force: true }); vi.useRealTimers(); });
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function start(clientId = 'goal_one') {
    const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '去联系bob，获得邀请后通过入口到她家做客。', replyDirective: 'none' });
    const input = { type: 'activity.start', ...alice, clientId, sourceMessageId: source.id, title: '去bob家做客', goal: source.content } as const;
    return { input, task: store.request(input).activityTask!, source };
}
function claim() { return store.request({ type: 'activity.claim' }).activityTask; }
function commit(task: CompanionActivityTask, decision: ActivityDecision) { return store.request({ type: 'activity.commit', id: task.id, leaseToken: task.leaseToken!, decision }).activityTask!; }
function shareAddress() {
    store.request({ type: 'world.tool', ...bob, arguments: { action: 'share_entrance', recipientIds: ['alice'] } });
    store.request({ type: 'social.job.claim' });
    advance(1600);
    const delivery = store.request({ type: 'social.job.claim' });
    if (delivery.socialJob) {
        advance(1600);
        store.request({ type: 'social.job.complete', id: delivery.socialJob.id, leaseToken: delivery.socialJob.leaseToken!, text: null });
    }
    advance(6000);
}
function invite() {
    const request = store.request({ type: 'world.tool', ...alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '想来坐坐，方便吗？' } }).world!.visits.find(item => item.guestId === 'alice')!;
    store.request({ type: 'world.tool', ...bob, arguments: { action: 'respond', requestId: request.id, decision: 'allow', reason: '欢迎来玩。' } });
    return request;
}
it('continues a chat-issued weather check after physical arrival, coalesces repeat moves and survives restart', () => {
    store.request({ type: 'world.tool', ...alice, arguments: { action: 'move', destinationId: 'alice_computer' } });
    advance(15000);
    const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '现在外面的天气怎样？请去门口看一眼再告诉我。', replyDirective: 'none' });
    const input = { type: 'activity.motion.ensure' as const, ...alice, sourceMessageId: source.id, arguments: { action: 'move' as const, destinationId: 'alice_door' } };
    const first = store.request(input);
    expect(first.activityTask).toMatchObject({ status: 'waiting', step: 1, goal: source.content, wait: { kind: 'arrival' } });
    expect(first.world!.actors.find(actor => actor.companionId === 'alice')!.route.length).toBeGreaterThan(0);
    advance(2000);
    const beforeRetry = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!;
    const retry = store.request(input);
    expect(retry.activityTask!.id).toBe(first.activityTask!.id);
    expect(retry.world!.actors.find(actor => actor.companionId === 'alice')!.position).toEqual(beforeRetry.position);
    expect(retry.activityTask!.history).toHaveLength(1);
    store.close();
    store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
    store.request({ type: 'activity.recover' });
    advance(20000);
    const resumed = claim()!;
    expect(resumed.id).toBe(first.activityTask!.id);
    const observed = store.request({ type: 'activity.observe', id: resumed.id, leaseToken: resumed.leaseToken! }).world!;
    const authoritative = store.request({ type: 'world.snapshot' }).world!;
    expect(observed.perception!.position).toEqual({ x: 10, y: 15 });
    expect(observed.perception!.environment.weather).toBe(authoritative.environment.weather);
    expect(observed.perception!.environment.weatherObservedAtVirtual).toBe(observed.perception!.observedAtVirtual);
    const summary = '已到门口实际查看，当前天气为 ' + authoritative.environment.weather + '。';
    expect(commit(resumed, { status: 'complete', action: null, wait: null, summary }).status).toBe('succeeded');
    expect(store.request({ type: 'state.get', ...alice }).runtimeState?.familiarity.sharedEventCount).toBe(1);
    const reports = store.messages({ conversationId: alice.conversationId }).messages.filter(message => message.replyToId === source.id && message.content.includes(summary));
    expect(reports).toHaveLength(1);
    expect(store.request(input).activityTask!.status).toBe('succeeded');
    expect(store.messages({ conversationId: alice.conversationId }).messages.filter(message => message.content.includes(summary))).toHaveLength(1);
    expect(store.request({ type: 'state.get', ...alice }).runtimeState?.familiarity.sharedEventCount).toBe(1);
    store.request({ type: 'memory.forget', ...alice, sourceMessageIds: [source.id] });
    expect(store.request({ type: 'state.get', ...alice }).runtimeState?.familiarity.sharedEventCount).toBe(0);
});
it('does not create a continuation or send stale feedback after its source is withdrawn', () => {
    const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '去门口看看天气再回我。', replyDirective: 'none' });
    const input = { type: 'activity.motion.ensure' as const, ...alice, sourceMessageId: source.id, arguments: { action: 'move' as const, destinationId: 'alice_door' } };
    const task = store.request(input).activityTask!;
    store.request({ type: 'memory.forget', ...alice, sourceMessageIds: [source.id] });
    advance(15000);
    expect(claim()).toBeUndefined();
    expect(store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask!.status).toBe('cancelled');
    expect(() => store.request(input)).toThrow();
    expect(store.messages({ conversationId: alice.conversationId }).messages.some(message => message.authorId === 'alice' && message.replyToId === source.id)).toBe(false);
});
it('atomically retains a visit goal behind a first phone message, coalesces retries and refuses completion before real arrival', () => {
    const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '去找bob玩吧。', replyDirective: 'none' });
    const input = { type: 'activity.visit.ensure' as const, ...alice, sourceMessageId: source.id, targetId: 'bob',
        initialMessage: { text: '想过去找你玩，现在方便吗？', clientId: 'initial_visit_phone' } };
    const first = store.request(input);
    expect(first.socialPending).toBe(true);
    expect(first.activityTask).toMatchObject({ visitTargetId: 'bob', targetId: 'bob', status: 'queued', step: 1 });
    expect(store.request(input).activityTask!.id).toBe(first.activityTask!.id);
    expect(store.request({ ...input, initialMessage: { ...input.initialMessage, clientId: 'another_native_call' } }).activityTask!.id).toBe(first.activityTask!.id);
    expect(store.request({ type: 'activity.start', ...alice, sourceMessageId: source.id, clientId: 'model_also_started', title: '去找bob', goal: '去找bob玩' }).activityTask!.id).toBe(first.activityTask!.id);
    expect(store.request({ type: 'activity.list', ...alice }).activityTasks).toHaveLength(1);
    advance(1600);
    const refused = commit(claim()!, { status: 'complete', action: null, wait: null, summary: '已经发消息，拜访完成。' });
    expect(refused.status).toBe('queued');
    expect(refused.stage).toContain('尚未实际抵达');
    expect(store.messages({ conversationId: alice.conversationId }).messages.some(message => message.content.includes('拜访完成'))).toBe(false);
    invite();
    advance(1600);
    const moving = commit(claim()!, { status: 'continue', action: { action: 'travel', targetSceneId: 'home_bob' }, wait: null, summary: '按有效许可出发' });
    expect(moving.status).toBe('waiting');
    const self = advance(40000).actors.find(actor => actor.companionId === 'alice')!;
    expect(self.sceneId).toBe('home_bob');
    expect(self.route).toHaveLength(0);
    const arrived = claim()!, observation = store.request({ type: 'activity.observe', id: arrived.id, leaseToken: arrived.leaseToken! });
    expect(observation.activityTask!.visitArrivedAt).toBeDefined();
    expect(commit(arrived, { status: 'complete', action: null, wait: null, summary: '实际抵达bob的小屋了。' }).status).toBe('queued');
});
it('keeps a dormant recipient unloaded while retaining one persistent visit goal and queued contact', () => {
    store.setCompanionActive('bob', false);
    const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '去找bob玩吧。', replyDirective: 'none' });
    const ensured = store.request({ type: 'activity.visit.ensure', ...alice, sourceMessageId: source.id, targetId: 'bob',
        initialMessage: { text: '方便时回我吧，想找你玩。', clientId: 'dormant_visit_phone' } });
    expect(ensured.activityTask?.status).toBe('queued');
    expect(ensured.socialPending).toBe(true);
    const world = advance(10000);
    expect(world.actors.some(actor => actor.companionId === 'bob')).toBe(false);
    expect(world.scenes.some(scene => scene.ownerId === 'bob')).toBe(false);
});
it('retains a pending permission across hours offline and resumes the same visit when the host really allows it', () => {
    const { source } = start();
    const task = store.request({ type: 'activity.visit.ensure', ...alice, sourceMessageId: source.id, targetId: 'bob' }).activityTask!;
    commit(claim()!, { status: 'continue', action: { action: 'visit', targetCompanionId: 'bob', reason: '有空时想来坐坐。' }, wait: { kind: 'permission', targetCompanionId: 'bob' }, summary: '等待真实许可' });
    store.close();
    vi.setSystemTime(Date.now() + 3 * 3600000);
    store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
    store.request({ type: 'activity.recover' });
    advance(10000);
    for (let poll = 0; poll < 20; poll++) {
        advance(2000);
        expect(claim()).toBeUndefined();
    }
    expect(store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask).toMatchObject({ status: 'waiting', step: 1, attempts: 0 });
    invite();
    advance(1600);
    const resumed = claim()!;
    expect(resumed.id).toBe(task.id);
    expect(resumed.stage).toContain('许可已有实际结果');
    commit(resumed, { status: 'continue', action: { action: 'travel', targetSceneId: 'home_bob' }, wait: { kind: 'arrival' }, summary: '按有效邀请出发' });
    expect(advance(40000).actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('home_bob');
});
it.each(['allow', 'deny'] as const)('wakes a phone-reply wait on the exact formal visit result (%s) without a redundant phone confirmation', decision => {
    const { source } = start();
    store.request({ type: 'activity.visit.ensure', ...alice, sourceMessageId: source.id, targetId: 'bob' });
    const waiting = commit(claim()!, { status: 'continue', action: { action: 'visit', targetCompanionId: 'bob', reason: '想来坐坐。' }, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '等待房主' });
    const visit = store.request({ type: 'world.snapshot' }).world!.visits.find(item => item.id === waiting.visitRequestId)!;
    advance(1600);
    expect(claim()).toBeUndefined();
    store.request({ type: 'world.tool', ...bob, arguments: { action: 'respond', requestId: visit.id, decision, reason: decision === 'allow' ? '欢迎。' : '今天不方便。' } });
    advance(1600);
    const resumed = claim()!;
    expect(resumed.id).toBe(waiting.id);
    expect(resumed.stage).toContain('不再等待重复');
    const observation = store.request({ type: 'activity.observe', id: resumed.id, leaseToken: resumed.leaseToken! });
    expect(observation.world!.visits.find(item => item.id === visit.id)!.status).toBe(decision === 'allow' ? 'allowed' : 'denied');
    expect(observation.activityMessages).toHaveLength(0);
});
it('waits for a dormant peer without model polling, consuming steps, loading its scene, or expiring the goal', () => {
    const { task } = start();
    store.setCompanionActive('bob', false);
    commit(claim()!, { status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '等待玩家激活对方后再联系。' });
    advance(3 * 3600000);
    expect(claim()).toBeUndefined();
    expect(store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask).toMatchObject({ status: 'waiting', step: 1 });
    const world = store.request({ type: 'world.snapshot' }).world!;
    expect(world.actors.some(actor => actor.companionId === 'bob')).toBe(false);
    expect(world.scenes.some(scene => scene.ownerId === 'bob')).toBe(false);
});
it.each(['legacy', 'contact_reclassification', 'cancelled', 'real_failure', 'step_limit', 'old', 'withdrawn'] as const)('repairs only the recent erroneous scheduler failure (%s) and keeps result IDs distinct', kind => {
    const { task, source } = start();
    store.request({ type: 'activity.visit.ensure', ...alice, sourceMessageId: source.id, targetId: 'bob' });
    const legacy = '行动达到一小时或32步安全上限，已停止；已发生的行为保留。';
    const oldReport = store.appendMessage({ conversationId: alice.conversationId, authorId: 'alice', content: '拜访bob · 暂时受阻\n\n' + legacy, clientId: 'activity_result_' + task.id, replyDirective: 'none' });
    if (kind === 'withdrawn')
        store.request({ type: 'memory.forget', ...alice, sourceMessageIds: [source.id] });
    store.close();
    const db = new Database(filename);
    try {
        const row = db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(task.id) as {
            data: string;
        }, data = JSON.parse(row.data);
        Object.assign(data, { status: kind === 'cancelled' ? 'cancelled' : 'failed', stage: kind === 'real_failure' ? '房主拒绝了拜访。' : kind === 'contact_reclassification' ? '拟发内容或收件人超出了原委托的分享范围，已停止发送。' : legacy,
            step: kind === 'step_limit' ? 32 : 4, ...(kind === 'old' ? { createdAt: '2026-10-14T10:00:00.000Z' } : {}) });
        db.prepare('UPDATE companion_activity_tasks SET status=?,data=? WHERE id=?').run(data.status, JSON.stringify(data), task.id);
    }
    finally {
        db.close();
    }
    vi.setSystemTime(Date.now() + 3 * 3600000);
    store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
    store.request({ type: 'activity.recover' });
    store.request({ type: 'activity.recover' });
    const repaired = store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask!;
    expect(repaired.status).toBe(['legacy', 'contact_reclassification'].includes(kind) ? 'queued' : kind === 'cancelled' ? 'cancelled' : 'failed');
    if (['legacy', 'contact_reclassification'].includes(kind)) {
        advance(10000);
        commit(claim()!, { status: 'blocked', action: null, wait: null, summary: '重新核对后尚未获准，没有进入对方小屋。' });
        const messages = store.messages({ conversationId: alice.conversationId }).messages;
        expect(messages.filter(message => message.id === oldReport.id)).toHaveLength(1);
        expect(messages.filter(message => message.content.includes('重新核对后尚未获准'))).toHaveLength(1);
    }
});
it('keeps entrance knowledge separate from invitation and requires local exit traversal', () => {
    const own = store.request({ type: 'world.observe', ...alice }).world!;
    expect(own.knownAddresses?.map(address => address.companionId)).toEqual(['alice']);
    expect(own.residents.find(role => role.companionId === 'bob')).not.toHaveProperty('homeSceneId');
    expect(() => store.request({ type: 'world.tool', ...alice, arguments: { action: 'travel', targetSceneId: 'home_bob' } })).toThrow('邀请');
    expect(() => store.request({ type: 'world.tool', ...alice, arguments: { action: 'move', destinationId: 'home_bob' } })).toThrow('当前场景');
    invite();
    advance(4000);
    expect(store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.sceneId).toBe('home_alice');
    expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(1);
    shareAddress();
    expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(1);
    const leaving = store.request({ type: 'world.tool', ...alice, arguments: { action: 'travel', targetSceneId: 'home_bob' } }).world!.actors[0]!;
    expect(leaving.sceneId).toBe('home_alice');
    expect(leaving.travel?.targetSceneId).toBe('home_bob');
    expect(leaving.route.every(point => point.sceneId === 'home_alice')).toBe(true);
    expect(advance(15000).actors.find(actor => actor.companionId === 'alice')!.sceneId).toBe('home_bob');
});
it('resumes a goal from real arrival across restart, keeps UUID and effects idempotent, then reports without another user message', () => {
    shareAddress();
    invite();
    const { input, task } = start();
    expect(store.request(input).activityTask!.id).toBe(task.id);
    const leased = claim()!;
    const waiting = commit(leased, { status: 'continue', action: { action: 'travel', targetSceneId: 'home_' + 'bob' }, wait: null, summary: '前往门口' });
    expect(waiting.status).toBe('waiting');
    expect(waiting.step).toBe(1);
    expect(() => commit(leased, { status: 'complete', action: null, wait: null, summary: '重复回执' })).toThrow('租约');
    advance(100);
    expect(claim()).toBeUndefined();
    const before = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.position;
    store.close();
    store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true })));
    store.request({ type: 'activity.recover' });
    expect(store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.position).toEqual(before);
    advance(40000);
    const resumed = claim()!;
    expect(resumed.id).toBe(task.id);
    expect(resumed.stage).toContain('抵达');
    const done = commit(resumed, { status: 'complete', action: null, wait: null, summary: '已通过有效邀请抵达bob的小屋。' });
    expect(done.status).toBe('succeeded');
    const messages = store.request({ type: 'messages', conversationId: alice.conversationId, limit: 50 }).messages!;
    expect(messages.filter(message => message.authorId === 'alice' && message.content.includes('已完成'))).toHaveLength(1);
    expect(messages.filter(message => message.authorId === 'user' && message.content === input.goal)).toHaveLength(1);
});
it('waits on genuine peer replies, internalizes a shared entrance explicitly, and revokes it on forgetting', () => {
    const { task } = start();
    const running = claim()!;
    commit(running, { status: 'continue', action: { action: 'message', recipientIds: ['bob'], text: '想去你家坐坐，可以分享地址吗？' }, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '询问地址' });
    advance(1600);
    expect(claim()).toBeUndefined();
    const delivery = store.request({ type: 'social.job.claim' });
    advance(1600);
    const job = delivery.socialJob ?? store.request({ type: 'social.job.claim' }).socialJob!;
    expect(job.companionId).toBe('bob');
    expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(1);
    advance(1600);
    const sent = store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '可以，给你地址。', shareAddress: true }).socialMessage!;
    expect(sent.message.content).toContain('home_bob');
    advance(1600);
    const next = claim()!;
    expect(next.id).toBe(task.id);
    const context = store.request({ type: 'activity.observe', id: next.id, leaseToken: next.leaseToken! });
    expect(context.activityMessages?.some(message => message.id === sent.message.id)).toBe(true);
    expect(context.world!.knownAddresses).toHaveLength(1);
    const query = store.request({ type: 'memory.world_query', ...alice, category: 'social', roomId: sent.message.conversationId });
    expect(query.worldKnowledge!.items.find(item => item.messageId === sent.message.id)!.sharedEntrance).toBeDefined();
    store.request({ type: 'memory.record', ...alice, candidate: { learnedEntranceSourceId: sent.message.id, content: 'bob分享了她的小屋入口。', sourceMessageIds: [sent.message.id], evidence: [{ sourceMessageId: sent.message.id, quote: '场景 home_bob' }] } });
    expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(2);
    store.request({ type: 'memory.forget', companionId: 'alice', conversationId: sent.message.conversationId, sourceMessageIds: [sent.message.id] });
    expect(store.request({ type: 'world.observe', ...alice }).world!.knownAddresses).toHaveLength(1);
    expect(() => commit(next, { status: 'complete', action: null, wait: null, summary: '不能回传已撤回资料' })).toThrow('来源');
});
it('cancels withdrawn sources, rejects foreign owners, caps repeated failures and empty plans', () => {
    const { task, source } = start();
    expect(() => store.request({ type: 'activity.cancel', ...bob, id: task.id })).toThrow('其他');
    const first = claim()!;
    store.request({ type: 'memory.forget', ...alice, sourceMessageIds: [source.id] });
    expect(() => commit(first, { status: 'continue', action: { action: 'leave' }, wait: null, summary: '旧目标' })).toThrow('来源');
    expect(store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask!.goal).not.toContain(source.content);
    advance(121000);
    expect(claim()).toBeUndefined();
    expect(store.request({ type: 'activity.get', ...alice, id: task.id }).activityTask!.status).toBe('cancelled');
    start('goal_two');
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = claim()!;
        const result = commit(current, { status: 'continue', action: { action: 'travel', targetSceneId: 'home_' + 'bob' }, wait: null, summary: '猜地址不应成功' });
        if (attempt === 2)
            expect(result.status).toBe('failed');
        advance(1600);
    }
    start('empty_goal');
    const empty = commit(claim()!, { status: 'continue', action: null, wait: null, summary: '空循环' });
    expect(empty.status).toBe('failed');
});
it('stops only its own pending route on cancellation and times out waits without endless polling', () => {
    shareAddress();
    invite();
    const { task } = start();
    commit(claim()!, { status: 'continue', action: { action: 'travel', targetSceneId: 'home_' + 'bob' }, wait: null, summary: '导航' });
    advance(1000);
    const position = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!.position;
    store.request({ type: 'activity.cancel', ...alice, id: task.id });
    const actor = store.request({ type: 'world.observe', ...alice }).world!.actors[0]!;
    expect(actor.route).toHaveLength(0);
    expect(actor.position).toEqual(position);
    start('waiting_goal');
    commit(claim()!, { status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'bob' }, summary: '等待来信' });
    advance(1600);
    expect(claim()).toBeUndefined();
    advance(300001);
    const expired = claim()!;
    expect(expired.stage).toContain('超时');
    expect(expired.status).toBe('running');
    commit(expired, { status: 'blocked', action: null, wait: null, summary: '没有等到回复，先不打扰。' });
    advance(5000);
    expect(claim()).toBeUndefined();
});
it('continues a newly issued route when a just-received phone conversation releases its pose', () => {
    store.request({ type: 'world.tool', ...bob, arguments: { action: 'share_entrance', recipientIds: ['alice'] } });
    store.request({ type: 'social.job.claim' });
    advance(1600);
    const reply = store.request({ type: 'social.job.claim' }).socialJob!;
    advance(1600);
    store.request({ type: 'social.job.complete', id: reply.id, leaseToken: reply.leaseToken!, text: null });
    invite();
    store.request({ type: 'world.tool', ...alice, arguments: { action: 'travel', targetSceneId: 'home_bob' } });
    const arrived = advance(40000).actors.find(actor => actor.companionId === 'alice')!;
    expect(arrived.sceneId).toBe('home_bob');
    expect(arrived.route).toHaveLength(0);
});
it('resumes and finishes a route accepted during a long player phone lease', () => {
    const source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '一边聊一边走到沙发旁。', replyDirective: 'none' });
    store.request({ type: 'world.work.begin', ...alice, kind: 'chat', workId: 'short_phone', sourceMessageId: source.id });
    store.request({ type: 'world.tool', ...alice, arguments: { action: 'move', destinationId: 'alice_sofa' } });
    advance(12000);
    store.request({ type: 'world.work.end', companionId: 'alice', workId: 'short_phone' });
    const self = advance(12000).actors.find(actor => actor.companionId === 'alice')!;
    expect(self.route).toHaveLength(0);
    expect(self.activity).toBe('idle');
});
