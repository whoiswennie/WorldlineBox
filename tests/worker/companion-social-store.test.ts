import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import type { CompanionSocialJob } from '../../src/shared/companion-social';
import { inspectCompanionReplyMemory, inspectCompanionSocialReplyMemory } from '../../src/main/companions/reply-memory-inspection';
import { recallCorpusHash } from '../../src/main/companions/recall-evidence';

const seeds: CompanionSeed[] = ['alice', 'bob', 'carol', 'dave'].map(id => ({ id, name: id, persona: '独立且尊重边界。', description: '', model: '', avatar: 'sister', proactive: true }));
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) { if (!root.startsWith(path.join(tmpdir(), 'companion-social-store-'))) throw new Error('Unexpected fixture path.'); rmSync(root, { recursive: true, force: true }); } vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-social-store-')); roots.push(root); const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store); const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const seed of seeds) { const scope = { companionId: seed.id, conversationId: store.openPrivate(seed.id).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } }); }
  advance(store, 10000); return { store, filename };
}
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function room(store: CompanionsStore, members = ['alice', 'bob'], title = '伙伴读书会') { return store.request({ type: 'social.conversation.ensure', companionId: members[0]!, memberIds: members, title }).socialConversation!; }
function append(store: CompanionsStore, conversationId: string, index: number, at: string, content = '读书消息 ' + index) { return store.request({ type: 'social.message.append', conversationId, authorId: index % 2 ? 'bob' : 'alice', content, virtualCreatedAt: at, clientId: 'fixture_' + index }).socialMessage!; }
function initial(store: CompanionsStore, conversationId: string, clientId = 'first') {
  const command = { type: 'social.send', companionId: 'alice', conversationId, channel: 'phone', content: '你今天想读什么书？', clientId } as const;
  expect(store.request(command).socialPending).toBe(true); advance(store, 1300); return store.request(command).socialMessage!;
}
function complete(store: CompanionsStore, job: CompanionSocialJob, text: string | null) { advance(store, Math.max(1, Date.parse(job.typingNotBefore) - Date.now() + 1)); return store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text }); }

it('preserves a peer reply exact recall during its live lease and after formal publication, then redacts withdrawn evidence', async () => {
  const { store } = fixture(), pair = room(store), privateRoom = store.openPrivate('bob');
  const introduction = store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: '我叫天幻岚。', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', companionId: 'bob', conversationId: privateRoom.id,
    candidate: { content: '玩家向我介绍自己叫天幻岚。', tags: ['玩家', '姓名'], sourceMessageIds: [introduction.id], evidence: [{ sourceMessageId: introduction.id, quote: introduction.content }] } }).memories![0]!;
  for (;;) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
    store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); }
  initial(store, pair.id); const job = store.request({ type: 'social.job.claim' }).socialJob!;
  const scope = { companionId: 'bob', conversationId: pair.id, beforeSequence: job.throughSequence };
  const snapshot = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
  const recall = { reasons: [{ id: note.id, version: note.version, reasons: ['VCP river'], path: [note.id] }], pending: false, degraded: false,
    context: { text: 'VCP实际聚焦：玩家叫天幻岚。', revision: snapshot.revision, profileKey: 'test-native',
      evidence: { capturedAt: new Date().toISOString(), corpusHash: recallCorpusHash(snapshot.notes), beforeSequence: job.throughSequence } } };
  expect(() => store.request({ type: 'social.job.progress', id: job.id, leaseToken: 'wrong', phase: 'memory', detail: '不应保存' })).toThrow('租约');
  store.request({ type: 'social.job.progress', id: job.id, leaseToken: job.leaseToken!, phase: 'thinking', detail: '组织回应',
    memory: { status: 'completed', injected: true, count: 1 }, memoryRecall: recall });
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command);
  const pendingInput = { type: 'social.reply.memory.inspect' as const, jobId: job.id, companionId: 'bob', conversationId: pair.id, contextOffset: 0, contextLimit: 8192 };
  expect(await inspectCompanionSocialReplyMemory(pendingInput, request)).toMatchObject({ state: 'ready', messageId: job.id, contextText: recall.context.text,
    candidates: [{ id: note.id, sources: [{ messageId: introduction.id }] }] });
  expect(store.request({ type: 'social.reply.progress', conversationId: pair.id }).socialReplyProgress).toMatchObject([{ jobId: job.id,
    progress: { phase: 'thinking', memory: { injected: true } } }]);
  advance(store, 1500);
  const reply = store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '我记得玩家叫天幻岚。',
    memoryRecall: recall, expectedMemoryRevision: snapshot.revision }).socialMessage!;
  expect(reply.message.replyProgress?.phase).toBe('completed');
  expect((await inspectCompanionSocialReplyMemory(pendingInput, request)).state).toBe('unavailable');
  const completedInput = { type: 'reply.memory.inspect' as const, companionId: 'bob', conversationId: pair.id, messageId: reply.message.id, contextOffset: 0, contextLimit: 8192 };
  expect(await inspectCompanionReplyMemory(completedInput, request)).toMatchObject({ state: 'ready', contextText: recall.context.text });
  expect((await inspectCompanionReplyMemory({ ...completedInput, companionId: 'alice' }, request)).state).toBe('unavailable');
  store.request({ type: 'memory.forget', companionId: 'bob', conversationId: privateRoom.id, id: note.id });
  expect(await inspectCompanionReplyMemory(completedInput, request)).toMatchObject({ state: 'withdrawn', candidates: [], contextCharacters: 0 });
});

