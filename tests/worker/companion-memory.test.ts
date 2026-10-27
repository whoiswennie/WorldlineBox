import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import type { CompanionMessage } from '../../src/shared/companions';
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真', model: '', avatar: 'sister', proactive: false, active: true }));
const stores = new Set<CompanionsStore>(), folders: string[] = [];
function open(filename: string) { const store = new CompanionsStore(filename, seeds); stores.add(store); return store; }
function fixture() { const folder = mkdtempSync(path.join(tmpdir(), 'vcp-journal-ledger-')); folders.push(folder); const filename = path.join(folder, 'companions.db'), store = open(filename); return { store, filename, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } }; }
function source(store: CompanionsStore, conversationId: string, content: string, authorId = 'user') { return store.appendMessage({ conversationId, content, authorId }); }
function candidate(message: CompanionMessage, patch: Partial<CompanionMemoryCandidate> = {}): CompanionMemoryCandidate { return { content: message.content, tags: ['经历'], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }], ...patch }; }
function index(store: CompanionsStore) { for (let n = 0; n < 100; n++) {
    const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (!job)
        break;
    store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true, sourceFile: job.noteId + '.md' });
} }
function close(store: CompanionsStore) { store.close(); stores.delete(store); }
afterEach(() => { vi.useRealTimers(); for (const store of stores)
    store.close(); stores.clear(); for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true }); });
