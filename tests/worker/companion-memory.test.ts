import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import type { CompanionMessage } from '../../src/shared/companions';

const seeds: CompanionSeed[] = [
  { id: 'alice', name: '伙伴甲', description: '', persona: '认真', model: '', avatar: 'sister', proactive: false },
  { id: 'bob', name: '伙伴乙', description: '', persona: '认真', model: '', avatar: 'sister', proactive: false },
];
const stores = new Set<CompanionsStore>(), folders: string[] = [];
function open(filename: string) { const store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store); return store; }
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'companion-memory-')); folders.push(folder);
  const filename = path.join(folder, 'companions.db'), store = open(filename);
  const conversationId = store.openPrivate('alice').id;
  return { store, filename, scope: { companionId: 'alice', conversationId } };
}
function source(store: CompanionsStore, conversationId: string, content: string, authorId = 'user') { return store.appendMessage({ conversationId, content, authorId }); }
function candidate(message: CompanionMessage, patch: Partial<CompanionMemoryCandidate> = {}): CompanionMemoryCandidate {
  return { content: message.content, kind: 'fact', subject: 'user', factKey: 'birthday', value: message.content,
    sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }], ...patch };
}
function close(store: CompanionsStore) { store.close(); stores.delete(store); }
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('autonomous companion memory authority', () => {
  it('atomically appends formal sources and batches durable extraction across restart', () => {
    const { store, filename, scope } = fixture();
    const messages = Array.from({ length: 9 }, (_, i) => source(store, scope.conversationId, `正式消息${i}`));
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.pending).toBe(9);
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    expect(job.sourceMessageIds).toEqual(messages.slice(0, 8).map(message => message.id));
    expect(job.throughSequence).toBe(messages[7]!.sequence);
    store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [] });
    expect(() => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '不能提交', attachmentIds: ['missing'] })).toThrow();
    close(store);
    const reopened = open(filename);
    expect(reopened.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus).toMatchObject({ pending: 1, completed: 8 });
    expect(reopened.request({ type: 'memory.jobs.claim' }).memoryJob?.sourceMessageIds).toEqual([messages[8]!.id]);
  });

  it('rolls back the entire candidate batch when one quote or source is invalid', () => {
    const { store, scope } = fixture();
    const message = source(store, scope.conversationId, '我的生日是五月三日。');
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [candidate(message), candidate(message, { content: '捏造', factKey: 'name', evidence: [{ sourceMessageId: message.id, quote: '我叫张三' }] })] })).toThrow('原文');
    expect(store.listMemory('alice')).toEqual([]);
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.running).toBe(1);
    store.request({ type: 'memory.jobs.fail', id: job.id, leaseToken: job.leaseToken, error: '引用无效', retryAfterMs: 0 });
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus).toMatchObject({ failed: 1, lastError: '引用无效' });
    store.request({ type: 'memory.jobs.retry', companionId: 'alice' });
    expect(store.request({ type: 'memory.jobs.claim' }).memoryJob?.attempts).toBe(1);
  });

  it('requires evidence per source and keeps companion guesses out of user facts', () => {
    const { store, scope } = fixture();
    const user = source(store, scope.conversationId, '五月三日生日'), assistant = source(store, scope.conversationId, '你应该是五月四日生日', 'alice');
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: candidate(user, { evidence: [] }) })).toThrow('每个');
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: candidate(assistant) })).toThrow('伙伴发言');
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: candidate(assistant, { kind: 'reflection', epistemicStatus: 'subjective', subject: 'bob' }) })).toThrow('当前伙伴');
    const result = store.request({ type: 'memory.record', ...scope, candidate: candidate(assistant, { kind: 'hypothesis', epistemicStatus: 'hypothesis' }) });
    expect(result.memories?.[0]?.status).toBe('conflict');
    expect(store.request({ type: 'memory.search', ...scope, query: '生日' }).memoryPage?.items).toEqual([]);
  });

  it('merges repeated facts with multiple sources and never exposes future support to an old request', () => {
    const { store, filename, scope } = fixture();
    const first = source(store, scope.conversationId, '生日是五月三日');
    const initial = store.request({ type: 'memory.record', ...scope, candidate: candidate(first, { value: '05-03' }) }).memories![0]!;
    const second = source(store, scope.conversationId, '生日仍然是五月三日');
    const merged = store.request({ type: 'memory.record', ...scope, candidate: candidate(second, { value: '05-03' }) }).memories![0]!;
    expect(merged.id).toBe(initial.id); expect(merged.sources).toHaveLength(2);
    close(store);
    const reopened = open(filename);
    const old = reopened.request({ type: 'memory.search', ...scope, subject: 'user', factKey: 'birthday', beforeSequence: first.sequence }).memoryPage!.items[0]!.memory;
    expect(old.sources?.map(item => item.messageId)).toEqual([first.id]);
    expect(reopened.listMemory('alice')).toHaveLength(1);
  });

  it('preserves current and historical facts when an older extraction arrives after correction', () => {
    const { store, scope } = fixture();
    const older = source(store, scope.conversationId, '我喜欢咖啡'), newer = source(store, scope.conversationId, '现在不喜欢咖啡了');
    const current = store.request({ type: 'memory.record', ...scope, candidate: candidate(newer, { kind: 'preference', factKey: 'coffee', value: '不喜欢', polarity: 'negative' }) }).memories![0]!;
    const previous = store.request({ type: 'memory.record', ...scope, candidate: candidate(older, { kind: 'preference', factKey: 'coffee', value: '喜欢' }) }).memories![0]!;
    expect(previous.status).toBe('superseded');
    expect(store.request({ type: 'memory.search', ...scope, factKey: 'coffee' }).memoryPage!.items.map(item => item.memory.id)).toEqual([current.id]);
    expect(store.request({ type: 'memory.search', ...scope, factKey: 'coffee', beforeSequence: older.sequence }).memoryPage!.items.map(item => item.memory.id)).toEqual([previous.id]);
    expect(store.request({ type: 'memory.search', ...scope, factKey: 'coffee', includeHistory: true }).memoryPage!.items).toHaveLength(2);
    expect(() => store.request({ type: 'memory.revise', ...scope, id: current.id, expectedVersion: 2, candidate: candidate(newer) })).toThrow('版本冲突');
  });

  it('can return to a formerly superseded value without reviving its old version', () => {
    const { store, scope } = fixture();
    const one = source(store, scope.conversationId, '我住杭州'), two = source(store, scope.conversationId, '我搬去上海'), three = source(store, scope.conversationId, '我又回杭州了');
    const first = store.request({ type: 'memory.record', ...scope, candidate: candidate(one, { factKey: 'city', value: '杭州' }) }).memories![0]!;
    store.request({ type: 'memory.record', ...scope, candidate: candidate(two, { factKey: 'city', value: '上海' }) });
    const third = store.request({ type: 'memory.record', ...scope, candidate: candidate(three, { factKey: 'city', value: '杭州' }) }).memories![0]!;
    expect(third.id).not.toBe(first.id);
    expect(store.request({ type: 'memory.search', ...scope, factKey: 'city' }).memoryPage!.items.map(item => item.memory.id)).toEqual([third.id]);
  });

  it('recalls short Chinese names, aliases and exact old facts ahead of newer broad matches', () => {
    const { store, scope } = fixture();
    const old = source(store, scope.conversationId, '阿珂的生日是五月三日');
    const memory = store.request({ type: 'memory.record', ...scope, candidate: candidate(old, { subject: 'ake', tags: [{ name: '阿珂', type: 'person', aliases: ['小珂'] }] }) }).memories![0]!;
    for (let i = 0; i < 24; i++) { const message = source(store, scope.conversationId, `生日聚会准备的经历${i}`); store.request({ type: 'memory.record', ...scope, candidate: candidate(message, { kind: 'event', subject: 'user', factKey: undefined, value: undefined }) }); }
    expect(store.request({ type: 'memory.search', ...scope, subject: 'ake', factKey: 'birthday', query: '生日', limit: 1 }).memoryPage!.items[0]!.memory.id).toBe(memory.id);
    expect(store.request({ type: 'memory.search', ...scope, query: '小珂现在怎么样' }).memoryPage!.items.some(item => item.memory.id === memory.id)).toBe(true);
    expect(store.request({ type: 'memory.sources.search', ...scope, terms: ['阿珂'] }).memorySources?.[0]?.id).toBe(old.id);
    expect(() => store.request({ type: 'memory.search', ...scope, query: '" OR 1=1 --' })).not.toThrow();
  });

  it('paginates after source validation and preserves the supported relationship path', () => {
    const { store, scope } = fixture();
    const first = source(store, scope.conversationId, 'WorldlineBox项目进行中'), second = source(store, scope.conversationId, '这次开发让我想起共同设计的经历');
    const anchor = store.request({ type: 'memory.record', ...scope, candidate: candidate(first, { kind: 'event', factKey: undefined, value: undefined }) }).memories![0]!;
    const background = store.request({ type: 'memory.record', ...scope, candidate: candidate(second, { kind: 'event', factKey: undefined, value: undefined, relatedMemoryIds: [anchor.id] }) }).memories![0]!;
    const firstPage = store.request({ type: 'memory.search', ...scope, terms: ['WorldlineBox'], limit: 1 }).memoryPage!;
    expect(firstPage.items[0]!.memory.id).toBe(anchor.id); expect(firstPage.hasMore).toBe(true);
    const next = store.request({ type: 'memory.search', ...scope, terms: ['WorldlineBox'], limit: 1, cursor: firstPage.nextCursor }).memoryPage!;
    expect(next.items[0]!.memory.id).toBe(background.id); expect(next.items[0]!.path).toEqual([anchor.id, background.id]); expect(next.hasMore).toBe(false);
  });

  it('keeps private memories, tags, source windows and new group members within observation scope', () => {
    const { store, scope } = fixture();
    const secret = source(store, scope.conversationId, '私人地址在杭州');
    const privateMemory = store.request({ type: 'memory.record', ...scope, candidate: candidate(secret, { factKey: 'address', tags: [{ name: '私人住址' }] }) }).memories![0]!;
    const group = store.createConversation('群', ['alice']);
    const groupScope = { companionId: 'alice', conversationId: group.id };
    expect(store.request({ type: 'memory.search', ...groupScope, query: '杭州 私人住址' }).memoryPage!.items).toEqual([]);
    expect(() => store.request({ type: 'memory.read', ...groupScope, id: privateMemory.id })).toThrow('可见范围');
    const witnessed = source(store, group.id, '群里的生日讨论');
    store.updateConversation(group.id, { memberIds: ['alice', 'bob'] });
    const bobScope = { companionId: 'bob', conversationId: group.id };
    expect(store.request({ type: 'memory.sources.filter', ...bobScope, ids: [witnessed.id, secret.id] }).memorySources).toEqual([]);
    expect(() => store.request({ type: 'memory.record', ...bobScope, candidate: candidate(witnessed) })).toThrow('不可见');
  });

  it('forgets old source derivatives and blocks in-flight extraction, context and original-source fallback', () => {
    const { store, scope } = fixture();
    const message = source(store, scope.conversationId, '我的地址是杭州一号');
    const memory = store.request({ type: 'memory.record', ...scope, candidate: candidate(message, { factKey: 'address' }) }).memories![0]!;
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    store.request({ type: 'memory.forget', ...scope, id: memory.id });
    expect(store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [candidate(message, { factKey: 'address' })] }).memories).toEqual([]);
    expect(store.request({ type: 'memory.sources.search', ...scope, terms: ['杭州'] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [message.id] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.records.filter', ...scope, ids: [memory.id] }).memories).toEqual([]);
    expect(store.request({ type: 'messages', conversationId: scope.conversationId }).messages?.[0]?.content).toBe(message.content);
    expect(store.request({ type: 'memory.browse', ...scope, status: 'forgotten' }).memoryPage!.items[0]!.memory).toMatchObject({ content: '已遗忘的记忆', sources: [], tags: [] });
  });

  it('maintains persistent topic prohibitions while permitting newly supplied facts after one-time forgetting', () => {
    const { store, scope } = fixture();
    const old = source(store, scope.conversationId, '旧地址杭州');
    const memory = store.request({ type: 'memory.record', ...scope, candidate: candidate(old, { factKey: 'address' }) }).memories![0]!;
    store.request({ type: 'memory.forget', ...scope, id: memory.id });
    const fresh = source(store, scope.conversationId, '新地址上海');
    expect(store.request({ type: 'memory.record', ...scope, candidate: candidate(fresh, { factKey: 'address' }) }).memories).toHaveLength(1);
    store.request({ type: 'memory.forget', ...scope, subject: 'user', factKey: 'address', persistent: true });
    const later = source(store, scope.conversationId, '再次提供地址北京');
    expect(store.request({ type: 'memory.record', ...scope, candidate: candidate(later, { factKey: 'address' }) }).memories).toEqual([]);
  });

  it('invalidates derived overviews when atomic facts change and retains the original evidence', () => {
    const { store, scope } = fixture();
    const initial = source(store, scope.conversationId, '搬家计划六月'), newer = source(store, scope.conversationId, '搬家计划取消了');
    const atom = store.request({ type: 'memory.record', ...scope, candidate: candidate(initial, { kind: 'event', factKey: 'move', eventId: 'move-event', eventStatus: 'planned' }) }).memories![0]!;
    const overview = store.request({ type: 'memory.record', ...scope, candidate: candidate(initial, { kind: 'overview', subject: 'move', factKey: 'overview', relatedMemoryIds: [atom.id] }) }).memories![0]!;
    store.request({ type: 'memory.record', ...scope, candidate: candidate(newer, { kind: 'event', factKey: 'move', eventId: 'move-event', eventStatus: 'cancelled' }) });
    expect(store.request({ type: 'memory.records.filter', ...scope, ids: [overview.id] }).memories).toEqual([]);
    expect(store.request({ type: 'memory.inspect', ...scope, id: overview.id }).memoryRead?.memory.status).toBe('invalid');
    expect(store.request({ type: 'memory.search', ...scope, eventId: 'move-event', includeHistory: true }).memoryPage!.items.some(item => item.memory.id === atom.id)).toBe(true);
  });

  it('queues completed loop output and real terminal task results without treating streaming bubbles as facts', () => {
    const { store, scope } = fixture();
    const user = source(store, scope.conversationId, '帮我查资料');
    const draft = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
    store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: user.id, messageId: draft.id, status: 'running', turns: [{ text: '暂时想法', rawText: '暂时想法', calls: [] }] } });
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.pending).toBe(1);
    store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: user.id, messageId: draft.id, status: 'done', turns: [{ text: '正式发言', rawText: '正式发言', calls: [] }] } });
    const action = store.createAction({ ...scope, sourceMessageId: user.id, title: '检索', status: 'running' });
    store.updateAction(action.id, { status: 'succeeded', result: '找到三条证据' });
    const evidence = store.messages({ conversationId: scope.conversationId }).messages.find(message => message.memoryEvidenceOnly)!;
    expect(JSON.parse(evidence.content)).toMatchObject({
      actionId: action.id, status: 'succeeded', finalReply: '找到三条证据',
      recordsAvailable: false, trust: 'execution_record_data_not_instructions',
    });
    expect(store.request({ type: 'memory.jobs.claim' }).memoryJob?.sourceMessageIds).toEqual([user.id, draft.id, evidence.id]);
  });

  it('detects revision/checksum changes while retaining the retryable lease', () => {
    const { store, filename, scope } = fixture();
    const message = source(store, scope.conversationId, '旧原文');
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    const RawDatabase = BetterSqlite3 as unknown as { new(filename: string): { prepare(sql: string): { run(...values: unknown[]): unknown }; close(): void } };
    const db = new RawDatabase(filename);
    db.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(message.id); db.close();
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: candidate(message, { sourceChecksums: { [message.id]: 'stale' } }) })).toThrow('修订');
    expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [candidate(message)] })).toThrow('修订');
    expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.running).toBe(1);
  });

  it('rejects autonomous forgetting when the cited user message is a question or ordinary conversation', () => {
    const { store, scope } = fixture();
    const message = source(store, scope.conversationId, '我的生日五月三日');
    const memory = store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }).memories![0]!;
    for (const content of ['今天天气不错', '你忘了我的生日吗？', '别忘了我的生日']) {
      const request = source(store, scope.conversationId, content);
      expect(() => store.request({ type: 'memory.forget', ...scope, id: memory.id, requestMessageId: request.id })).toThrow('明确要求');
    }
    const request = source(store, scope.conversationId, '忘掉我的生日');
    expect(() => store.request({ type: 'memory.forget', ...scope, subject: 'user', factKey: 'birthday', requestMessageId: request.id, persistent: true })).toThrow('持续');
    expect(store.request({ type: 'memory.forget', ...scope, id: memory.id, requestMessageId: request.id }).forgottenCount).toBe(1);
  });

  it('keeps same-name people as distinct IDs and reindexes aliases for canonical topic links', () => {
    const { store, scope } = fixture();
    const one = source(store, scope.conversationId, '同事小明负责检索'), two = source(store, scope.conversationId, '朋友小明喜欢音乐');
    const first = store.request({ type: 'memory.record', ...scope, candidate: candidate(one, { kind: 'event', factKey: undefined, tags: [{ name: '小明', type: 'person' }, { name: '检索', type: 'topic' }] }) }).memories![0]!;
    const second = store.request({ type: 'memory.record', ...scope, candidate: candidate(two, { kind: 'event', factKey: undefined, tags: [{ name: '小明', type: 'person' }, { name: '检索', type: 'topic', aliases: ['查找'] }] }) }).memories![0]!;
    expect(first.tags?.[0]?.id).not.toBe(second.tags?.[0]?.id);
    expect(first.tags?.[1]?.id).toBe(second.tags?.[1]?.id);
    expect(store.request({ type: 'memory.search', ...scope, terms: ['查找'] }).memoryPage?.items.map(item => item.memory.id)).toContain(first.id);
  });

  it('provides independent ranked source cursors without forgetting-filter gaps', () => {
    const { store, scope } = fixture();
    const messages = Array.from({ length: 5 }, (_, i) => source(store, scope.conversationId, `记忆检索资料${i}`));
    const forgotten = store.request({ type: 'memory.record', ...scope, candidate: candidate(messages[2]!, { kind: 'event', factKey: undefined }) }).memories![0]!;
    store.request({ type: 'memory.forget', ...scope, id: forgotten.id });
    let cursor: number | undefined, seen: string[] = [];
    do {
      const response = store.request({ type: 'memory.sources.search', ...scope, terms: ['记忆检索'], sourceCursor: cursor, limit: 2 });
      seen = [...seen, ...(response.memorySources ?? []).map(message => message.id)]; cursor = response.sourceNextCursor;
      expect(response.sourceHasMore).toBe(response.hasMore);
    } while (cursor !== undefined);
    expect(new Set(seen).size).toBe(4); expect(seen).not.toContain(messages[2]!.id);
  });

  it('atomically rebuilds a missing lexical index from authority without reviving forgotten evidence or changing versions', () => {
    const { store, filename, scope } = fixture();
    const liveSource = source(store, scope.conversationId, '阿珂的生日五月三日'), oldSource = source(store, scope.conversationId, '私人地址杭州');
    const live = store.request({ type: 'memory.record', ...scope, candidate: candidate(liveSource, { tags: [{ name: '阿珂', aliases: ['小珂'] }] }) }).memories![0]!;
    const forgotten = store.request({ type: 'memory.record', ...scope, candidate: candidate(oldSource, { factKey: 'address' }) }).memories![0]!;
    store.request({ type: 'memory.forget', ...scope, id: forgotten.id });
    const RawDatabase = BetterSqlite3 as unknown as { new(filename: string): { exec(sql: string): void; close(): void } };
    const db = new RawDatabase(filename); db.exec('DROP TABLE memory_search'); db.close();
    expect(store.request({ type: 'memory.index.rebuild' }).rebuiltCount).toBe(2);
    const recalled = store.request({ type: 'memory.search', ...scope, terms: ['小珂'] }).memoryPage!.items[0]!.memory;
    expect(recalled.id).toBe(live.id); expect(recalled.version).toBe(live.version);
    expect(store.request({ type: 'memory.search', ...scope, terms: ['杭州'] }).memoryPage!.items).toEqual([]);
    expect(store.request({ type: 'memory.sources.search', ...scope, terms: ['杭州'] }).memorySources).toEqual([]);
  });

  it('does not resurrect a forgotten source through a late task result or an assistant reply', () => {
    const { store, scope } = fixture();
    const old = source(store, scope.conversationId, '旧地址杭州一号');
    const memory = store.request({ type: 'memory.record', ...scope, candidate: candidate(old, { factKey: 'address' }) }).memories![0]!;
    const action = store.createAction({ ...scope, sourceMessageId: old.id, title: '查旧地址', status: 'running' });
    store.request({ type: 'memory.forget', ...scope, id: memory.id });
    store.updateAction(action.id, { status: 'succeeded', result: '查到旧地址杭州一号' });
    const evidence = store.messages({ conversationId: scope.conversationId }).messages.find(message => message.memoryEvidenceOnly)!;
    const reply = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', replyToId: old.id, content: '你的旧地址杭州一号' });
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [evidence.id, reply.id] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.sources.search', ...scope, terms: ['杭州'] }).memorySources).toEqual([]);
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    expect(store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [candidate(evidence, { kind: 'event', factKey: undefined, value: undefined }), candidate(reply, { kind: 'event', factKey: undefined, value: undefined })] }).memories).toEqual([]);
    const fresh = source(store, scope.conversationId, '重新主动提供地址上海二号');
    expect(store.request({ type: 'memory.record', ...scope, candidate: candidate(fresh, { factKey: 'address' }) }).memories).toHaveLength(1);
  });

  it('recovers a deleted lexical index on restart and retries runtime index failure once', () => {
    const { store, filename, scope } = fixture();
    const message = source(store, scope.conversationId, '生日五月三日');
    const memory = store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }).memories![0]!;
    const RawDatabase = BetterSqlite3 as unknown as { new(filename: string): { exec(sql: string): void; close(): void } };
    let db = new RawDatabase(filename); db.exec('DROP TABLE memory_search'); db.close();
    expect(store.request({ type: 'memory.search', ...scope, query: '生日' }).memoryPage!.items[0]!.memory.id).toBe(memory.id);
    close(store);
    db = new RawDatabase(filename); db.exec('DROP TABLE memory_search'); db.close();
    const reopened = open(filename);
    expect(reopened.request({ type: 'memory.search', ...scope, query: '生日' }).memoryPage!.items[0]!.memory.id).toBe(memory.id);
  });

  it('selects fact snapshots correctly when identical values surround a correction and extraction arrives out of order', () => {
    const { store, scope } = fixture();
    const one = source(store, scope.conversationId, '我住杭州'), two = source(store, scope.conversationId, '我改住上海'), three = source(store, scope.conversationId, '我又回杭州');
    const latest = store.request({ type: 'memory.record', ...scope, candidate: candidate(three, { factKey: 'city', value: '杭州' }) }).memories![0]!;
    store.request({ type: 'memory.record', ...scope, candidate: candidate(one, { factKey: 'city', value: '杭州' }) });
    store.request({ type: 'memory.record', ...scope, candidate: candidate(two, { factKey: 'city', value: '上海' }) });
    const snapshot = (sequence: number) => store.request({ type: 'memory.search', ...scope, factKey: 'city', beforeSequence: sequence }).memoryPage!.items.map(item => item.memory);
    expect(snapshot(one.sequence).map(memory => memory.value)).toEqual(['杭州']);
    expect(snapshot(one.sequence)[0]?.sourceMessageId).toBe(one.id);
    expect(snapshot(two.sequence).map(memory => memory.value)).toEqual(['上海']);
    expect(snapshot(three.sequence).map(memory => memory.id)).toEqual([latest.id]);
  });

  it('excludes a late-published loop bubble from requests that already existed while allowing its own extraction', () => {
    const { store, scope } = fixture();
    const first = source(store, scope.conversationId, '原问题');
    const old = store.request({ type: 'memory.record', ...scope, candidate: candidate(first, { kind: 'event', subject: 'project', factKey: 'state', value: 'planned', eventId: 'late-loop-project', eventStatus: 'planned' }) }).memories![0]!;
    const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
    const next = source(store, scope.conversationId, '下一条要求');
    store.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: first.id, messageId: bubble.id, status: 'done', turns: [{ text: '后来才完成的杭州项目经历', rawText: '后来才完成的杭州项目经历', calls: [] }] } });
    expect(store.request({ type: 'memory.sources.search', ...scope, beforeSequence: next.sequence, terms: ['杭州'] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, beforeSequence: next.sequence, ids: [bubble.id] }).memorySources).toEqual([]);
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    expect(job.throughSequence).toBe(next.sequence + 1);
    const finalized = store.getMessage(bubble.id);
    const memory = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [candidate(finalized, { kind: 'event', subject: 'project', factKey: 'state', value: 'completed', eventId: 'late-loop-project', eventStatus: 'completed' })] }).memories![0]!;
    expect(store.request({ type: 'memory.search', ...scope, beforeSequence: next.sequence, terms: ['杭州'] }).memoryPage?.items).toEqual([]);
    expect(store.request({ type: 'memory.search', ...scope, beforeSequence: next.sequence, subject: 'project', factKey: 'state' }).memoryPage?.items[0]?.memory.id).toBe(old.id);
    const future = source(store, scope.conversationId, '新的问题');
    expect(store.request({ type: 'memory.search', ...scope, beforeSequence: future.sequence, terms: ['杭州'] }).memoryPage?.items[0]?.memory.id).toBe(memory.id);
  });

  it('limits group processing status to the current room without exposing private counts or failures', () => {
    const { store, scope } = fixture();
    const privateSource = source(store, scope.conversationId, '私人生日');
    store.request({ type: 'memory.record', ...scope, candidate: candidate(privateSource) });
    const job = store.request({ type: 'memory.jobs.claim' }).memoryJob!;
    store.request({ type: 'memory.jobs.fail', id: job.id, leaseToken: job.leaseToken, error: '私人错误', retryAfterMs: 60000 });
    const group = store.createConversation('群', ['alice', 'bob']);
    source(store, group.id, '公开话题');
    const status = store.request({ type: 'memory.status', companionId: 'alice', conversationId: group.id }).memoryStatus!;
    expect(status).toMatchObject({ pending: 1, failed: 0, memories: 0 }); expect(status.lastError).toBeUndefined();
    expect(() => store.request({ type: 'memory.status', companionId: 'bob', conversationId: scope.conversationId })).toThrow('不是聊天成员');
  });

  it('allows explicit user management to forget unverified manual notes and manually edited automatic memories', () => {
    const { store, scope } = fixture();
    const note = store.saveMemory({ ...scope, content: '手工便签', origin: 'user' });
    expect(note).toMatchObject({ captureMethod: 'manual', epistemicStatus: 'unverified', sources: [] });
    expect(store.request({ type: 'memory.forget', ...scope, id: note.id }).forgottenCount).toBe(1);
    const message = source(store, scope.conversationId, '生日五月三日');
    const automatic = store.request({ type: 'memory.record', ...scope, candidate: candidate(message) }).memories![0]!;
    expect(automatic.captureMethod).toBe('automatic');
    const edited = store.saveMemory({ ...scope, id: automatic.id, expectedVersion: automatic.version, content: '生日五月四日', sourceMessageId: message.id, origin: 'user' });
    expect(edited).toMatchObject({ captureMethod: 'manual', epistemicStatus: 'unverified' });
    expect(store.request({ type: 'memory.forget', ...scope, id: edited.id }).forgottenCount).toBeGreaterThanOrEqual(1);
    expect(store.listMemory('alice')).toEqual([]);
    const group = store.createConversation('另一范围', ['alice', 'bob']);
    const scoped = store.saveMemory({ ...scope, content: '仅私聊管理的便签', origin: 'user' });
    expect(() => store.request({ type: 'memory.forget', companionId: 'alice', conversationId: group.id, id: scoped.id })).toThrow('管理范围');
  });

  it('does not let a group fact or topic forgetting rule erase the same private fact', () => {
    const { store, scope } = fixture();
    const privateSource = source(store, scope.conversationId, '我的私人咖啡偏好');
    const privateMemory = store.request({ type: 'memory.record', ...scope, candidate: candidate(privateSource, { factKey: 'coffee', tags: [{ name: '咖啡' }] }) }).memories![0]!;
    const group = store.createConversation('公开群', ['alice', 'bob']), groupScope = { companionId: 'alice', conversationId: group.id };
    const groupSource = source(store, group.id, '群里分享咖啡偏好');
    store.request({ type: 'memory.record', ...groupScope, candidate: candidate(groupSource, { factKey: 'coffee', tags: [{ name: '咖啡' }] }) });
    expect(() => store.request({ type: 'memory.forget', ...groupScope, sourceMessageIds: [privateSource.id] })).toThrow('当前可见范围');
    expect(store.request({ type: 'memory.forget', ...groupScope, subject: 'user', factKey: 'coffee', persistent: true }).forgottenCount).toBe(1);
    expect(store.request({ type: 'memory.search', ...scope, query: '咖啡' }).memoryPage?.items[0]?.memory.id).toBe(privateMemory.id);
    const otherGroupSource = source(store, group.id, '群里的另一段经历');
    const otherGroupMemory = store.request({ type: 'memory.record', ...groupScope, candidate: candidate(otherGroupSource, { kind: 'event', factKey: undefined, value: undefined }) }).memories![0]!;
    expect(store.request({ type: 'memory.forget', ...scope, id: otherGroupMemory.id }).forgottenCount).toBe(1);
  });
});