it.each(['skipped', 'exhausted-scope-failure'] as const)('reconsiders old %s peer episodes once without inventing observers or reviving forgotten sources', mode => {
  const { store, filename } = fixture(), pair = room(store), source = append(store, pair.id, 0, '2026-10-15T10:00:00Z', '姐姐专门来问我玩家的名字。');
  for (;;) { const job = store.request({ type: 'memory.jobs.claim' }).memoryJob; if (!job) break;
    store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] }); }
  store.request({ type: 'memory.forget', companionId: 'bob', conversationId: pair.id, sourceMessageIds: [source.message.id] });
  store.close(); stores.delete(store);
  const db = new Database(filename); db.prepare("DELETE FROM metadata WHERE key LIKE 'vcp-peer-episode-backfill-%'").run();
  if (mode === 'exhausted-scope-failure') db.prepare("UPDATE vcp_capture_jobs SET status='failed',attempts=8,error='新日记不能关联其他来源域的旧记忆。' WHERE companion_id='alice'").run();
  db.close();
  const reopened = new CompanionsStore(filename, seeds); stores.add(reopened);
  const retried = reopened.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(retried.sourceMessageIds).toEqual([source.message.id]);
  reopened.request({ type: 'memory.jobs.complete', id: retried.id, leaseToken: retried.leaseToken, notes: [] });
  expect(reopened.request({ type: 'memory.jobs.claim', companionId: 'bob' }).memoryJob).toBeUndefined();
  expect(reopened.request({ type: 'memory.sources.filter', companionId: 'carol', conversationId: reopened.openPrivate('carol').id, ids: [source.message.id] }).memorySources).toEqual([]);
  reopened.close(); stores.delete(reopened);
  const again = new CompanionsStore(filename, seeds); stores.add(again);
  expect(again.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
});

