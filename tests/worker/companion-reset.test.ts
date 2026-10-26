import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { CompanionResetStore } from '../../src/companions/reset-store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
const Database = BetterSqlite3 as {
    new (filename: string): CompanionConnection;
};
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '默认资料', persona: '默认人设', model: '', avatar: 'sister', proactive: false }));
const roots: string[] = [], stores = new Set<CompanionsStore>();
afterEach(() => {
    for (const store of stores)
        store.close();
    stores.clear();
    for (const root of roots.splice(0)) {
        if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-reset-'))
            throw new Error('Unexpected reset fixture cleanup.');
        rmSync(root, { recursive: true, force: true });
    }
});
function open(file: string) { const store = new CompanionsStore(file, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store); return store; }
function close(store: CompanionsStore) { store.close(); stores.delete(store); }
function fixture() { const root = mkdtempSync(path.join(tmpdir(), 'companion-reset-')); roots.push(root); const file = path.join(root, 'messages.sqlite'), store = open(file); return { root, file, store, room: store.openPrivate('alice') }; }
async function finish(store: CompanionsStore, id = 'alice', max = 20000) {
    for (let step = 0; step < max; step++) {
        const job = store.request({ type: 'companion.reset.status', id }).reset!;
        if (job.status === 'completed')
            return job;
        if (job.status === 'failed')
            throw new Error('Reset failed at ' + job.phase + ': ' + job.error);
        await store.advanceReset();
    }
    throw new Error('Reset did not complete.');
}
it('rejects deletion of built-ins, resumes a tombstoned built-in without overwriting its saved profile, and requires a seed for reset', () => {
    const f = fixture();
    expect(() => f.store.deleteCompanion('alice')).toThrow('不能删除');
    const custom = f.store.createCompanion({ name: '自定义', description: '', persona: '用户设定', model: '', avatar: 'custom', proactive: false });
    expect(() => f.store.request({ type: 'companion.reset', id: custom.id, scope: 'all' })).toThrow('出厂设定');
    f.store.deleteCompanion(custom.id);
    f.store.updateCompanion('alice', { ...seeds[0]!, name: '已编辑的名字' });
    close(f.store);
    const db = new Database(f.file);
    db.prepare('UPDATE companions SET deleted_at=? WHERE id=?').run('previous removal', 'alice');
    db.close();
    const reopened = open(f.file);
    expect(reopened.state().companions.find(item => item.id === 'alice')!.name).toBe('已编辑的名字');
});
it('scopes internal owner lookups and clears only the explicitly reset owner initialization receipt', async () => {
    const f = fixture();
    for (const companionId of ['alice', 'bob']) {
        expect(f.store.request({ type: 'companion.assets.initialized', companionId }).assetProfileInitialized).toBe(false);
        f.store.request({ type: 'companion.assets.mark-initialized', companionId });
        for (const role of ['avatar', 'orthographic'] as const) f.store.request({ type: 'companion.assets.portrait.mark-initialized', companionId, role });
    }
    expect(f.store.request({ type: 'state', companionId: 'alice', includeConversations: false }).state!.companions.map(owner => owner.id)).toEqual(['alice']);
    expect(f.store.request({ type: 'state', companionId: 'missing', includeConversations: false }).state!.companions).toEqual([]);
    close(f.store); const reopened = open(f.file);
    expect(reopened.request({ type: 'companion.assets.initialized', companionId: 'alice' }).assetProfileInitialized).toBe(true);
    const reset = reopened.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    expect(() => reopened.request({ type: 'companion.assets.mark-initialized', companionId: 'alice' })).toThrow('重置');
    reopened.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: reset.id }); await finish(reopened);
    expect(reopened.request({ type: 'companion.assets.initialized', companionId: 'alice' }).assetProfileInitialized).toBe(false);
    expect(reopened.request({ type: 'companion.assets.initialized', companionId: 'bob' }).assetProfileInitialized).toBe(true);
    for (const role of ['avatar', 'orthographic'] as const) {
        expect(reopened.request({ type: 'companion.assets.portrait.initialized', companionId: 'alice', role }).assetPortraitInitialized).toBe(false);
        expect(reopened.request({ type: 'companion.assets.portrait.initialized', companionId: 'bob', role }).assetPortraitInitialized).toBe(true);
    }
});
it('persists the stopping barrier and cancellation IDs, retries failed cleanup, and rejects old work throughout reset', async () => {
    const f = fixture(), source = f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '旧任务来源' });
    const action = f.store.request({ type: 'action.create', action: { conversationId: f.room.id, companionId: 'alice', sourceMessageId: source.id, title: '旧任务', status: 'running', accessMode: 'danger-full-access', taskId: 'external-task' } }).action!;
    const started = f.store.request({ type: 'companion.reset', id: 'alice', scope: 'all', expectedRevision: 1 });
    expect(companionStorageResponseSchema.parse(started).reset).toMatchObject({ status: 'running', phase: 'stopping' });
    expect(started.resetTaskIds).toEqual(['external-task']);
    expect(await f.store.advanceReset()).toBe(false);
    expect(f.store.getMessage(source.id).content).toBe(source.content);
    expect(() => f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '迟到结果' } })).toThrow('重置');
    f.store.request({ type: 'companion.reset.cleanup-failed', id: 'alice', jobId: started.reset!.id, error: '外部取消尚未成功' });
    close(f.store);
    const store = open(f.file), pending = store.request({ type: 'companion.reset.status', id: 'alice' });
    expect(pending.reset).toMatchObject({ status: 'failed', phase: 'stopping' });
    expect(pending.resetTaskIds).toEqual(['external-task']);
    expect(store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!.id).toBe(started.reset!.id);
    store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: started.reset!.id });
    await finish(store);
    expect(() => store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '再次迟到' } })).toThrow();
    expect(store.request({ type: 'messages', conversationId: f.room.id }).messages).toEqual([]);
    expect(store.state().companions.find(item => item.id === 'alice')).toMatchObject({ name: 'alice', persona: '默认人设', revision: 2 });
});
it('tracks a late launch durably during stopping and enumerates every owner task regardless of history status or page size', async () => {
    const f = fixture(), source = f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '已授权的旧任务' });
    const action = f.store.request({ type: 'action.create', action: { conversationId: f.room.id, companionId: 'alice', sourceMessageId: source.id, title: '启动中', status: 'queued', accessMode: 'danger-full-access' } }).action!;
    for (let index = 0; index < 105; index++)
        f.store.request({ type: 'action.create', action: { conversationId: f.room.id, companionId: 'alice', sourceMessageId: source.id, title: '历史任务', taskId: 'historical-' + index, status: index % 2 ? 'cancelled' : 'succeeded', accessMode: 'danger-full-access' } });
    const job = f.store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    expect(() => f.store.request({ type: 'companion.task.track', id: action.id, companionId: 'bob', taskId: 'wrong-owner' })).toThrow('不属于');
    f.store.request({ type: 'companion.task.track', id: action.id, companionId: 'alice', taskId: 'late-native-task' });
    const listed = companionStorageResponseSchema.parse(f.store.request({ type: 'companion.task-ids', id: 'alice' })).companionTaskIds!;
    expect(listed).toHaveLength(106);
    expect(listed).toContain('historical-0');
    expect(listed).toContain('late-native-task');
    close(f.store);
    const store = open(f.file);
    expect(store.request({ type: 'companion.reset.status', id: 'alice' }).resetTaskIds).toContain('late-native-task');
    expect(store.getAction(action.id)).toMatchObject({ status: 'queued', taskId: 'late-native-task' });
    store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: job.id });
    expect(() => store.request({ type: 'companion.task.track', id: action.id, companionId: 'alice', taskId: 'too-late' })).toThrow('清理阶段');
    await finish(store);
    expect(() => store.request({ type: 'companion.task.track', id: action.id, companionId: 'alice', taskId: 'deleted-action' })).toThrow('不属于');
});
it('preserves other group authors, invalidates a peer memory whose source is removed, and permanently blocks pre-reset group evidence', async () => {
    const f = fixture(), group = f.store.createConversation('共同群聊', ['alice', 'bob']);
    const user = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: '保留给其他伙伴的用户消息' });
    const own = f.store.appendMessage({ conversationId: group.id, authorId: 'alice', content: '将撤回的伙伴发言' });
    const other = f.store.appendMessage({ conversationId: group.id, authorId: 'bob', content: '另一位伙伴的原话', replyToId: own.id });
    const peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    const speech = f.store.request({ type: 'social.message.append', conversationId: peer.id, authorId: 'alice', content: '有来源的共同经历', virtualCreatedAt: '2026-10-15T12:00:00Z', clientId: 'speech' }).socialMessage!.message;
    const memory = f.store.request({ type: 'memory.record', companionId: 'bob', conversationId: peer.id, candidate: { content: speech.content, sourceMessageIds: [speech.id], evidence: [{ sourceMessageId: speech.id, quote: speech.content }] } }).memories![0]!;
    const started = f.store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    f.store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: started.id });
    await finish(f.store);
    expect(f.store.request({ type: 'messages', conversationId: group.id }).messages!.map(message => message.id)).toEqual([user.id, other.id]);
    expect(f.store.getMessage(other.id).replyToId).toBeUndefined();
    expect(f.store.request({ type: 'messages', conversationId: peer.id }).messages).toEqual([]);
    expect(() => f.store.request({ type: 'memory.read', companionId: 'bob', conversationId: f.store.openPrivate('bob').id, id: memory.id })).toThrow();
    f.store.updateConversation(group.id, { memberIds: ['alice', 'bob'] });
    expect(() => f.store.request({ type: 'social.contact.check', companionId: 'alice', recipientIds: ['bob'] })).toThrow('还不是你认识');
    expect(f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: group.id, ids: [user.id] }).memorySources).toEqual([]);
    expect(() => f.store.request({ type: 'memory.record', companionId: 'alice', conversationId: group.id, candidate: { content: user.content, sourceMessageIds: [user.id], evidence: [{ sourceMessageId: user.id, quote: user.content }] } })).toThrow();
    expect(() => f.store.request({ type: 'action.create', action: { conversationId: group.id, companionId: 'alice', sourceMessageId: user.id, title: '不该复活', status: 'queued', accessMode: 'danger-full-access' } })).toThrow('重置');
});
it('removes a reset message publication index while retaining another group author and its real index', async () => {
    const f = fixture(), group = f.store.createConversation('发布索引重置隔离', ['alice', 'bob']);
    const topic = f.store.request({ type: 'topic.create', conversationId: group.id, readerId: 'alice', kind: 'game', title: '真实共享局' }).topic!;
    f.store.request({ type: 'topic.join', conversationId: group.id, topicId: topic.id, readerId: 'bob' });
    const own = f.store.appendMessage({ conversationId: group.id, topicId: topic.id, authorId: 'alice', content: '本人将清除的公开进度。', replyDirective: 'none' });
    const other = f.store.appendMessage({ conversationId: group.id, topicId: topic.id, authorId: 'bob', content: '另一位伙伴保留的独立进度。', replyDirective: 'none' });
    const db = new Database(f.file);
    try {
        const index = (id: string) => db.prepare('SELECT value FROM metadata WHERE key=?').get('message-topic-publication/' + id);
        expect(index(own.id)).toBeTruthy();
        const otherIndex = index(other.id); expect(otherIndex).toBeTruthy();
        const job = f.store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
        f.store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: job.id }); await finish(f.store);
        expect(() => f.store.getMessage(own.id)).toThrow();
        expect(index(own.id)).toBeUndefined();
        expect(f.store.getMessage(other.id).content).toBe(other.content);
        expect(index(other.id)).toEqual(otherIndex);
    } finally { db.close(); }
});
it('resets an orphaned hidden host port without touching another owner or similarly named rooms', async () => {
    const f = fixture();
    f.store.request({ type: 'world.snapshot' });
    const own = f.store.appendMessage({ conversationId: 'world_alice', authorId: 'system', kind: 'notice', content: 'orphaned own observation' });
    const other = f.store.appendMessage({ conversationId: 'world_bob', authorId: 'system', kind: 'notice', content: 'other owner observation' });
    close(f.store);
    const db = new Database(f.file);
    db.prepare("DELETE FROM conversation_members WHERE conversation_id='world_alice'").run();
    db.prepare("UPDATE conversations SET hidden_at=? WHERE id='world_alice'").run(new Date().toISOString());
    expect(db.prepare("SELECT hidden_at FROM conversations WHERE id='world_alice'").get()).toEqual({ hidden_at: expect.any(String) });
    expect(db.prepare("SELECT value FROM metadata WHERE key='world-room/world_alice'").get()).toEqual({ value: 'true' });
    db.prepare("INSERT INTO conversations(id,kind,title,updated_at,hidden_at) VALUES('world_alice_copy','group','similar room',?,?)").run(new Date().toISOString(), new Date().toISOString());
    db.prepare("INSERT INTO metadata(key,value) VALUES('world-room/world_alice_copy','true')").run();
    db.close();
    const store = open(f.file);
    const similar = store.appendMessage({ conversationId: 'world_alice_copy', authorId: 'system', kind: 'notice', content: 'similar name is not owner evidence' });
    const reset = store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: reset.id });
    await finish(store);
    expect(() => store.getMessage(own.id)).toThrow();
    expect(store.getMessage(other.id).content).toBe(other.content);
    expect(store.getMessage(similar.id).content).toBe(similar.content);
});
it('does not infer host ownership from an unmarked hidden room with the fixed world name', async () => {
    const f = fixture();
    f.store.request({ type: 'world.snapshot' });
    const unmarked = f.store.appendMessage({ conversationId: 'world_alice', authorId: 'system', kind: 'notice', content: 'no host marker' });
    close(f.store);
    const db = new Database(f.file);
    db.prepare("DELETE FROM conversation_members WHERE conversation_id='world_alice'").run();
    db.prepare("UPDATE conversations SET hidden_at=? WHERE id='world_alice'").run(new Date().toISOString());
    db.prepare("DELETE FROM metadata WHERE key='world-room/world_alice'").run();
    // Exercise the reset ownership gate before a separate world sync can adopt
    // this reserved name as its host port and publish a fresh marker.
    try {
        const resetStore = new CompanionResetStore(db, f.root, () => ({ ...seeds[0]!, active: true, builtin: true, createdAt: new Date().toISOString() }), () => undefined, () => undefined, () => undefined, () => 0);
        resetStore.initialize(); resetStore.prepareIndexes();
        const reset = resetStore.begin('alice').reset;
        resetStore.cleanup('alice', reset.id);
        for (let i = 0; resetStore.status('alice').reset?.status !== 'completed'; i++) {
            expect(i).toBeLessThan(1000); await resetStore.advance();
        }
        expect(db.prepare('SELECT id FROM messages WHERE id=?').get(unmarked.id)).toEqual({ id: unmarked.id });
    } finally { db.close(); }
});
it('removes only unreferenced managed files and never removes a linked source or another profile/message image', async () => {
    const f = fixture(), directory = path.join(f.root, 'attachments');
    mkdirSync(directory);
    const external = path.join(f.root, 'original-linked.txt');
    writeFileSync(external, 'keep original');
    for (const id of ['owned', 'shared', 'linked']) {
        writeFileSync(path.join(directory, id + '.txt'), 'managed ' + id);
        f.store.registerAttachment({ attachment: { id, name: id + '.txt', size: 10, mime: 'text/plain' }, relativePath: 'attachments/' + id + '.txt', ...(id === 'linked' ? { sourcePath: external } : {}) });
    }
    f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '本人文件', attachmentIds: ['owned', 'shared', 'linked'] });
    const other = f.store.openPrivate('bob');
    f.store.appendMessage({ conversationId: other.id, authorId: 'user', content: '仍有引用', attachmentIds: ['shared'] });
    const started = f.store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    f.store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: started.id });
    await finish(f.store);
    expect(existsSync(path.join(directory, 'owned.txt'))).toBe(false);
    expect(() => f.store.getAttachment('owned')).toThrow();
    expect(existsSync(path.join(directory, 'shared.txt'))).toBe(true);
    expect(f.store.getAttachment('shared').attachment.id).toBe('shared');
    expect(readFileSync(external, 'utf8')).toBe('keep original');
    expect(existsSync(path.join(directory, 'linked.txt'))).toBe(true);
});
it('leaves peer groups, preserves other authors and starts new social introductions after reset', async () => {
    const f = fixture(), carol = f.store.createCompanion({ name: 'carol', description: '', persona: '第三位伙伴', model: '', avatar: 'custom', proactive: false });
    const members = ['alice', 'bob', carol.id], group = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: members }).socialConversation!;
    const pair = f.store.request({ type: 'social.conversation.ensure', companionId: 'bob', memberIds: ['bob', carol.id] }).socialConversation!;
    const append = (authorId: string, content: string, clientId: string) => f.store.request({ type: 'social.message.append', conversationId: group.id, authorId, content, clientId, virtualCreatedAt: '2026-10-15T12:00:00Z' }).socialMessage!.message;
    append('alice', '重置者的旧发言', 'group-alice');
    const retained = append('bob', '其他人的群聊历史', 'group-bob');
    const job = f.store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    f.store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: job.id });
    await finish(f.store);
    expect(f.store.request({ type: 'messages', conversationId: group.id }).messages!.map(message => message.id)).toEqual([retained.id]);
    const resetGraph = f.store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!;
    expect(resetGraph.links).toEqual([]);
    expect(resetGraph.events).toEqual([]);
    expect(resetGraph.total).toBe(0);
    const introduced = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: members }).socialConversation!;
    expect(introduced.id).not.toBe(group.id);
    expect(introduced.messageCount).toBe(0);
    expect(f.store.request({ type: 'social.conversation.ensure', companionId: 'bob', memberIds: ['bob', carol.id] }).socialConversation!.id).toBe(pair.id);
    expect(() => f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: group.id, ids: [retained.id] })).toThrow('不是聊天成员');
    const fresh = f.store.request({ type: 'social.message.append', conversationId: introduced.id, authorId: 'bob', content: '重置后新的互动', clientId: 'group-new', virtualCreatedAt: '2026-10-15T12:00:00Z' }).socialMessage!.message;
    expect(f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: introduced.id, ids: [fresh.id] }).memorySources!.map(message => message.id)).toEqual([fresh.id]);
});
it('clears both sides of private social history and restores the world without reviving dormant visitors', async () => {
    const f = fixture(), bobRoom = f.store.openPrivate('bob');
    const pair = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    for (const authorId of ['alice', 'bob'])
        f.store.request({ type: 'social.message.append', conversationId: pair.id, authorId, content: '过去的社交经历-' + authorId, clientId: authorId, virtualCreatedAt: new Date().toISOString() });
    const own = f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '旧玩家消息' });
    f.store.appendMessage({ conversationId: f.room.id, authorId: 'alice', content: '旧伙伴回复' });
    f.store.saveMemory({ companionId: 'alice', content: '应全部清空的记忆', sourceMessageId: own.id, conversationId: f.room.id });
    const retained = f.store.appendMessage({ conversationId: bobRoom.id, authorId: 'user', content: '另一位伙伴的独立生活' });
    const before = f.store.request({ type: 'world.snapshot' }).world!;
    close(f.store);
    const db = new Database(f.file);
    const world = JSON.parse(String((db.prepare('SELECT data FROM companion_world WHERE id=1').get() as {
        data: string;
    }).data));
    const alice = world.actors.find((actor: {
        companionId: string;
    }) => actor.companionId === 'alice');
    alice.position = { x: 1, y: 1 };
    alice.lastDreamDay = 'OLD_WORLD_STATE';
    const bob = world.actors.find((actor: {
        companionId: string;
    }) => actor.companionId === 'bob');
    bob.sceneId = 'home_alice';
    bob.journey = { targetSceneId: 'home_alice' };
    bob.meetingHold = { memberIds: ['alice', 'bob'], untilReal: Date.now() + 60000, jobId: 'old-meeting' };
    db.prepare('INSERT OR REPLACE INTO companion_world_suspended(companion_id,data) VALUES(?,?)').run('bob', JSON.stringify({ actor: bob, since: Date.now() }));
    world.actors = world.actors.filter((actor: {
        companionId: string;
    }) => actor.companionId !== 'bob');
    db.prepare("UPDATE companions SET data=json_set(data,'$.active',json('false')) WHERE id='bob'").run();
    world.relationships = [{ companionId: 'alice', targetCompanionId: 'bob', affinity: 90, trust: 90 }, { companionId: 'bob', targetCompanionId: 'alice', affinity: 80, trust: 80 }];
    db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(world));
    db.close();
    let store = open(f.file);
    const job = store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: job.id });
    await finish(store);
    expect(store.listMemory('alice')).toEqual([]);
    expect(store.messages({ conversationId: f.room.id }).messages).toEqual([]);
    expect(store.messages({ conversationId: bobRoom.id }).messages.some(message => message.id === retained.id)).toBe(true);
    expect(store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph).toMatchObject({ total: 0, links: [], events: [], visits: [] });
    let fresh = store.request({ type: 'world.snapshot' }).world!;
    expect(fresh.settings).toEqual(before.settings);
    expect(fresh.relationships).toEqual([]);
    expect(fresh.visits).toEqual([]);
    expect(fresh.actors.find(actor => actor.companionId === 'alice')?.position).not.toEqual({ x: 1, y: 1 });
    expect(JSON.stringify(fresh)).not.toContain('OLD_WORLD_STATE');
    store.setCompanionActive('bob', true);
    fresh = store.request({ type: 'world.snapshot' }).world!;
    expect(fresh.actors.find(actor => actor.companionId === 'bob')?.sceneId).toBe('home_bob');
    close(store);
    store = open(f.file);
    expect(store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.total).toBe(0);
    const newPair = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    expect(newPair.id).not.toBe(pair.id);
    expect(newPair.messageCount).toBe(0);
});
it('resumes indexed batches after restart across 100000 messages and 100000 sourced memories', async () => {
    const pressureCount = Number(process.env.WORLDLINEBOX_RESET_PRESSURE_COUNT ?? 100000);
    const fixtureStarted = performance.now();
    const f = fixture();
    close(f.store);
    const db = new Database(f.file);
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    const insertMessage = db.prepare("INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,status) VALUES(?,?,'user','text',?,'2026-10-15T12:00:00Z','sent')");
    db.prepare("INSERT INTO vcp_memory_scopes VALUES('fixture_scope','alice',?,1,'ready','2026-10-15T12:00:00Z')").run(f.room.id);
    const insertMemory = db.prepare('INSERT INTO vcp_memory_notes VALUES(?,?,?,\'fixture_scope\',?,?)');
    const insertSource = db.prepare('INSERT INTO vcp_note_sources VALUES(?,?,1,?)');
    db.transaction(() => {
        for (let index = 0; index < pressureCount; index++) {
            const source = 'source_' + index, memory = 'memory_' + index;
            insertMessage.run(source, f.room.id, '压力数据' + index);
            insertMemory.run(memory, 'alice', f.room.id, memory, JSON.stringify({ id: memory, companionId: 'alice', scopeId: 'fixture_scope', sourceConversationId: f.room.id,
                content: '日记' + index, tags: [], sources: [{ messageId: source, conversationId: f.room.id, authorId: 'user', sequence: index + 1, revision: 1, checksum: 'fixture', createdAt: '2026-10-15T12:00:00Z' }],
                sourceSequence: index + 1, version: 1, captureMethod: 'automatic', status: 'indexed', origin: 'companion', createdAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z' }));
            insertSource.run(memory, source, 'fixture');
        }
    }).immediate();
    db.close();
    console.log(JSON.stringify({ resetFixture: { stage: 'seeded', messages: pressureCount, journals: pressureCount, elapsedMs: performance.now() - fixtureStarted } }));
    const openAt = performance.now();
    let store = open(f.file);
    console.log(JSON.stringify({ resetFixture: { stage: 'reopened', elapsedMs: performance.now() - openAt } }));
    const beginAt = performance.now();
    const job = store.request({ type: 'companion.reset', id: 'alice', scope: 'all' }).reset!;
    const beginMs = performance.now() - beginAt;
    store.request({ type: 'companion.reset.cleanup', id: 'alice', jobId: job.id });
    let maxBatchMs = 0, maxPhase = '', batches = 0;
    const timings: number[] = [], started = performance.now();
    const reportedPhases = new Set<string>();
    while (store.request({ type: 'companion.reset.status', id: 'alice' }).reset!.status !== 'completed') {
        const phase = store.request({ type: 'companion.reset.status', id: 'alice' }).reset!.phase, before = performance.now();
        if (!reportedPhases.has(phase)) { reportedPhases.add(phase); console.log(JSON.stringify({ resetFixture: { stage: phase, batches, elapsedMs: performance.now() - started } })); }
        await store.advanceReset();
        const duration = performance.now() - before;
        timings.push(duration);
        if (duration > maxBatchMs) {
            maxBatchMs = duration;
            maxPhase = phase;
        }
        batches++;
        if (batches % 1000 === 0) console.log(JSON.stringify({ resetFixture: { stage: phase, batches, elapsedMs: performance.now() - started } }));
        const current = store.request({ type: 'companion.reset.status', id: 'alice' }).reset!;
        if (current.status === 'failed')
            throw new Error(current.phase + ': ' + current.error);
        if (batches === 25) {
            close(store);
            store = open(f.file);
            expect(store.request({ type: 'companion.reset.status', id: 'alice' }).reset!.id).toBe(job.id);
        }
        if (batches > 20000)
            throw new Error('Reset batch loop did not finish.');
    }
    timings.sort((a, b) => a - b);
    const report = { messages: pressureCount, journals: pressureCount, beginMs, maxBatchMs, maxPhase, p95BatchMs: timings[Math.floor(timings.length * .95)], p99BatchMs: timings[Math.floor(timings.length * .99)], totalMs: performance.now() - started, batches, restarted: true, renderer: false, gpu: false };
    console.log(JSON.stringify({ resetBenchmark: report }));
    mkdirSync('.tools/test-output/companions', { recursive: true });
    writeFileSync('.tools/test-output/companions/verified-companion-reset-pressure.json', JSON.stringify(report, null, 2) + '\n');
    expect(beginMs).toBeLessThan(500);
    expect(maxBatchMs).toBeLessThan(1000);
    expect(store.request({ type: 'messages', conversationId: f.room.id }).messages).toEqual([]);
    expect(store.listMemory('alice')).toEqual([]);
}, 240000);