describe('VCP journal host ledger', () => {
    it('requeues the corrected tag wire-format failure on restart without reopening unrelated failures', () => {
        const f = fixture(), message = source(f.store, f.scope.conversationId, '我在坐标(10,13)看到餐桌。');
        f.store.request({ type: 'memory.record', ...f.scope, candidate: candidate(message, { tags: ['坐标(10,13)'] }) });
        const job = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
        close(f.store); const db = new Database(f.filename);
        db.prepare("UPDATE vcp_memory_outbox SET status='failed',attempts=8,error='Tags must be individual names without separators.' WHERE id=?").run(job.id); db.close();
        const reopened = open(f.filename), retry = reopened.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
        expect(retry.id).toBe(job.id); expect(retry.attempts).toBe(1);
        expect(retry.note?.tags).toEqual(['坐标(10,13)']);
    });
    it('creates source and delivery tables without a fact engine or a memory FTS index', () => { const { filename } = fixture(); const db = new Database(filename); try {
        const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
        }>;
        expect(names.map(row => row.name)).toEqual(expect.arrayContaining(['vcp_memory_notes', 'vcp_capture_jobs', 'vcp_memory_outbox', 'vcp_source_observers']));
        for (const old of ['memories', 'memory_records', 'memory_search', 'memory_tags', 'memory_relations'])
            expect(names.some(row => row.name === old)).toBe(false);
    }
    finally {
        db.close();
    } });
    it('atomically captures formal sources, batches delivery and resumes after restart', () => { const { store, filename, scope } = fixture(); const messages = Array.from({ length: 13 }, (_, i) => source(store, scope.conversationId, '正式消息' + i)); const job = store.request({ type: 'memory.jobs.claim', force: true }).memoryJob!; expect(job.sourceMessageIds).toEqual(messages.slice(0, 12).map(message => message.id)); store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] }); expect(() => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '不能提交', attachmentIds: ['missing'] })).toThrow(); close(store); const reopened = open(filename); expect(reopened.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus).toMatchObject({ pending: 1, completed: 12 }); expect(reopened.request({ type: 'memory.jobs.claim', force: true }).memoryJob?.sourceMessageIds).toEqual([messages[12]!.id]); });
    it('rejects invented evidence and rolls back the complete journal batch', () => { const { store, scope } = fixture(); const message = source(store, scope.conversationId, '今天一起在花园躲雨。'); const job = store.request({ type: 'memory.jobs.claim', force: true }).memoryJob!; expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [candidate(message), candidate(message, { content: '捏造', evidence: [{ sourceMessageId: message.id, quote: '并未说过' }] })] })).toThrow(); expect(store.request({ type: 'memory.browse', ...scope }).memoryPage?.items).toHaveLength(0); expect(store.request({ type: 'memory.outbox.claim' }).memoryOutbox).toBeUndefined(); });
    it('preserves tag order, journals idempotently and publishes only after VCP index acknowledgement', () => { const { store, scope } = fixture(); const message = source(store, scope.conversationId, '花园里的雨和借伞约定。'); const draft = candidate(message, { tags: ['花园', '雨', '借伞', '归还约定'] }); const note = store.request({ type: 'memory.record', ...scope, candidate: draft }).memories![0]!; expect(note.tags).toEqual(draft.tags); expect(note.status).toBe('queued'); expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot?.notes).toHaveLength(0); expect(store.request({ type: 'memory.record', ...scope, candidate: draft }).memories?.[0]?.id).toBe(note.id); const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!; expect(() => store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: false })).toThrow('索引'); store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot?.notes.map(note => note.id)).toEqual([note.id]); expect(store.request({ type: 'memory.outbox.claim' }).memoryOutbox).toBeUndefined(); });
    it('does not provide a hidden text, tag or raw-history retrieval fallback', () => { const { store, scope } = fixture(); expect(() => store.request({ type: 'memory.search', ...scope, query: '雨' })).toThrow('VCP'); expect(() => store.request({ type: 'memory.browse', ...scope, query: '雨' })).toThrow('VCP'); });
    it('shares one cognitive snapshot across the same owners entrances while preserving other owners and source cutoffs', () => {
        const { store, scope } = fixture();
        const secret = source(store, scope.conversationId, '这是我已见过的私聊经历');
        const privateNote = store.request({ type: 'memory.record', ...scope, candidate: candidate(secret) }).memories![0]!;
        const group = store.createConversation('群', ['alice', 'bob']);
        const common = source(store, group.id, '这是群里的经历');
        const groupScope = { companionId: 'alice', conversationId: group.id };
        const groupNote = store.request({ type: 'memory.record', ...groupScope, candidate: candidate(common) }).memories![0]!;
        const bobNote = store.request({ type: 'memory.record', companionId: 'bob', conversationId: group.id, candidate: candidate(common) }).memories![0]!;
        index(store);
        expect(privateNote.scopeId).not.toBe(groupNote.scopeId); // Original source containers remain provenance.
        expect(groupNote.scopeId).not.toBe(bobNote.scopeId);
        const privateView = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
        const groupView = store.request({ type: 'memory.snapshot', ...groupScope }).memorySnapshot!;
        expect(groupView.notes.map(note => note.id).sort()).toEqual([privateNote.id, groupNote.id].sort());
        expect(groupView.revision).toBe(privateView.revision);
        const historical = store.request({ type: 'memory.snapshot', ...groupScope, beforeSequence: secret.sequence }).memorySnapshot!;
        expect(historical.notes.map(note => note.id)).toEqual([privateNote.id]);
        expect(historical.scopeId).not.toBe(privateView.scopeId);
        expect(store.request({ type: 'memory.read', ...groupScope, id: privateNote.id }).memoryRead!.memory.id).toBe(privateNote.id);
        expect(() => store.request({ type: 'memory.read', companionId: 'bob', conversationId: group.id, id: privateNote.id })).toThrow();
        expect(() => store.request({ type: 'memory.read', companionId: 'bob', conversationId: group.id, id: groupNote.id })).toThrow();
    });
    it('requires all contributing sources to belong to one visibility domain', () => { const { store, scope } = fixture(); const privateSource = source(store, scope.conversationId, '私人'); const group = store.createConversation('群', ['alice']); const groupSource = source(store, group.id, '群公开'); expect(() => store.request({ type: 'memory.record', ...scope, candidate: { content: '混合', sourceMessageIds: [privateSource.id, groupSource.id], evidence: [{ sourceMessageId: privateSource.id, quote: privateSource.content }, { sourceMessageId: groupSource.id, quote: groupSource.content }] } })).toThrow('可见域'); });
    it('invalidates a snapshot immediately when a contributing source changes', () => { const { store, scope, filename } = fixture(); const message = source(store, scope.conversationId, '原来的约定'); store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }); index(store); const before = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!; const db = new Database(filename); try {
        db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
        db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
        db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('已经更改的约定', message.id);
    }
    finally {
        db.close();
    } const after = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!; expect(after.notes).toHaveLength(0); expect(after.scopeId).not.toBe(before.scopeId); });
    it('withdraws sources and derived journals before forgetting native indexes', () => { const { store, scope } = fixture(); const message = source(store, scope.conversationId, '旧地址在河边。'); const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }).memories![0]!; const derived = store.request({ type: 'memory.record', ...scope, candidate: candidate(message, { content: '本月经历概览', relatedMemoryIds: [note.id] }) }).memories![0]!; index(store); const request = source(store, scope.conversationId, '忘记旧地址'); store.request({ type: 'memory.forget', ...scope, id: note.id, requestMessageId: request.id }); expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot?.notes).toHaveLength(0); expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [message.id] }).memorySources).toHaveLength(0); expect(() => store.request({ type: 'memory.read', ...scope, id: derived.id })).toThrow(); expect(store.request({ type: 'memory.outbox.claim' }).memoryOutbox?.operation).toBe('forget'); expect(() => store.request({ type: 'memory.record', ...scope, candidate: candidate(message) })).toThrow(); });
    it('blocks future captures for a persistent user prohibition without old fact keys', () => { const { store, scope } = fixture(); const request = source(store, scope.conversationId, '以后不要记录家庭地址'); store.request({ type: 'memory.forget', ...scope, tag: '家庭地址', persistent: true, requestMessageId: request.id }); const message = source(store, scope.conversationId, '搬到另一个地方了'); expect(() => store.request({ type: 'memory.record', ...scope, candidate: candidate(message, { tags: ['家庭地址'] }) })).toThrow('禁止'); });
    it('serializes native effects within a scope and retries them after lease expiration', () => { vi.useFakeTimers({ toFake: ['Date'] }); const { store, scope } = fixture(); for (const content of ['雨', '伞']) {
        const message = source(store, scope.conversationId, content);
        store.request({ type: 'memory.record', ...scope, candidate: candidate(message) });
    } const first = store.request({ type: 'memory.outbox.claim', leaseMs: 1000 }).memoryOutbox!; expect(store.request({ type: 'memory.outbox.claim' }).memoryOutbox).toBeUndefined(); vi.setSystemTime(Date.now() + 1001); const retried = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!; expect(retried.id).toBe(first.id); expect(retried.leaseToken).not.toBe(first.leaseToken); expect(() => store.request({ type: 'memory.outbox.complete', id: first.id, leaseToken: first.leaseToken, indexed: true })).toThrow(); });
    it('does not publish a stale native acknowledgement over a newer journal revision', () => { const { store, scope } = fixture(); const message = source(store, scope.conversationId, '我们的经历'); const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }).memories![0]!; const old = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!; store.request({ type: 'memory.revise', ...scope, id: note.id, expectedVersion: note.version, candidate: candidate(message, { content: '更详细的经历' }) }); store.request({ type: 'memory.outbox.complete', id: old.id, leaseToken: old.leaseToken, indexed: true }); expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot?.notes).toHaveLength(0); index(store); expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot?.notes[0]?.content).toBe('更详细的经历'); });
    it('records manual form input as explicit provenance rather than a fabricated chat turn', () => { const { store, scope } = fixture(); const note = store.saveMemory({ ...scope, content: '手工写下的日记', tags: ['手写'] }); expect(note.sources[0]?.sourceType).toBe('manual_input'); const receipt = store.getMessage(note.sourceMessageId!); expect(receipt.kind).toBe('notice'); expect(receipt.memoryEvidenceOnly).toBe(true); expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.pending).toBe(0); });
    it('requeues VCP ingestion for index repair without creating a memory FTS index', () => { const { store, scope } = fixture(); const message = source(store, scope.conversationId, '用于重建的经历'); const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }).memories![0]!; index(store); expect(store.request({ type: 'memory.index.rebuild', companionId: 'alice' }).rebuiltCount).toBe(1); expect(store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot?.notes).toHaveLength(0); const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!; expect(job.noteId).toBe(note.id); expect(job.operation).toBe('remember'); });
});
it('recalls the same owners indexed identity in peer and world entrances without sharing another owners corpus', () => {
    const { store, scope } = fixture();
    const introduction = source(store, scope.conversationId, '你好，我叫天幻呀。');
    const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(introduction, { tags: ['玩家', '姓名'] }) }).memories![0]!;
    const peer = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    const peerScope = { companionId: 'alice', conversationId: peer.id }, worldScope = { companionId: 'alice', conversationId: 'world_alice' };
    // Saving text and acknowledging its native index are distinct milestones.
    expect(store.request({ type: 'memory.snapshot', ...peerScope }).memorySnapshot?.notes).toEqual([]);
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.pendingIndex).toBe(1);
    index(store);
    for (const entrance of [scope, peerScope, worldScope]) {
        expect(store.request({ type: 'memory.snapshot', ...entrance }).memorySnapshot?.notes.map(note => note.id)).toEqual([note.id]);
        expect(store.request({ type: 'memory.sources.filter', ...entrance, ids: [introduction.id] }).memorySources?.map(message => message.id)).toEqual([introduction.id]);
    }
    expect(store.request({ type: 'memory.snapshot', companionId: 'bob', conversationId: peer.id }).memorySnapshot?.notes).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: peer.id, ids: [introduction.id] }).memorySources).toEqual([]);
    store.request({ type: 'memory.forget', ...peerScope, id: note.id });
    for (const entrance of [scope, peerScope, worldScope]) {
        expect(store.request({ type: 'memory.snapshot', ...entrance }).memorySnapshot?.notes).toEqual([]);
        expect(store.request({ type: 'memory.sources.filter', ...entrance, ids: [introduction.id] }).memorySources).toEqual([]);
    }
});
it('uses historical observer receipts rather than todays membership when recalling group experiences', () => {
    const { store, scope } = fixture();
    const group = store.createConversation('历史经历', ['alice']);
    const witnessed = source(store, group.id, '当时只有alice参与这次读书讨论。');
    const note = store.request({ type: 'memory.record', companionId: 'alice', conversationId: group.id, candidate: candidate(witnessed) }).memories![0]!;
    index(store);
    store.updateConversation(group.id, { memberIds: ['bob'] });
    const later = source(store, group.id, 'alice离开后才产生的讨论。');
    expect(store.request({ type: 'memory.read', ...scope, id: note.id }).memoryRead?.memory.id).toBe(note.id);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [later.id] }).memorySources).toEqual([]);
    const bob = { companionId: 'bob', conversationId: group.id };
    expect(store.request({ type: 'memory.sources.filter', ...bob, ids: [witnessed.id] }).memorySources).toEqual([]);
    expect(() => store.request({ type: 'memory.record', ...bob, candidate: candidate(witnessed) })).toThrow('来源不可见');
    expect(store.request({ type: 'memory.sources.filter', ...bob, ids: [witnessed.id] }).memorySources).toEqual([]);
});
it('persists idempotent journal edit receipts across a crash before the activity acknowledgement', () => {
    const { store, scope, filename } = fixture();
    const message = source(store, scope.conversationId, '一份真实的经历');
    const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(message), operationId: 'activity_record' }).memories![0]!;
    index(store);
    const command = { type: 'memory.organize' as const, ...scope, ids: [note.id], tags: ['花园', '雨'], operationId: 'activity_organize' };
    const first = store.request(command).memories![0]!;
    close(store); const reopened = open(filename);
    const repeated = reopened.request(command).memories![0]!;
    expect(repeated.version).toBe(first.version);
    expect(repeated.tags).toEqual(['花园', '雨']);
    expect(() => reopened.request({ ...command, tags: ['其它内容'] })).toThrow('不同请求');
    reopened.request({ type: 'memory.forget', ...scope, id: note.id });
    expect(() => reopened.request(command)).toThrow('已变化');
});
it('rejects an old journal revision retry after its sources change', () => {
    const { store, scope } = fixture();
    const message = source(store, scope.conversationId, '共同经历');
    const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }).memories![0]!;
    const command = { type: 'memory.revise' as const, ...scope, id: note.id, expectedVersion: note.version, candidate: candidate(message, { content: '共同经历的详细回顾' }), operationId: 'activity_revise' };
    const revised = store.request(command).memories![0]!;
    expect(store.request(command).memories![0]?.version).toBe(revised.version);
    expect(() => store.request({ ...command, companionId: 'bob' })).toThrow();
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [message.id] });
    expect(() => store.request(command)).toThrow();
});
it('places an observation journal in its actual group audience rather than the private receipt container', () => {
    const { store, scope } = fixture();
    const group = store.createConversation('公开目录查询', ['alice', 'bob']);
    const groupScope = { companionId: 'alice', conversationId: group.id };
    const queried = store.request({ type: 'memory.world_query', ...groupScope, category: 'contacts', query: 'bob' });
    const receipt = queried.memorySources![0]!;
    const note = store.request({ type: 'memory.record', ...groupScope, candidate: candidate(receipt) }).memories![0]!;
    expect(note.sourceConversationId).toBe(group.id);
    index(store);
    expect(store.request({ type: 'memory.snapshot', ...groupScope }).memorySnapshot?.notes.map(note => note.id)).toEqual([note.id]);
    const other = store.createConversation('其它群聊', ['alice']);
    expect(store.request({ type: 'memory.snapshot', companionId: 'alice', conversationId: other.id }).memorySnapshot?.notes.map(note => note.id)).toEqual([note.id]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [receipt.id] }).memorySources).toHaveLength(1);
});
it('keeps a one-time topic forget distinct from a persistent prohibition', () => {
    const { store, scope } = fixture();
    const old = source(store, scope.conversationId, '旧的联系地址');
    store.request({ type: 'memory.record', ...scope, candidate: candidate(old, { tags: ['联系地址'] }) });
    const request = source(store, scope.conversationId, '忘记上次的联系地址');
    store.request({ type: 'memory.forget', ...scope, tag: '联系地址', persistent: false, requestMessageId: request.id });
    const fresh = source(store, scope.conversationId, '这是新的联系地址');
    expect(store.request({ type: 'memory.record', ...scope, candidate: candidate(fresh, { tags: ['联系地址'] }) }).memories?.[0]?.status).toBe('queued');
});
it('applies an explicit private persistent prohibition to the same resident in another domain', () => {
    const { store, scope } = fixture();
    const request = source(store, scope.conversationId, '以后不要替我保存家庭住址');
    store.request({ type: 'memory.forget', ...scope, tag: '家庭住址', persistent: true, requestMessageId: request.id });
    const group = store.createConversation('群聊', ['alice', 'bob']);
    const message = source(store, group.id, '这里提供另一个地名');
    expect(() => store.request({ type: 'memory.record', companionId: 'alice', conversationId: group.id, candidate: candidate(message, { tags: ['家庭住址'] }) })).toThrow('禁止');
    expect(store.request({ type: 'memory.record', companionId: 'bob', conversationId: group.id, candidate: candidate(message, { tags: ['家庭住址'] }) }).memories).toHaveLength(1);
});
it('exposes only the authorized semantic prohibition inputs while keeping one-time cutoffs distinct', () => {
    const { store, scope, filename } = fixture();
    const privateRequest = source(store, scope.conversationId, 'PRIVATE_REQUEST_BODY_DO_NOT_EXPOSE');
    store.request({ type: 'memory.forget', ...scope, tag: '私人话题', persistent: true, requestMessageId: privateRequest.id });
    const group = store.createConversation('共同经历', ['alice', 'bob']), other = store.createConversation('另一个群', ['alice']);
    const groupScope = { companionId: 'alice', conversationId: group.id };
    const groupRequest = source(store, group.id, 'GROUP_REQUEST_BODY_DO_NOT_EXPOSE');
    store.request({ type: 'memory.forget', ...groupScope, tag: '旧约定', persistent: false, requestMessageId: groupRequest.id });
    const groupRules = store.request({ type: 'memory.prohibitions', ...groupScope }).memoryProhibitions!;
    expect(groupRules).toHaveLength(2);
    expect(groupRules).toEqual(expect.arrayContaining([
        { id: expect.any(String), tags: ['私人话题'], conversationId: '*', persistent: true, throughSequence: privateRequest.sequence },
        { id: expect.any(String), tags: ['旧约定'], conversationId: group.id, persistent: false, throughSequence: groupRequest.sequence },
    ]));
    expect(JSON.stringify(groupRules)).not.toContain('REQUEST_BODY');
    expect(store.request({ type: 'memory.prohibitions', companionId: 'alice', conversationId: other.id }).memoryProhibitions?.map(rule => rule.tags)).toEqual([['私人话题']]);
    expect(store.request({ type: 'memory.prohibitions', companionId: 'bob', conversationId: group.id }).memoryProhibitions).toEqual([]);
    expect(() => store.request({ type: 'memory.prohibitions', companionId: 'bob', conversationId: scope.conversationId })).toThrow('成员');
    close(store); const reopened = open(filename);
    expect(reopened.request({ type: 'memory.prohibitions', ...groupScope }).memoryProhibitions).toEqual(groupRules);
});
it('releases a group topic for future input without reviving old forgotten or suppressed sources across restart', () => {
    const { store, filename } = fixture();
    const group = store.createConversation('主题管理', ['alice', 'bob']), other = store.createConversation('其它群', ['alice']);
    const scope = { companionId: 'alice', conversationId: group.id };
    const original = source(store, group.id, '我偏爱早晨喝咖啡。');
    const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(original, { tags: ['饮料偏好'] }) }).memories![0]!;
    const request = source(store, group.id, '请忘掉我的饮料偏好，以后不要再记录。');
    store.request({ type: 'memory.forget', ...scope, tag: '饮料偏好', persistent: true, requestMessageId: request.id });
    const suppressed = source(store, group.id, '饮料偏好：旧的额外输入。');
    const policy = store.request({ type: 'memory.policy.list', companionId: 'alice' }).memoryPolicies!.find(rule => rule.reason === 'persistent-topic')!;
    expect(policy).toMatchObject({ conversationId: group.id, tags: ['饮料偏好'], blocked: true, requestSnippet: '' });
    expect(store.request({ type: 'memory.prohibitions', companionId: 'alice', conversationId: other.id }).memoryProhibitions).toEqual([]);
    expect(() => store.request({ type: 'memory.policy.release', companionId: 'bob', id: policy.id })).toThrow('不属于');
    const released = store.request({ type: 'memory.policy.release', companionId: 'alice', id: policy.id });
    expect(released.memoryPolicies?.find(rule => rule.id === policy.id)).toMatchObject({ blocked: false, releasedAt: expect.any(String) });
    expect(store.request({ type: 'memory.policy.release', companionId: 'alice', id: policy.id }).ok).toBe(true);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [original.id, suppressed.id] }).memorySources).toEqual([]);
    const fresh = source(store, group.id, '饮料偏好：我明确提供新的茶饮信息。');
    expect(store.request({ type: 'memory.record', ...scope, candidate: candidate(fresh, { tags: ['饮料偏好'] }) }).memories).toHaveLength(1);
    expect(() => store.request({ type: 'memory.read', ...scope, id: note.id })).toThrow();
    close(store); const reopened = open(filename);
    expect(reopened.request({ type: 'memory.sources.filter', ...scope, ids: [original.id, suppressed.id] }).memorySources).toEqual([]);
    expect(reopened.request({ type: 'memory.prohibitions', ...scope }).memoryProhibitions).toMatchObject([{ persistent: false, throughSequence: suppressed.sequence }]);
});
it('rejects stale semantic policy checks atomically for every journal mutation and a capture batch', () => {
    const { store, scope, filename } = fixture();
    const message = source(store, scope.conversationId, '周末散步的普通经历。');
    const draft = candidate(message), note = store.request({ type: 'memory.record', ...scope, candidate: draft }).memories![0]!;
    const pending = source(store, scope.conversationId, '尚未编码且需要新规则检查的另一段经历。');
    const job = store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!;
    const before = store.request({ type: 'memory.prohibitions', ...scope }).memoryProhibitionRevision!;
    const request = source(store, scope.conversationId, '今后不要记录家庭住址。');
    store.request({ type: 'memory.forget', ...scope, tag: '家庭住址', persistent: true, requestMessageId: request.id });
    const after = store.request({ type: 'memory.prohibitions', ...scope }).memoryProhibitionRevision!;
    expect(after).not.toBe(before);
    expect(store.request({ type: 'memory.prohibitions', ...scope, beforeSequence: message.sequence }).memoryProhibitionRevision).toBe(after);
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...draft, content: '未经新规则复核的日记' }, expectedProhibitionRevision: before })).toThrow('禁记规则');
    expect(() => store.request({ type: 'memory.revise', ...scope, id: note.id, expectedVersion: note.version, candidate: { ...draft, content: '未经新规则复核的修订' }, expectedProhibitionRevision: before })).toThrow('禁记规则');
    expect(() => store.request({ type: 'memory.organize', ...scope, ids: [note.id], tags: ['新标签'], expectedProhibitionRevision: before })).toThrow('禁记规则');
    expect(() => store.request({ type: 'memory.save', memory: { ...scope, content: '不能生成手工输入副作用', expectedProhibitionRevision: before, operationId: 'stale_manual' } })).toThrow('禁记规则');
    expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [candidate(pending)], expectedProhibitionRevision: before })).toThrow('禁记规则');
    const db = new Database(filename);
    try { expect(db.prepare("SELECT 1 FROM messages WHERE content='不能生成手工输入副作用'").get()).toBeUndefined(); } finally { db.close(); }
    expect(store.request({ type: 'memory.read', ...scope, id: note.id }).memoryRead?.memory).toMatchObject({ version: note.version, tags: note.tags });
    expect(store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [candidate(pending)], expectedProhibitionRevision: after }).memories?.[0]?.sources.some(item => item.messageId === pending.id)).toBe(true);
    const operation = { type: 'memory.organize' as const, ...scope, ids: [note.id], tags: ['已核对'], expectedProhibitionRevision: after, operationId: 'policy_retry' };
    const organized = store.request(operation).memories![0]!;
    const policy = store.request({ type: 'memory.policy.list', companionId: 'alice' }).memoryPolicies!.find(rule => rule.reason === 'persistent-topic')!;
    store.request({ type: 'memory.policy.release', companionId: 'alice', id: policy.id });
    expect(() => store.request(operation)).toThrow('禁记规则');
    const current = store.request({ type: 'memory.prohibitions', ...scope }).memoryProhibitionRevision!;
    expect(store.request({ ...operation, expectedProhibitionRevision: current }).memories?.[0]?.version).toBe(organized.version);
});
it('resolves semantic policy checks from actual note and observation domains without revealing another audience', () => {
    const { store, scope } = fixture(), group = store.createConversation('实际受众', ['alice', 'bob']);
    const groupScope = { companionId: 'alice', conversationId: group.id };
    const request = source(store, group.id, '不要记录隐藏主题。');
    store.request({ type: 'memory.forget', ...groupScope, tag: '隐藏主题', persistent: true, requestMessageId: request.id });
    const observation = store.request({ type: 'memory.world_query', ...groupScope, category: 'contacts', query: 'bob' }).memorySources![0]!;
    const policy = store.request({ type: 'memory.prohibitions', ...scope, sourceMessageIds: [observation.id] });
    expect(policy.memoryProhibitionConversationId).toBe(group.id);
    expect(policy.memoryProhibitions).toMatchObject([{ tags: ['隐藏主题'], conversationId: group.id }]);
    const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(observation), expectedProhibitionRevision: policy.memoryProhibitionRevision }).memories![0]!;
    const byNote = store.request({ type: 'memory.prohibitions', ...scope, noteId: note.id });
    expect(byNote.memoryProhibitionRevision).toBe(policy.memoryProhibitionRevision);
    expect(() => store.request({ type: 'memory.prohibitions', companionId: 'bob', conversationId: group.id, noteId: note.id })).toThrow('不可见');
    const other = store.createConversation('不共享受众', ['alice']);
    expect(store.request({ type: 'memory.prohibitions', companionId: 'alice', conversationId: other.id, sourceMessageIds: [observation.id] }).memoryProhibitionRevision).toBe(policy.memoryProhibitionRevision);
});
it('preserves the exact user prohibition receipt for its completion reply while skipping automatic capture', () => {
    const { store, scope } = fixture();
    const old = source(store, scope.conversationId, '我喜欢喝浓咖啡');
    store.request({ type: 'memory.record', ...scope, candidate: candidate(old, { tags: ['饮料偏好'] }) });
    const request = source(store, scope.conversationId, '请忘掉我的饮料偏好，以后不要再记录。');
    store.request({ type: 'memory.forget', ...scope, tag: '饮料偏好', persistent: true, requestMessageId: request.id });
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [request.id] }).memorySources?.map(message => message.id)).toEqual([request.id]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [old.id] }).memorySources).toEqual([]);
    const different = source(store, scope.conversationId, '这条饮料偏好不是管理指令。');
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [different.id] }).memorySources).toEqual([]);
    const captured: string[] = [];
    for (let n = 0; n < 10; n++) {
        const job = store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob;
        if (!job) break;
        captured.push(...job.sourceMessageIds);
        store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
    }
    expect(captured).not.toContain(request.id);
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [request.id] });
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [request.id] }).memorySources).toEqual([]);
});
it('keeps the same owners evidence available in its world cognition including a legacy private world container', () => {
    const { store, scope, filename } = fixture();
    const secret = source(store, scope.conversationId, 'PLAYER_PRIVATE_DO_NOT_SHARE');
    store.request({ type: 'memory.record', ...scope, candidate: candidate(secret) });
    const observation = store.request({ type: 'memory.world_query', ...scope, category: 'contacts', query: 'bob' }).memorySources![0]!;
    store.request({ type: 'memory.record', ...scope, candidate: candidate(observation) });
    index(store);
    const worldScope = { companionId: 'alice', conversationId: 'world_alice' };
    expect(store.request({ type: 'memory.sources.filter', ...worldScope, ids: [secret.id, observation.id] }).memorySources).toHaveLength(2);
    expect(store.request({ type: 'memory.snapshot', ...worldScope }).memorySnapshot?.notes).toHaveLength(2);
    const db = new Database(filename);
    try {
        db.prepare("UPDATE conversations SET kind='group',private_companion_id=NULL WHERE id=?").run(scope.conversationId);
        db.prepare("UPDATE conversations SET kind='private',private_companion_id='alice' WHERE id='world_alice'").run();
    } finally { db.close(); }
    expect(store.request({ type: 'memory.sources.filter', ...worldScope, ids: [secret.id, observation.id] }).memorySources).toHaveLength(2);
    expect(store.request({ type: 'memory.snapshot', ...worldScope }).memorySnapshot?.notes).toHaveLength(2);
});
it('forgets every historical source of a manually revised journal across restart', () => {
    const { store, scope, filename } = fixture();
    const original = source(store, scope.conversationId, '最初的共同经历');
    const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(original) }).memories![0]!;
    const first = store.saveMemory({ ...scope, id: note.id, expectedVersion: note.version, sourceMessageId: original.id, content: '用户第一次修正' });
    const second = store.saveMemory({ ...scope, id: note.id, expectedVersion: first.version, sourceMessageId: first.sourceMessageId, content: '用户再次修正' });
    expect(second.sources.some(source => source.messageId === original.id)).toBe(false);
    store.request({ type: 'memory.forget', ...scope, id: note.id });
    close(store);
    const reopened = open(filename);
    expect(reopened.request({ type: 'memory.sources.filter', ...scope, ids: [original.id, first.sourceMessageId!, second.sourceMessageId!] }).memorySources).toEqual([]);
    expect(() => reopened.request({ type: 'memory.record', ...scope, candidate: candidate(original) })).toThrow('撤回');
});
it('preserves a full 65536-character manual diary with an auditable source checksum', () => {
    const { store, scope } = fixture();
    const content = '手工写下完整的生活日记。'.repeat(6000).slice(0, 65536);
    const note = store.saveMemory({ ...scope, content });
    expect(note.content).toBe(content);
    expect(store.getMessage(note.sourceMessageId!).content).toBe(content);
    expect(note.sources[0]).toMatchObject({ sourceType: 'manual_input', checksum: expect.any(String) });
    expect(store.request({ type: 'memory.read', ...scope, id: note.id }).memoryRead?.sources[0]?.content).toBe(content);
});
