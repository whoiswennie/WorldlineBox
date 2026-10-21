import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionWorldArgumentsSchema } from '../../src/shared/companion-world-tool';
import type { CompanionWorldArguments } from '../../src/shared/companion-world-tool';
const stores: CompanionsStore[] = [], roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-20T10:00:00Z'); });
afterEach(() => { stores.splice(0).forEach(store => store.close()); for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith('companion-scenes-'))
        throw new Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
} vi.useRealTimers(); });
function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'companion-scenes-'));
    roots.push(root);
    const filename = path.join(root, 'messages.sqlite');
    const store = new CompanionsStore(filename, ['alice', 'bob', 'carol'].map(id => ({ id, name: id, active: true, persona: '独立友好', description: '', model: '', avatar: 'sister' as const, proactive: true })));
    stores.push(store);
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    for (const id of ['alice', 'bob', 'carol']) {
        const conversationId = store.openPrivate(id).id, routine = store.request({ type: 'routine.get', companionId: id, conversationId }).routine!;
        store.request({ type: 'routine.configure', companionId: id, conversationId, expectedRevision: routine.revision, patch: { wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
    }
    return { store, filename };
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }
function act(store: CompanionsStore, id: string, args: CompanionWorldArguments) { return store.request({ type: 'world.tool', companionId: id, conversationId: store.openPrivate(id).id, arguments: args }); }
function invite(store: CompanionsStore) {
    act(store, 'alice', { action: 'visit', targetCompanionId: 'bob', reason: '想找你玩一会儿，方便吗？' });
    const visit = store.request({ type: 'world.snapshot' }).world!.visits.find(visit => visit.hostId === 'bob' && visit.status === 'requested')!;
    act(store, 'bob', { action: 'respond', requestId: visit.id, decision: 'allow', reason: '现在有空，欢迎来我的小屋。' });
    return visit.id;
}
it('has independent scenes and local entrances without a street, exterior buildings or global house positions', () => {
    const { store } = fixture(), world = store.request({ type: 'world.snapshot' }).world!;
    expect(world.scenes.map(scene => scene.id)).toEqual(['home_alice', 'home_bob', 'home_carol', 'park']);
    expect(world.scenes.flatMap(scene => scene.objects).some(object => object.kind === 'building')).toBe(false);
    expect(world.scenes.every(scene => scene.portals?.some(portal => portal.direction === 'both'))).toBe(true);
    expect(world.scenes.filter(scene => scene.kind === 'home').map(scene => scene.origin)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
    expect(companionWorldArgumentsSchema.safeParse({ action: 'travel', targetSceneId: 'home_bob', x: 100, y: 200 }).success).toBe(false);
    expect(companionWorldArgumentsSchema.safeParse({ action: 'navigate', targetCompanionId: 'bob' }).success).toBe(false);
});
it('walks to the local exit, crosses the invited endpoint and resumes local pathfinding without inter-scene waypoints', () => {
    const { store } = fixture();
    expect(() => act(store, 'alice', { action: 'travel', targetSceneId: 'home_bob' })).toThrow('邀请');
    const visitId = invite(store);
    const destination = store.request({ type: 'world.snapshot' }).world!.visits.find(visit => visit.id === visitId)!.destination;
    expect(destination).toEqual({ sceneId: 'home_bob', entryId: 'entrance' });
    let world = act(store, 'alice', { action: 'travel', targetSceneId: destination!.sceneId, entryId: destination!.entryId }).world!;
    let actor = world.actors.find(actor => actor.companionId === 'alice')!;
    expect(actor.sceneId).toBe('home_alice');
    expect(actor.travel?.targetSceneId).toBe('home_bob');
    expect(actor.route.every(point => point.sceneId === 'home_alice')).toBe(true);
    world = advance(store, 3000);
    actor = world.actors.find(actor => actor.companionId === 'alice')!;
    expect(actor.sceneId).toBe('home_bob');
    expect(actor.travel).toBeUndefined();
    expect(actor.position).toEqual({ x: 10, y: 15 });
    expect(() => act(store, 'alice', { action: 'move', destinationId: 'home_carol' })).toThrow('当前场景');
    act(store, 'alice', { action: 'leave' });
    world = advance(store, 3000);
    expect(world.actors.find(actor => actor.companionId === 'alice')?.sceneId).toBe('home_alice');
});
it('rechecks dormancy and busyness at the portal and never loads or enters an unavailable home', () => {
    const { store } = fixture();
    invite(store);
    act(store, 'alice', { action: 'travel', targetSceneId: 'home_bob' });
    store.request({ type: 'companion.set-active', id: 'bob', active: false });
    let world = advance(store, 4000);
    expect(world.scenes.some(scene => scene.id === 'home_bob')).toBe(false);
    expect(world.actors.find(actor => actor.companionId === 'alice')?.sceneId).toBe('home_alice');
    expect(world.events.some(event => event.kind === 'travel_blocked' && event.actorId === 'alice')).toBe(true);
    store.request({ type: 'companion.set-active', id: 'bob', active: true });
    invite(store);
    act(store, 'alice', { action: 'travel', targetSceneId: 'home_bob' });
    store.request({ type: 'world.work.begin', companionId: 'bob', conversationId: store.openPrivate('bob').id, kind: 'action', workId: 'busy', fixed: true });
    world = advance(store, 4000);
    expect(world.actors.find(actor => actor.companionId === 'alice')?.sceneId).toBe('home_alice');
});
it('queries world and social evidence without automatically creating memories, and learns only through memory.record', () => {
    const { store } = fixture(), conversationId = store.openPrivate('alice').id;
    const source = store.appendMessage({ conversationId, authorId: 'user', content: '找一下bob。', replyDirective: 'none' });
    const queried = store.request({ type: 'memory.world_query', companionId: 'alice', conversationId, beforeSequence: source.sequence, category: 'contacts', query: 'bob' });
    expect(queried.worldKnowledge).toMatchObject({ internalized: false, items: [{ id: 'bob', name: 'bob', active: true, source: 'contact_directory' }] });
    expect(store.request({ type: 'memory.browse', companionId: 'alice', conversationId }).memoryPage?.items).toEqual([]);
    const evidence = queried.memorySources![0]!;
    expect(evidence.worldObservation?.internalized).toBe(false);
    const learned = store.request({ type: 'memory.record', companionId: 'alice', conversationId, beforeSequence: source.sequence,
        candidate: { content: '我查到联系人bob的标识是bob。', sourceMessageIds: [evidence.id], evidence: [{ sourceMessageId: evidence.id, quote: '"id":"bob","name":"bob"' }] } });
    expect(learned.memories?.[0]?.status).toBe('queued');
    expect(store.request({ type: 'memory.browse', companionId: 'bob', conversationId: store.openPrivate('bob').id }).memoryPage?.items).toEqual([]);
    const peer = store.request({ type: 'social.conversation.ensure', companionId: 'bob', memberIds: ['bob', 'carol'] }).socialConversation!;
    expect(() => store.request({ type: 'memory.world_query', companionId: 'alice', conversationId, category: 'social', roomId: peer.id })).toThrow('未参与');
    const scenes = store.request({ type: 'memory.world_query', companionId: 'alice', conversationId, category: 'scenes' }).worldKnowledge!.items;
    expect(scenes.some(scene => scene.sceneId === 'home_bob')).toBe(false);
    expect(scenes.map(scene => scene.sceneId)).toEqual(['home_alice', 'park']);
});
it('lets an intrinsic action agent query, selectively learn and organize its own knowledge without a player instruction', () => {
    const { store } = fixture(), scope = { companionId: 'alice', conversationId: 'world_alice' };
    const task = store.request({ type: 'activity.start', ...scope, clientId: 'self_learning', title: '整理新的联系人知识', goal: '查找bob，仅内化有来源且有用的信息。' }).activityTask!;
    let leased = store.request({ type: 'activity.claim' }).activityTask!;
    expect(leased.id).toBe(task.id);
    const queried = store.request({ type: 'activity.commit', id: task.id, leaseToken: leased.leaseToken!, decision: { status: 'continue', action: { action: 'query', category: 'contacts', query: 'bob', limit: 1 }, wait: null, summary: '先查一次联系人目录。' } }).activityTask!;
    const receipt = JSON.parse(queried.history[0]!.result).memorySources[0];
    expect(store.request({ type: 'memory.browse', ...scope }).memoryPage!.items).toEqual([]);
    advance(store, 1600);
    leased = store.request({ type: 'activity.claim' }).activityTask!;
    const learned = store.request({ type: 'activity.commit', id: task.id, leaseToken: leased.leaseToken!, decision: { status: 'continue', action: null, wait: null, summary: '把核验过的联系人标识记住。', memory: { operation: 'record', candidate: { content: '我查到bob的联系人标识是bob。', sourceMessageIds: [receipt.id], evidence: [{ sourceMessageId: receipt.id, quote: '"id":"bob","name":"bob"' }] } } } }).activityTask!;
    expect(learned.history).toHaveLength(1);
    const intent = store.request({ type: 'activity.memory.claim' }).activityMemoryIntent!;
    expect(intent.operation.operation).toBe('record');
    const response = store.request({ type: 'memory.record', ...scope, candidate: intent.operation.operation === 'record' ? intent.operation.candidate : (() => { throw new Error('Unexpected intent'); })() });
    const memory = response.memories![0]!;
    store.request({ type: 'activity.memory.complete', id: intent.id, leaseToken: intent.leaseToken, result: JSON.stringify(response), sourceMessageIds: memory.sources.map(source => source.messageId), noteVersions: [{ id: memory.id, version: memory.version }] });
    expect(memory.sources[0]!.sourceType).toBe('world_observation');
    advance(store, 1600);
    leased = store.request({ type: 'activity.claim' }).activityTask!;
    store.request({ type: 'activity.commit', id: task.id, leaseToken: leased.leaseToken!, decision: { status: 'continue', action: null, wait: null, summary: '把这条知识归入联系人。', memory: { operation: 'organize', ids: [memory.id], tags: ['联系人'] } } });
    const organizing = store.request({ type: 'activity.memory.claim' }).activityMemoryIntent!;
    const organized = store.request({ type: 'memory.organize', ...scope, ids: [memory.id], tags: ['联系人'] });
    store.request({ type: 'activity.memory.complete', id: organizing.id, leaseToken: organizing.leaseToken, result: JSON.stringify(organized), sourceMessageIds: [], noteVersions: organized.memories!.map(note => ({ id: note.id, version: note.version })) });
    const records = store.request({ type: 'memory.browse', ...scope }).memoryPage!.items;
    expect(records).toHaveLength(1);
    expect(records[0]!.memory.tags?.some(tag => tag === '联系人')).toBe(true);
    expect(store.request({ type: 'memory.browse', companionId: 'bob', conversationId: 'world_bob' }).memoryPage!.items).toEqual([]);
});
it('keeps scene observations queryable as external evidence without automatically learning them', () => {
    const { store } = fixture(), scope = { companionId: 'alice', conversationId: 'world_alice' };
    const pending = store.request({ type: 'memory.status', ...scope }).memoryStatus!.pending;
    const result = store.request({ type: 'memory.world_query', ...scope, category: 'observations', query: 'home_alice' });
    expect(result.worldKnowledge!.items.length).toBeGreaterThan(0);
    expect(result.worldKnowledge).toMatchObject({ internalized: false });
    expect(result.worldKnowledge!.items.every(item => item.sceneId === 'home_alice')).toBe(true);
    expect(store.request({ type: 'memory.status', ...scope }).memoryStatus!.pending).toBe(pending);
    expect(store.request({ type: 'memory.browse', ...scope }).memoryPage!.items).toEqual([]);
});
it('invalidates queried social evidence and its learned memory after the actual source is forgotten', () => {
    const { store } = fixture(), scope = { companionId: 'alice', conversationId: 'world_alice' };
    act(store, 'alice', { action: 'message', recipientIds: ['bob'], text: '我今天想听一首轻快的曲子。' });
    advance(store, 1600);
    store.request({ type: 'social.job.claim' });
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    const query = store.request({ type: 'memory.world_query', ...scope, category: 'social', roomId: room.id });
    const receipt = query.memorySources![0]!, originalId = query.worldKnowledge!.items[0]!.messageId as string;
    const memory = store.request({ type: 'memory.record', ...scope, candidate: { content: '我发出了听轻快曲子的想法。',
            sourceMessageIds: [receipt.id], evidence: [{ sourceMessageId: receipt.id, quote: '我今天想听一首轻快的曲子。' }] } }).memories![0]!;
    expect(store.request({ type: 'memory.read', ...scope, id: memory.id }).memoryRead!.memory).toBeDefined();
    store.request({ type: 'memory.forget', companionId: 'alice', conversationId: room.id, sourceMessageIds: [originalId] });
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [receipt.id] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.browse', ...scope }).memoryPage!.items).toEqual([]);
});
it('restores a suspended guest into her own entry if the host has also become dormant', () => {
    const { store } = fixture();
    invite(store);
    act(store, 'alice', { action: 'travel', targetSceneId: 'home_bob' });
    advance(store, 3000);
    store.request({ type: 'companion.set-active', id: 'alice', active: false });
    store.request({ type: 'companion.set-active', id: 'bob', active: false });
    store.request({ type: 'companion.set-active', id: 'alice', active: true });
    const world = advance(store, 1);
    expect(world.actors.find(actor => actor.companionId === 'alice')).toMatchObject({ sceneId: 'home_alice', position: { x: 10, y: 15 } });
    expect(world.scenes.some(scene => scene.id === 'home_bob')).toBe(false);
});