it('links a new peer episode to the same owners private knowledge and cascades its withdrawal across entrances', () => {
  const { store } = fixture(), pair = room(store), scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const intro = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我的名字叫天幻岚。', replyDirective: 'none' });
  const original = store.request({ type: 'memory.record', ...scope, candidate: { content: '玩家介绍自己叫天幻岚。', tags: ['姓名'],
    sourceMessageIds: [intro.id], evidence: [{ sourceMessageId: intro.id, quote: intro.content }] } }).memories![0]!;
  const question = append(store, pair.id, 1, '2026-10-15T10:00:00Z', '你还记得玩家亲口介绍的名字吗？');
  const answer = append(store, pair.id, 2, '2026-10-15T10:00:01Z', '我记得他亲口介绍叫天幻岚。');
  const candidate = { content: 'bob专门来问玩家姓名，我据自己的旧记忆回答天幻岚。', diaryName: '日记', tags: ['bob', '姓名询问'], relatedMemoryIds: [original.id],
    sourceMessageIds: [question.message.id, answer.message.id], evidence: [{ sourceMessageId: question.message.id, quote: question.message.content }, { sourceMessageId: answer.message.id, quote: answer.message.content }] };
  const episode = store.request({ type: 'memory.record', companionId: 'alice', conversationId: pair.id, candidate }).memories![0]!;
  expect(episode.sourceConversationId).toBe(pair.id);
  expect(episode.sources.map(source => source.messageId)).toEqual([question.message.id, answer.message.id]);
  expect(() => store.request({ type: 'memory.record', companionId: 'bob', conversationId: pair.id, candidate })).toThrow('本人记忆');
  store.request({ type: 'memory.forget', ...scope, id: original.id });
  expect(store.request({ type: 'memory.browse', companionId: 'alice', conversationId: pair.id }).memoryPage?.items.some(hit => hit.memory.id === episode.id)).toBe(false);
});

it.each(['alice', 'bob', 'carol'])('requires every participant to be activated before sending a new group message (%s dormant)', dormant => {
  const { store, filename } = fixture(), group = room(store, ['alice', 'bob', 'carol']);
  const historical = append(store, group.id, 0, '2026-10-15T10:00:00Z', '之前实际发生过的交流。');
  store.setCompanionActive(dormant, false);
  const command = { type: 'social.send' as const, companionId: 'alice', conversationId: group.id, channel: 'phone' as const, content: '不能向休眠伙伴发送。', clientId: 'dormant_' + dormant };
  expect(() => store.request(command)).toThrow('激活');
  expect(store.request({ type: 'social.messages', conversationId: group.id }).socialMessagePage!.items.map(item => item.message.id)).toEqual([historical.message.id]);
  expect(store.request({ type: 'state' }).state!.companions.find(role => role.id === dormant)?.active).toBe(false);
  const db = new Database(filename); try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_social_outbox').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_social_jobs').get()).toMatchObject({ n: 0 });
  } finally { db.close(); }
});

it('cancels a queued message and typing when its recipient is deactivated, without replaying on reactivation', () => {
  const { store, filename } = fixture(), pair = room(store);
  const command = { type: 'social.send' as const, companionId: 'alice', conversationId: pair.id, channel: 'phone' as const, content: '开始输入但尚未发送。', clientId: 'deactivated_during_typing' };
  expect(store.request(command).socialPending).toBe(true);
  expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!.communication?.phase).toBe('typing');
  store.setCompanionActive('bob', false); advance(store, 1500);
  expect(store.request({ type: 'social.job.claim' }).socialMessage).toBeUndefined();
  expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!.communication).toBeUndefined();
  store.setCompanionActive('bob', true); advance(store, 1500);
  expect(store.request({ type: 'social.job.claim' }).socialMessage).toBeUndefined();
  expect(store.request({ type: 'social.messages', conversationId: pair.id }).socialMessagePage!.total).toBe(0);
  expect(() => store.request(command)).toThrow('取消');
  const db = new Database(filename); try { expect(db.prepare('SELECT status FROM companion_social_outbox WHERE client_id=?').get(command.clientId)).toMatchObject({ status: 'cancelled' }); } finally { db.close(); }
});

it.each(['alice', 'bob'])('rejects a late generated reply when %s deactivates and keeps the actual sent evidence', dormant => {
  const { store, filename } = fixture(), pair = room(store), sent = initial(store, pair.id);
  const job = store.request({ type: 'social.job.claim' }).socialJob!; expect(job.companionId).toBe('bob');
  store.setCompanionActive(dormant, false); advance(store, 1500);
  expect(() => store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '这条旧生成结果不能提交。' })).toThrow('失效');
  store.setCompanionActive(dormant, true);
  expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  expect(store.request({ type: 'social.messages', conversationId: pair.id }).socialMessagePage!.items.map(item => item.message.id)).toEqual([sent.message.id]);
  const db = new Database(filename); try { expect(db.prepare('SELECT status FROM companion_social_jobs WHERE id=?').get(job.id)).toMatchObject({ status: 'cancelled' }); } finally { db.close(); }
});

it('uses indexed Chinese/title search, exact calendar scope, keyset pages and scoped conversation previews', () => {
  const { store } = fixture(), pair = room(store), other = room(store, ['alice', 'carol'], '完全不同');
  const all = Array.from({ length: 9 }, (_, index) => { vi.setSystemTime(Date.now() + 1000); return append(store, pair.id, index, index < 6 ? '2026-10-14T11:00:00Z' : '2026-10-15T11:00:00Z', index < 6 ? '旧日月亮 ' + index : '未来秘密 ' + index); });
  append(store, other.id, 20, '2026-10-14T11:00:00Z', '无关内容');
  const preview = store.request({ type: 'social.conversations', day: '2026-10-14', query: '月亮', limit: 1 }).socialConversationPage!;
  expect(preview.total).toBe(1); expect(preview.items[0]).toMatchObject({ id: pair.id, messageCount: 6, lastMessage: all[5] }); expect(JSON.stringify(preview)).not.toContain('未来秘密');
  const first = store.request({ type: 'social.messages', conversationId: pair.id, day: '2026-10-14', query: '月', limit: 2 }).socialMessagePage!;
  const second = store.request({ type: 'social.messages', conversationId: pair.id, day: '2026-10-14', query: '月', before: first.nextCursor, limit: 2 }).socialMessagePage!;
  expect(first.items.map(item => item.message.id)).toEqual(all.slice(4, 6).map(item => item.message.id)); expect(second.items.map(item => item.message.id)).toEqual(all.slice(2, 4).map(item => item.message.id)); expect(first.total).toBe(6);
  const byTitle = store.request({ type: 'social.conversations', query: '读书会' }).socialConversationPage!; expect(byTitle.items.map(item => item.id)).toEqual([pair.id]);
  expect(store.request({ type: 'social.conversations', query: '完全不同' }).socialConversationPage!.items.map(item => item.id)).toEqual([other.id]);
  const around = store.request({ type: 'social.messages', conversationId: pair.id, day: '2026-10-14', query: '月亮', around: all[2]!.message.id, limit: 3 }).socialMessagePage!; expect(around.items.map(item => item.message.id)).toContain(all[2]!.message.id);
  expect(() => store.request({ type: 'social.messages', conversationId: pair.id, day: '2026-10-15', around: all[2]!.message.id })).toThrow('范围');
  expect(() => store.request({ type: 'social.messages', conversationId: other.id, around: all[2]!.message.id })).toThrow();
  expect(store.request({ type: 'social.days', month: '2026-10', query: '月亮' }).socialDays!.days).toEqual([{ day: '2026-10-14', messageCount: 6, conversationCount: 1 }]);
});
it('filters a virtual calendar day at actual DST boundaries, and exposes empty rooms by title', () => {
  const { store } = fixture(), pair = room(store), empty = room(store, ['carol', 'dave'], '空的天文社');
  const world = store.request({ type: 'world.snapshot' }).world!; store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'America/New_York' } });
  append(store, pair.id, 1, '2026-11-01T03:59:59Z'); append(store, pair.id, 2, '2026-11-01T04:00:00Z'); append(store, pair.id, 3, '2026-11-02T04:59:59Z'); append(store, pair.id, 4, '2026-11-02T05:00:00Z');
  expect(store.request({ type: 'social.messages', conversationId: pair.id, day: '2026-11-01' }).socialMessagePage!.total).toBe(2);
  expect(store.request({ type: 'social.days', month: '2026-11' }).socialDays!.days).toEqual([{ day: '2026-11-01', messageCount: 2, conversationCount: 1 }, { day: '2026-11-02', messageCount: 1, conversationCount: 1 }]);
  expect(store.request({ type: 'social.conversations', query: '天文' }).socialConversationPage!.items[0]!.id).toBe(empty.id);
});
it('keeps the phone draft unrecorded until real typing completes and validates every public response through the IPC schema', () => {
  const { store } = fixture(), pair = room(store), command = { type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: '正式发件要先输入。', clientId: 'typed' } as const;
  expect(store.request(command).socialPending).toBe(true); expect(store.request({ type: 'social.messages', conversationId: pair.id }).socialMessagePage!.total).toBe(0);
  const typing = store.request({ type: 'world.snapshot' }); expect(typing.world!.actors.find(actor => actor.companionId === 'alice')!.artAction).toBe('phoneTypingStanding');
  expect(() => companionStorageResponseSchema.parse(typing)).not.toThrow(); expect(typing.world!.actors.find(actor => actor.companionId === 'alice')!.communication).not.toHaveProperty('leaseId');
  advance(store, 1300); const sent = store.request(command).socialMessage!; expect(sent.message.content).toBe(command.content);
  const claimed = store.request({ type: 'social.job.claim' }); expect(companionStorageResponseSchema.safeParse(claimed).success).toBe(true); expect(claimed.socialJob).not.toHaveProperty('readSet');
  const done = complete(store, claimed.socialJob!, null); expect(companionStorageResponseSchema.safeParse(done).success).toBe(true);
  for (const response of [store.request({ type: 'social.conversations' }), store.request({ type: 'social.messages', conversationId: pair.id }), store.request({ type: 'social.days' })]) expect(companionStorageResponseSchema.safeParse(response).success).toBe(true);
});
it('recovers the phone outbox during virtual sleep after restart and still cancels withdrawn private authorization', () => {
  const f = fixture(), pair = room(f.store), scope = { companionId: 'alice', conversationId: f.store.openPrivate('alice').id }, routine = f.store.request({ type: 'routine.get', ...scope }).routine!;
  f.store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { sleepAt: '09:00', wakeAt: '11:00' } }); advance(f.store, 12000);
  const source = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '把这句公开问候发送给Bob。', replyDirective: 'none' });
  const input = { type: 'social.send', companionId: 'alice', conversationId: pair.id, content: '早上好。', channel: 'phone', clientId: 'after_restart', authorizationMessageId: source.id } as const;
  expect(f.store.request(input).socialPending).toBe(true); f.store.close(); stores.delete(f.store);
  const store = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  advance(store, 1300); const delivered = store.request(input).socialMessage!;
  expect(delivered.message.authorId).toBe('alice'); expect(JSON.stringify(delivered)).not.toContain(source.id);
  const next = { ...input, clientId: 'withdrawn' }; expect(store.request(next).socialPending).toBe(true); store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] }); advance(store, 1300); store.request({ type: 'social.job.claim' });
  expect(() => store.request(next)).toThrow('撤回'); expect(store.request({ type: 'social.messages', conversationId: pair.id }).socialMessagePage!.total).toBe(1);
});
it('holds a single live owner lease, clears failed typing, limits retries, and targets every actual group recipient', () => {
  const { store, filename } = fixture(), group = room(store, ['alice', 'bob', 'carol']), first = initial(store, group.id);
  const events = store.request({ type: 'world.snapshot' }).world!.events.filter(event => event.sourceMessageId === first.message.id); expect(new Set(events.map(event => event.targetId))).toEqual(new Set(['bob', 'carol']));
  let job = store.request({ type: 'social.job.claim' }).socialJob!; expect(job.companionId).toBe('bob'); expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  for (let attempt = 1; attempt <= 8; attempt++) { store.request({ type: 'social.job.fail', id: job.id, leaseToken: job.leaseToken!, error: 'fixture failure' });
    expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'bob')!.communication).toBeUndefined();
    if (attempt < 8) { advance(store, 300001); job = store.request({ type: 'social.job.claim' }).socialJob!; expect(job.attempts).toBe(attempt + 1); }
  }
  advance(store, 300001); expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  const db = new Database(filename); try { const record = db.prepare('SELECT status,data FROM companion_social_jobs WHERE id=?').get(job.id) as { status: string; data: string }; expect(record.status).toBe('failed'); expect(JSON.parse(record.data).attempts).toBe(8); } finally { db.close(); }
});
it('rejects player/identity edits in peer rooms and rolls back a failed formal dispatch with its evidence and chain', () => {
  const { store, filename } = fixture(), pair = room(store);
  expect(() => store.appendMessage({ conversationId: pair.id, authorId: 'user', content: '伪玩家消息' })).toThrow('实际伙伴');
  expect(() => store.updateConversation(pair.id, { memberIds: ['alice', 'carol'] })).toThrow('实际通信');
  const command = { type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: '原子消息', clientId: 'atomic' } as const;
  store.request(command); advance(store, 1300);
  const db = new Database(filename); db.exec("CREATE TRIGGER fail_social_event BEFORE INSERT ON companion_world_events BEGIN SELECT RAISE(ABORT,'injected event failure'); END"); db.close();
  expect(() => store.request(command)).toThrow('injected'); expect(store.request({ type: 'social.messages', conversationId: pair.id }).socialMessagePage!.items).toEqual([]);
  const repair = new Database(filename); repair.exec('DROP TRIGGER fail_social_event'); repair.close();
  expect(store.request(command).socialMessage!.message.content).toBe('原子消息');
});
it('shares one owner phone lease across pending outboxes and replies, without a notification stealing typing', () => {
  const { store } = fixture(), ab = room(store), ac = room(store, ['alice', 'carol']);
  const incoming = { type: 'social.send', companionId: 'carol', conversationId: ac.id, channel: 'phone', content: '这是发给Alice的新来信。', clientId: 'incoming' } as const;
  store.request(incoming); advance(store, 1300); store.request(incoming);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const authorization = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '把各自的问候发给Bob和Carol。', replyDirective: 'none' });
  const first = { type: 'social.send', companionId: 'alice', conversationId: ab.id, channel: 'phone', content: '给Bob的问候。', clientId: 'outbox_ab', authorizationMessageId: authorization.id } as const;
  const second = { ...first, conversationId: ac.id, clientId: 'outbox_ac', content: '给Carol的问候。' };
  const notification = { type: 'social.send', companionId: 'bob', conversationId: ab.id, channel: 'phone', content: '给Alice的独立通知。', clientId: 'bob_notify' } as const;
  store.request(notification); advance(store, 400);
  expect(store.request(first).socialPending).toBe(true); expect(store.request(second).socialPending).toBe(true);
  const active = store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!.communication!;
  expect(active.conversationId).toBe(ab.id);
  advance(store, 900); store.request(notification);
  expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'alice')!.communication).toEqual(active);
  expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  advance(store, 400); store.request(first); store.request(second); advance(store, 1300);
  // The second Alice outbox can now dispatch, but its old lease cannot delete a new reply lease.
  store.request(second); const job = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(job).toBeDefined(); const current = store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === job.companionId)!.communication;
  expect(current?.phase).toBe('typing');
  store.request(second); expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === job.companionId)!.communication).toEqual(current);
});
it('appraises a real remote phone event without seeing the sender private room, using the world day and exact observed source', () => {
  // Kiritimati is at 10:00 the following day; the shared world clock also owns wakefulness.
  vi.setSystemTime('2026-10-15T20:00:00Z');
  const { store, filename } = fixture(), pair = room(store), world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'Pacific/Kiritimati' } });
  advance(store, 30000);
  const before = store.request({ type: 'state.get', companionId: 'bob', conversationId: store.openPrivate('bob').id }).runtimeState!;
  initial(store, pair.id); const scope = { companionId: 'bob', conversationId: 'world_bob' }, observed = store.request({ type: 'world.observe', ...scope }).world!;
  expect(observed.actors.some(actor => actor.companionId === 'alice')).toBe(false);
  const event = observed.events.find(event => event.kind === 'social_phone' && event.actorId === 'alice' && event.targetId === 'bob')!; expect(event).toBeDefined(); expect(event.sceneId).toBeUndefined();
  advance(store, 3 * 3600000 + 1000);
  let bobJob; for (let index = 0; index < 4; index++) { const job = store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob; if (!job) break; if (job.companionId === 'bob') { bobJob = job; break; } store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken! }); }
  expect(bobJob).toBeDefined();
  store.request({ type: 'world.job.complete', id: bobJob!.id, leaseToken: bobJob!.leaseToken!, appraisals: [{ eventId: event.id, targetCompanionId: 'alice', type: 'respect', intensity: .7, confidence: .95 }] });
  const relation = store.request({ type: 'world.snapshot' }).world!.relationships.find(relation => relation.companionId === 'bob' && relation.targetCompanionId === 'alice')!; expect(relation.affinity).toBeGreaterThan(50);
  const after = store.request({ type: 'state.get', companionId: 'bob', conversationId: store.openPrivate('bob').id }).runtimeState!; expect(after.relationship).toEqual(before.relationship);
  const db = new Database(filename); try { const ledger = db.prepare('SELECT day FROM companion_world_peer_appraisals WHERE companion_id=? AND event_id=?').get('bob', event.id) as { day: string }; expect(ledger.day).toBe('2026-10-16'); } finally { db.close(); }
  store.request({ type: 'memory.forget', companionId: 'bob', conversationId: pair.id, sourceMessageIds: [event.sourceMessageId!] });
  expect(store.request({ type: 'world.snapshot' }).world!.relationships.find(relation => relation.companionId === 'bob' && relation.targetCompanionId === 'alice')!.affinity).toBe(50);
});
it('dispatches current user-authorized phone messages behind an exhausted autonomous outbox, including beyond one scan page', () => {
  const f = fixture(); let store = f.store;
  const pair = room(store), source = store.appendMessage({ conversationId: store.openPrivate('alice').id, authorId: 'user', content: '把我指定的几句问候发送给Bob。', replyDirective: 'none' });
  for (let index = 0; index < 2; index++) {
    const command = { type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: '明确授权问候 ' + index, clientId: 'directed_' + index, authorizationMessageId: source.id } as const;
    store.request(command); advance(store, 1300); expect(store.request(command).socialMessage).toBeDefined();
  }
  for (let index = 0; index < 66; index++) expect(store.request({ type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: '配额用完的自主草稿 ' + index, clientId: 'capped_' + index }).socialPending).toBe(true);
  const authorized = { type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: '这是当前玩家明确要求发送的新消息。', clientId: 'authorized_later', authorizationMessageId: source.id } as const;
  expect(store.request(authorized).socialPending).toBe(true); advance(store, 1300);
  let delivered; for (let round = 0; round < 4 && !delivered; round++) {
    const response = store.request({ type: 'social.job.claim' });
    if (response.socialMessage?.message.content === authorized.content) delivered = response.socialMessage;
    if (response.socialJob) complete(store, response.socialJob, null);
    if (round === 0) { store.close(); stores.delete(store); store = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store); }
  }
  expect(delivered?.message.content).toBe(authorized.content);
  const history = store.request({ type: 'social.messages', conversationId: pair.id }).socialMessagePage!;
  expect(history.total).toBe(3); expect(history.items.every(item => !item.message.content.includes('自主草稿'))).toBe(true);
});
it('claims a later phone reply after an older face-to-face chain loses its physical meeting', () => {
  const { store } = fixture(), alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'travel', targetSceneId: 'park' } }); advance(store, 30000);
  store.request({ type: 'world.tool', ...bob, arguments: { action: 'travel', targetSceneId: 'park' } }); advance(store, 30000);
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'social', targetCompanionId: 'bob', text: '现场谈论一本书。', kind: 'talk' } });
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'travel', targetSceneId: 'home_alice' } });
  store.request({ type: 'world.tool', ...bob, arguments: { action: 'travel', targetSceneId: 'home_bob' } }); advance(store, 30000);
  const pair = room(store), phone = { type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: '各自回家后，手机继续聊。', clientId: 'later_phone' } as const;
  // The earlier scene conversation spent the first initiation; allow the ordinary virtual cooldown.
  advance(store, 6 * 3600000 + 1); store.request(phone); advance(store, 1300); const sent = store.request(phone).socialMessage!;
  const job = store.request({ type: 'social.job.claim' }).socialJob!;
  expect(job).toMatchObject({ companionId: 'bob', channel: 'phone', sourceMessageId: sent.message.id });
  expect(complete(store, job, '手机来信确实可以回复。').socialMessage!.message.authorId).toBe('bob');
});
