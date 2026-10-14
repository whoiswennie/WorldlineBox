import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';
import { BUILTIN_COMPANIONS, BUILTIN_WELCOMES } from '../../src/shared/companion-personas';

const seeds: CompanionSeed[] = [
  { id: 'deepseek-sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳', model: '', avatar: 'sister', proactive: false },
  { id: 'deepseek-flash', name: '小肥鱼', description: '妹妹', persona: '活泼好奇', model: '', avatar: 'flash', proactive: false },
];

it('persists a FIFO queue, admits at most 20 globally and 5 per role, and refills after release and restart', () => {
  const f = fixture();
  const roles = [f.store.openPrivate('deepseek-sister'), f.store.openPrivate('deepseek-flash')];
  for (let index = 0; index < 2; index++) {
    const role = f.store.createCompanion({ name: '队列角色' + index, persona: '队列验收', description: '', model: '', avatar: 'custom', proactive: false });
    roles.push(f.store.openPrivate(role.id));
  }
  for (let round = 0; round < 7; round++) for (const [index, conversation] of roles.entries()) {
    const source = f.store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '队列消息 ' + round, replyDirective: 'auto' });
    f.store.request({ type: 'work.enqueue', work: { id: 'work_' + round + '_' + index, conversationId: conversation.id, sourceMessageId: source.id,
      companionId: conversation.memberIds[0]!, status: 'queued', proactive: false, createdAt: source.createdAt, updatedAt: source.createdAt } });
  }
  const claimed = Array.from({ length: 20 }, () => f.store.request({ type: 'work.claim' }).work!);
  expect(claimed.every(Boolean)).toBe(true);
  expect(f.store.request({ type: 'work.claim' }).work).toBeUndefined();
  for (const conversation of roles) expect(claimed.filter(work => work.companionId === conversation.memberIds[0])).toHaveLength(5);
  f.store.request({ type: 'work.status', id: 'work_0_0', status: 'done' });
  expect(f.store.request({ type: 'work.claim' }).work?.id).toBe('work_5_0');
  close(f.store);
  const reopened = open(f.databasePath);
  expect(reopened.request({ type: 'work.list' }).works).toHaveLength(28);
  reopened.request({ type: 'work.interrupt-running' });
  const resumed = Array.from({ length: 7 }, () => reopened.request({ type: 'work.claim' }).work!);
  expect(resumed.map(work => work.id)).toEqual(['work_5_1', 'work_5_2', 'work_5_3', 'work_6_0', 'work_6_1', 'work_6_2', 'work_6_3']);
  expect(reopened.request({ type: 'work.claim' }).work).toBeUndefined();
});
const welcomes = { 'deepseek-sister': '内置欢迎：我是大肥鱼。', 'deepseek-flash': '内置欢迎：我是小肥鱼。' };
const roots: string[] = [];
const stores: CompanionsStore[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-'));
  roots.push(root);
  const databasePath = path.join(root, 'companions', 'messages.sqlite');
  return { databasePath, store: open(databasePath) };
}
function open(filename: string): CompanionsStore {
  const store = new CompanionsStore(filename, seeds, welcomes);
  stores.push(store);
  return store;
}
function close(store: CompanionsStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe('CompanionsStore real SQLite persistence', () => {
  it('adds missing catalogue contacts to an old database without resetting edits, tombstones, memory or history', () => {
    const { store, databasePath } = fixture();
    store.updateCompanion('deepseek-sister', { ...seeds[0]!, name: '自定义姐姐', description: '我的签名', persona: '用户编辑的人设' });
    const original = store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '迁移前的消息' });
    store.request({ type: 'memory.save', memory: { companionId: 'deepseek-sister', content: '迁移前的约定', origin: 'user' } });
    store.deleteCompanion('deepseek-flash');
    close(store);
    const upgraded = new CompanionsStore(databasePath); stores.push(upgraded);
    const state = upgraded.state();
    expect(state.companions).toHaveLength(14);
    expect(state.companions.find(item => item.id === 'deepseek-sister')).toMatchObject({ name: '自定义姐姐', description: '我的签名', persona: '用户编辑的人设' });
    expect(state.companions.some(item => item.id === 'deepseek-flash')).toBe(false);
    expect(upgraded.getMessage(original.id).content).toBe('迁移前的消息');
    expect(upgraded.listMemory('deepseek-sister').map(item => item.content)).toContain('迁移前的约定');
    for (const profile of BUILTIN_COMPANIONS.slice(2)) {
      expect(state.companions.find(item => item.id === profile.id)).toMatchObject({ avatar: profile.avatar, builtin: true, model: '' });
      expect(upgraded.messages({ conversationId: 'private-' + profile.id }).messages.filter(item => item.content === BUILTIN_WELCOMES[profile.id])).toHaveLength(1);
    }
    upgraded.updateCompanion('gpt', { ...BUILTIN_COMPANIONS.find(item => item.id === 'gpt')!, name: '小白龙', avatar: 'custom', avatarAttachmentId: undefined, persona: '我修改了白龙的设定' });
    upgraded.deleteCompanion('doro');
    close(upgraded);
    const reopened = new CompanionsStore(databasePath); stores.push(reopened);
    expect(reopened.state().companions).toHaveLength(13);
    expect(reopened.restoreBuiltin('gpt')).toMatchObject({ name: '小白龙', avatar: 'custom', persona: '我修改了白龙的设定' });
    const restored = reopened.restoreBuiltin('doro');
    expect(restored.id).toBe('doro');
    expect(reopened.restoreBuiltin('doro').id).toBe(restored.id);
    expect(reopened.messages({ conversationId: 'private-doro' }).messages.filter(item => item.content === BUILTIN_WELCOMES.doro)).toHaveLength(1);
  });
  it('recovers a partial group reply and the same task identity with atomic checkpoint inputs after reopening', () => {
    const { store, databasePath } = fixture();
    const group = store.createConversation('', ['deepseek-sister', 'deepseek-flash']);
    const source = store.appendMessage({ conversationId: group.id, authorId: 'user', content: '请你们继续办事', replyDirective: 'auto' });
    store.appendMessage({ conversationId: group.id, authorId: 'deepseek-sister', content: '姐姐已回复', replyCompletion: { sourceMessageId: source.id, companionId: 'deepseek-sister' } });
    const action = store.createAction({ conversationId: group.id, companionId: 'deepseek-flash', sourceMessageId: source.id, title: '继续工作', status: 'running' }, { prompt: '原始完整目标', supplements: [], waitForActionIds: [] });
    store.updateCheckpoint(action.id, { input: { id: 'input-1', content: '保留第一章', mode: 'steer' } });
    store.updateCheckpoint(action.id, { execution: { id: 'native-1', operationId: 'native-1', instanceId: 'instance-1', runtimeId: 'runtime-1', runtimeVersion: '0.2.1-alpha.2', sessionId: 'session-original', workspacePath: process.cwd(), accessMode: 'read-only', title: '继续工作', status: 'running', startedAt: new Date().toISOString() } });
    store.updateCheckpoint(action.id, { input: { id: 'input-1', content: '保留第一章', mode: 'steer' } });
    close(store);
    const reopened = open(databasePath); reopened.interruptPendingActions();
    expect(reopened.state().recoveries).toEqual([expect.objectContaining({ sourceMessageId: source.id, status: 'interrupted', completedIds: ['deepseek-sister'] })]);
    expect(reopened.getAction(action.id)).toMatchObject({ status: 'interrupted', canResume: true });
    expect(reopened.checkpoint(action.id)).toMatchObject({ prompt: '原始完整目标', execution: { sessionId: 'session-original', accessMode: 'read-only' }, supplements: [{ id: 'input-1', mode: 'steer' }] });
    expect(reopened.resumeAction(action.id)).toMatchObject({ id: action.id, status: 'queued', attempt: 2, events: [] });
    expect(() => reopened.resumeAction(action.id)).toThrow();
    expect(reopened.listAction(group.id)).toHaveLength(1);
    reopened.setReplyStatus(group.id, source.id, 'done');
    expect(reopened.state().recoveries).toHaveLength(0);
  });
  it('pages full task history newest first with isolated role filters and direct detail beyond the old 100-item limit', () => {
    const { store, databasePath } = fixture();
    const group = store.createConversation('', ['deepseek-sister', 'deepseek-flash']);
    const source = store.appendMessage({ conversationId: group.id, authorId: 'user', content: '历史任务验收' });
    const created = Array.from({ length: 125 }, (_, index) => store.createAction({ conversationId: group.id, companionId: index % 2 ? 'deepseek-flash' : 'deepseek-sister', sourceMessageId: source.id, title: '任务 ' + index, status: 'succeeded', result: '独立结果 ' + index, events: [{ sequence: 0, type: 'tool_end', receivedAt: new Date().toISOString(), summary: '完成' }] }));
    const expected = [...created].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const found: string[] = []; let cursor: { createdAt: string; id: string } | undefined;
    do {
      const page = store.request({ type: 'actions.page', conversationId: group.id, limit: 20, ...(cursor ? { before: cursor } : {}) }).actionPage!;
      expect(page.total).toBe(125);
      expect(page.items.length).toBeLessThanOrEqual(20);
      expect(page.items.every(item => !item.events && !item.result)).toBe(true);
      found.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(expected.map(item => item.id));
    expect(new Set(found).size).toBe(125);
    const sister = store.actionPage({ conversationId: group.id, companionId: 'deepseek-sister', limit: 50 });
    expect(sister.total).toBe(63);
    expect(sister.items.every(item => item.companionId === 'deepseek-sister')).toBe(true);
    expect(sister.owners).toEqual(expect.arrayContaining([{ companionId: 'deepseek-sister', name: '大肥鱼', count: 63 }, { companionId: 'deepseek-flash', name: '小肥鱼', count: 62 }]));
    expect(store.getAction(expected.at(-1)!.id).result).toBe(expected.at(-1)!.result);
    close(store);
    const reopened = open(databasePath);
    expect(reopened.actionPage({ conversationId: group.id }).total).toBe(125);
    expect(() => reopened.actionPage({ conversationId: group.id, limit: 500 })).toThrow();
    expect(() => reopened.actionPage({ conversationId: 'missing-room' })).toThrow('聊天不存在');
  });
  it('keeps automatic member titles current while custom names survive member changes and restart', () => {
    const { store, databasePath } = fixture();
    const group = store.createConversation('', ['deepseek-sister', 'deepseek-flash']);
    expect(group.title).toBe('我、大肥鱼和小肥鱼的群聊');
    store.updateCompanion('deepseek-flash', { ...seeds[1]!, name: '小蓝' });
    expect(store.state().conversations.find(item => item.id === group.id)?.title).toBe('我、大肥鱼和小蓝的群聊');
    expect(store.updateConversation(group.id, { title: '我、大肥鱼和小蓝的群聊', memberIds: ['deepseek-sister'] }).title).toBe('我和大肥鱼的群聊');
    expect(store.updateConversation(group.id, { title: '蓝色海边' }).title).toBe('蓝色海边');
    store.updateConversation(group.id, { memberIds: ['deepseek-sister', 'deepseek-flash'] });
    close(store);
    const reopened = open(databasePath);
    expect(reopened.state().conversations.find(item => item.id === group.id)?.title).toBe('蓝色海边');
    expect(reopened.updateConversation(group.id, { title: '   ' }).title).toBe('我、大肥鱼和小蓝的群聊');
    expect(reopened.createConversation('不会重复创建', ['deepseek-flash', 'deepseek-sister']).id).toBe(group.id);
  });
  it('reuses exactly the same group for a canonical set of members, independent of ordering or title', () => {
    const { store } = fixture();
    const first = store.createConversation('我们的群聊', ['deepseek-sister', 'deepseek-flash']);
    expect(store.createConversation('另一个名字', ['deepseek-flash', 'deepseek-sister', 'deepseek-sister']).id).toBe(first.id);
    expect(store.state().conversations.filter(chat => chat.kind === 'group')).toHaveLength(1);
    expect(store.state().conversations.find(chat => chat.id === first.id)?.title).toBe('我们的群聊');
  });
  it('merges old duplicate rooms on reopening without losing messages, task references, search or send idempotency', () => {
    const { store, databasePath } = fixture();
    const first = store.createConversation('我们的群聊', ['deepseek-sister', 'deepseek-flash']);
    const legacy = store.createConversation('旧副本', ['deepseek-sister']);
    const source = { conversationId: legacy.id, authorId: 'user', content: '旧群中的工作要求', clientId: 'legacy-send' };
    const message = store.appendMessage(source);
    const action = store.createAction({ conversationId: legacy.id, companionId: 'deepseek-sister', sourceMessageId: message.id, title: '旧群任务', status: 'succeeded' });
    store.appendMessage({ conversationId: legacy.id, authorId: 'deepseek-sister', content: '旧群结果已经保留', replyToId: message.id, kind: 'action', actionId: action.id });
    close(store);
    // Emulate the previous release, which allowed two identical member sets.
    const db = new (BetterSqlite3 as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } })(databasePath);
    db.prepare('INSERT INTO conversation_members(conversation_id,companion_id) VALUES(?,?)').run(legacy.id, 'deepseek-flash');
    db.close();
    const reopened = open(databasePath);
    expect(reopened.state().conversations.filter(chat => chat.kind === 'group')).toHaveLength(1);
    expect(reopened.messages({ conversationId: legacy.id }).messages.map(item => item.conversationId)).toEqual([first.id, first.id]);
    expect(reopened.listAction(first.id)[0]).toMatchObject({ id: action.id, conversationId: first.id, sourceMessageId: message.id });
    expect(reopened.search({ conversationId: first.id, query: '旧群中的' }).messages[0]?.id).toBe(message.id);
    expect(reopened.appendMessageResult(source)).toMatchObject({ inserted: false, message: { id: message.id, conversationId: first.id } });
  });
  it('seeds only once and keeps one permanent private chat across restart', () => {
    const { databasePath, store } = fixture();
    const initial = store.state();
    expect(initial.companions.map((item) => item.id)).toEqual(['deepseek-sister', 'deepseek-flash']);
    const chat = store.openPrivate('deepseek-sister');
    expect(store.openPrivate('deepseek-sister').id).toBe(chat.id);
    const welcome = store.messages({ conversationId: chat.id }).messages;
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ kind: 'notice', authorId: 'deepseek-sister' });
    store.appendMessage({ conversationId: chat.id, authorId: 'user', content: '你好，明天再聊', clientId: 'client-one' });
    close(store);
    const reopened = open(databasePath);
    expect(reopened.openPrivate('deepseek-sister').id).toBe(chat.id);
    expect(reopened.messages({ conversationId: chat.id }).messages.map((item) => item.content)).toEqual([welcomes['deepseek-sister'], '你好，明天再聊']);
    expect(reopened.state().conversations).toHaveLength(2);
  });

  it('deduplicates exact send retries globally, including after restart', () => {
    const { databasePath, store } = fixture();
    const chat = store.openPrivate('deepseek-sister');
    const input = { conversationId: chat.id, authorId: 'user', content: '只发送一次', clientId: 'retry-client' };
    const first = store.appendMessageResult(input);
    expect(first.inserted).toBe(true);
    expect(store.appendMessageResult(input)).toEqual({ message: first.message, inserted: false });
    expect(() => store.appendMessage({ ...input, content: '不同内容' })).toThrow('重试标识');
    close(store);
    const reopened = open(databasePath);
    expect(reopened.appendMessageResult(input)).toEqual({ message: first.message, inserted: false });
    expect(() => reopened.appendMessage({ ...input, conversationId: 'private-deepseek-flash' })).toThrow('重试标识');
    expect(reopened.messages({ conversationId: chat.id }).messages).toHaveLength(2);
  });

  it('pages by stable sequence with bounded limits and searches Chinese text through FTS', () => {
    const { store } = fixture();
    const chat = store.openPrivate('deepseek-sister');
    for (let i = 0; i < 12; i++) store.appendMessage({ conversationId: chat.id, authorId: 'user', content: `消息${i}：杭州旅行计划` });
    const newest = store.messages({ conversationId: chat.id, limit: 5 });
    expect(newest.hasMore).toBe(true);
    expect(newest.messages).toHaveLength(5);
    const older = store.messages({ conversationId: chat.id, before: newest.messages[0]!.sequence, limit: 5 });
    const oldest = store.messages({ conversationId: chat.id, before: older.messages[0]!.sequence, limit: 5 });
    expect(oldest.hasMore).toBe(false);
    expect(new Set([...oldest.messages, ...older.messages, ...newest.messages].map((item) => item.id)).size).toBe(13);
    expect(() => store.messages({ conversationId: chat.id, limit: 101 })).toThrow();
    const search = store.search({ conversationId: chat.id, query: '杭州旅行', limit: 4 });
    expect(search.messages).toHaveLength(4);
    expect(search.hasMore).toBe(true);
    expect(store.search({ query: '杭州', limit: 100 }).messages).toHaveLength(12);
    expect(store.search({ query: '" OR 1=1 --' }).messages).toHaveLength(0);
    expect(store.search({ conversationId: 'private-deepseek-flash', query: '杭州旅行' }).messages).toHaveLength(0);
  });

  it('persists read markers without marking later incoming messages read', () => {
    const { databasePath, store } = fixture();
    const chat = store.openPrivate('deepseek-sister');
    expect(chat.unread).toBe(1);
    store.markRead(chat.id);
    store.appendMessage({ conversationId: chat.id, authorId: 'user', content: '在吗' });
    const first = store.appendMessage({ conversationId: chat.id, authorId: 'deepseek-sister', content: '在的' });
    store.appendMessage({ conversationId: chat.id, authorId: 'deepseek-sister', content: '今天怎么样' });
    expect(store.markRead(chat.id, first.sequence).unread).toBe(1);
    close(store);
    const reopened = open(databasePath);
    expect(reopened.openPrivate('deepseek-sister').unread).toBe(1);
    expect(reopened.markRead(chat.id, first.sequence - 1).unread).toBe(1);
    expect(reopened.markRead(chat.id).unread).toBe(0);
  });

  it('validates group membership, keeps history and rejects cross-chat references', () => {
    const { databasePath, store } = fixture();
    const group = store.createConversation('蓝色海边', ['deepseek-sister', 'deepseek-flash', 'deepseek-flash']);
    expect(group.memberIds).toEqual(['deepseek-sister', 'deepseek-flash']);
    const message = store.appendMessage({ conversationId: group.id, authorId: 'deepseek-flash', content: '一起看海' });
    expect(store.updateConversation(group.id, { memberIds: ['deepseek-sister'], title: '慢慢看海', muted: true, pinned: true })).toMatchObject({ memberIds: ['deepseek-sister'], title: '慢慢看海', muted: true, pinned: true });
    expect(() => store.appendMessage({ conversationId: group.id, authorId: 'deepseek-flash', content: '仍然发言' })).toThrow('不是聊天成员');
    expect(() => store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', replyToId: message.id, content: '跨聊天引用' })).toThrow('不属于这个聊天');
    expect(() => store.updateConversation('private-deepseek-sister', { memberIds: ['deepseek-flash'] })).toThrow('不能替换');
    close(store);
    const reopened = open(databasePath);
    expect(reopened.state().conversations.find((item) => item.id === group.id)).toMatchObject({ memberIds: ['deepseek-sister'], pinned: true });
    expect(reopened.messages({ conversationId: group.id }).messages[0]!.id).toBe(message.id);
  });

  it('isolates private memories and prevents changing ownership through an ID', () => {
    const { databasePath, store } = fixture();
    const message = store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '我喜欢慢慢看海' });
    const memory = store.saveMemory({ companionId: 'deepseek-sister', content: '用户喜欢慢慢看海', sourceMessageId: message.id, origin: 'user' });
    expect(store.listMemory('deepseek-flash')).toEqual([]);
    expect(() => store.saveMemory({ companionId: 'deepseek-flash', content: '偷看姐姐私聊', sourceMessageId: message.id, origin: 'companion' })).toThrow('不是聊天成员');
    expect(() => store.saveMemory({ id: memory.id, companionId: 'deepseek-flash', content: '修改记忆归属', origin: 'user' })).toThrow('另一个伙伴');
    store.saveMemory({ ...memory, content: '用户目前喜欢慢慢看海' });
    close(store);
    const reopened = open(databasePath);
    expect(reopened.listMemory('deepseek-sister')[0]!.content).toBe('用户目前喜欢慢慢看海');
    reopened.deleteMemory(memory.id);
    expect(reopened.listMemory('deepseek-sister')).toEqual([]);
  });

  it('derives memory conversation provenance from actual messages beyond recent context', () => {
    const { databasePath, store } = fixture();
    const group = store.createConversation('持久共同经历', ['deepseek-sister', 'deepseek-flash']);
    const message = store.appendMessage({ conversationId: group.id, authorId: 'user', content: '下次去看海' });
    const memory = store.saveMemory({ companionId: 'deepseek-sister', content: '群里约定下次去看海', sourceMessageId: message.id, origin: 'companion' });
    expect(memory.sourceConversationId).toBe(group.id);
    const forgedInput = { companionId: 'deepseek-sister', content: '只属于姐姐私聊', sourceMessageId: 'missing', origin: 'user' as const, sourceConversationId: group.id };
    expect(() => store.saveMemory(forgedInput)).toThrow('来源消息不存在');
    const privateSource = store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '私聊的约定' });
    const derived = store.saveMemory({ ...forgedInput, sourceMessageId: privateSource.id });
    expect(derived.sourceConversationId).toBe('private-deepseek-sister');
    for (let index = 0; index < 55; index++) store.appendMessage({ conversationId: group.id, authorId: 'user', content: `后来第${index}条聊天` });
    expect(store.messages({ conversationId: group.id, limit: 50 }).messages.some(value => value.id === message.id)).toBe(false);
    expect(store.listMemory('deepseek-sister').find(value => value.id === memory.id)?.sourceConversationId).toBe(group.id);
    close(store);
    // Simulate a historical JSON row written before conversation provenance
    // was included. Reads recover the trustworthy scope from its source ID.
    const RawDatabase = BetterSqlite3 as { new(filename: string): { prepare(sql: string): { run(...parameters: unknown[]): unknown }; close(): void } };
    const db = new RawDatabase(databasePath);
    const { sourceConversationId: _oldScope, ...legacy } = memory;
    void _oldScope;
    db.prepare('UPDATE memories SET data=? WHERE id=?').run(JSON.stringify(legacy), memory.id);
    db.close();
    const reopened = open(databasePath);
    expect(reopened.listMemory('deepseek-sister').find(value => value.id === memory.id)?.sourceConversationId).toBe(group.id);
    expect(reopened.listMemory('deepseek-flash')).toEqual([]);
  });

  it('does not respawn removed contacts, and restores built-ins with their edits and history', () => {
    const { databasePath, store } = fixture();
    const modified = store.updateCompanion('deepseek-sister', { ...seeds[0]!, name: '海边的大肥鱼', persona: '修改后的角色设定' });
    store.deleteCompanion('deepseek-sister');
    expect(() => store.openPrivate('deepseek-sister')).toThrow('已移除');
    close(store);
    const reopened = open(databasePath);
    expect(reopened.state().companions.map((item) => item.id)).toEqual(['deepseek-flash']);
    expect(reopened.messages({ conversationId: 'private-deepseek-sister' }).messages).toHaveLength(1);
    expect(reopened.restoreBuiltin('deepseek-sister')).toEqual(modified);
    expect(reopened.restoreBuiltin('deepseek-sister')).toEqual(modified);
    expect(reopened.messages({ conversationId: 'private-deepseek-sister' }).messages).toHaveLength(1);
    const custom = reopened.createCompanion({ ...seeds[0]!, name: '新伙伴', model: '', avatar: 'custom' });
    expect(custom.builtin).toBe(false);
    expect(reopened.openPrivate(custom.id).memberIds).toEqual([custom.id]);
  });

  it('owns attachment paths by ID and attaches only registered files', () => {
    const { databasePath, store } = fixture();
    const stored = { attachment: { id: 'file-one', name: '海边.jpg', size: 123, mime: 'image/jpeg' }, relativePath: 'attachments/file-one.jpg' };
    store.registerAttachment(stored);
    expect(() => store.registerAttachment({ ...stored, relativePath: '../secrets' })).toThrow();
    expect(() => store.registerAttachment({ ...stored, relativePath: 'attachments/file-two.jpg' })).toThrow('必须与文件标识');
    const message = store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '', attachmentIds: ['file-one'] });
    expect(message.attachments).toEqual([stored.attachment]);
    expect(() => store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '', attachmentIds: ['missing'] })).toThrow('附件不存在');
    close(store);
    expect(open(databasePath).getAttachment('file-one')).toEqual(stored);
  });

  it('persists registered image avatars and can restore the name avatar without retaining the old ID', () => {
    const { databasePath, store } = fixture();
    store.registerAttachment({ attachment: { id: 'portrait-image', name: '伙伴头像.png', mime: 'image/png', size: 512 }, relativePath: 'attachments/portrait-image.png' });
    const draft: CompanionSeed = { ...seeds[0]!, id: 'unused-draft-id', name: '海盐', avatar: 'custom', avatarAttachmentId: 'portrait-image' };
    const companion = store.createCompanion(draft);
    expect(companion.avatarAttachmentId).toBe('portrait-image');
    close(store);
    const reopened = open(databasePath);
    expect(reopened.state().companions.find(item => item.id === companion.id)).toMatchObject({ name: '海盐', avatar: 'custom', avatarAttachmentId: 'portrait-image' });
    reopened.updateCompanion(companion.id, { ...seeds[0]!, name: '海盐', avatar: 'custom' });
    close(reopened);
    const again = open(databasePath);
    const nameAvatar = again.state().companions.find(item => item.id === companion.id)!;
    expect(nameAvatar.avatar).toBe('custom');
    expect(nameAvatar.avatarAttachmentId).toBeUndefined();
    expect(again.getAttachment('portrait-image').attachment.mime).toBe('image/png');
    again.updateCompanion(companion.id, { ...draft, avatarAttachmentId: 'portrait-image' });
    expect(again.state().companions.find(item => item.id === companion.id)?.avatarAttachmentId).toBe('portrait-image');
  });

  it('rejects missing or non-image avatar attachments without creating or changing contacts', () => {
    const { store } = fixture();
    store.registerAttachment({ attachment: { id: 'document-avatar', name: '不是头像.pdf', mime: 'application/pdf', size: 128 }, relativePath: 'attachments/document-avatar.pdf' });
    const before = store.state();
    expect(() => store.createCompanion({ ...seeds[0]!, avatarAttachmentId: 'missing-image' })).toThrow('附件不存在');
    expect(() => store.createCompanion({ ...seeds[0]!, avatarAttachmentId: 'document-avatar' })).toThrow('头像必须');
    expect(() => store.updateCompanion('deepseek-sister', { ...seeds[0]!, name: '不应保存', avatarAttachmentId: 'document-avatar' })).toThrow('头像必须');
    expect(store.state()).toEqual(before);
    for (const [extension, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif']]) {
      const id = `avatar-${extension}`;
      store.registerAttachment({ attachment: { id, name: `头像.${extension}`, mime: mime!, size: 128 }, relativePath: `attachments/${id}.${extension}` });
      expect(store.updateCompanion('deepseek-sister', { ...seeds[0]!, avatarAttachmentId: id }).avatarAttachmentId).toBe(id);
    }
  });

  it('persists action provenance and marks unfinished actions interrupted on service recovery', () => {
    const { databasePath, store } = fixture();
    const message = store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '帮我整理路线' });
    const action = store.createAction({ conversationId: message.conversationId, companionId: 'deepseek-sister', sourceMessageId: message.id, title: '整理路线', status: 'queued' });
    store.updateAction(action.id, { status: 'running', taskId: 'task-one', sessionId: 'internal-dsh-session' });
    expect(() => store.createAction({ ...action, conversationId: 'private-deepseek-flash', companionId: 'deepseek-flash' })).toThrow('不属于这个聊天');
    close(store);
    const reopened = open(databasePath);
    reopened.interruptPendingActions();
    expect(reopened.listAction(message.conversationId)[0]).toMatchObject({ id: action.id, status: 'interrupted', sourceMessageId: message.id, taskId: 'task-one' });
    reopened.updateAction(action.id, { status: 'succeeded', result: '完成的路线' });
    reopened.interruptPendingActions();
    expect(reopened.listAction(message.conversationId)[0]!.status).toBe('succeeded');
  });

  it('persists proactive throttling and never counts the same unanswered message twice', () => {
    const { databasePath, store } = fixture();
    const first = store.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '明天再聊' });
    expect(store.getProactive('deepseek-sister')).toEqual({ count: 0 });
    store.recordProactive('deepseek-sister', first.id, '2026-10-13T02:00:00.000Z', '2026-10-13');
    close(store);
    const reopened = open(databasePath);
    expect(reopened.getProactive('deepseek-sister')).toMatchObject({ lastUserMessageId: first.id, count: 1, date: '2026-10-13' });
    expect(reopened.recordProactive('deepseek-sister', first.id, '2026-10-13T03:00:00.000Z', '2026-10-13').count).toBe(1);
    const second = reopened.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '今天很好' });
    expect(reopened.recordProactive('deepseek-sister', second.id, '2026-10-13T06:00:00.000Z', '2026-10-13').count).toBe(2);
    expect(reopened.getProactive('deepseek-flash')).toEqual({ count: 0 });
    expect(() => reopened.recordProactive('deepseek-flash', second.id, '2026-10-13T06:00:00.000Z', '2026-10-13')).toThrow('不是聊天成员');
  });

  it('persists role-specific connection metadata without keys, and clears an override on update', () => {
    const { databasePath, store } = fixture();
    const llm = { apiFormat: 'anthropic' as const, baseUrl: 'https://role.example/v1', model: 'role-model' };
    const created = store.createCompanion({ ...seeds[0]!, name: '独立连接', avatar: 'custom', llm });
    expect(created.llm).toEqual(llm);
    expect(companionStorageCommandSchema.safeParse({ type: 'companion.create', companion: seeds[0], apiKey: 'never-send-to-worker' }).success).toBe(false);
    const withExtraFields = { ...seeds[0]!, llm: { ...llm, apiKey: 'never-write-to-sqlite', hasKey: true } };
    store.updateCompanion('deepseek-sister', withExtraFields);
    close(store);
    const reopened = open(databasePath);
    expect(reopened.state().companions.find((companion) => companion.id === created.id)?.llm).toEqual(llm);
    expect(reopened.state().companions.find((companion) => companion.id === 'deepseek-sister')?.llm).toEqual(llm);
    expect(JSON.stringify(reopened.state())).not.toContain('never-write-to-sqlite');
    reopened.updateCompanion('deepseek-sister', { ...seeds[0]!, name: '继承全局' });
    close(reopened);
    const again = open(databasePath);
    expect(again.state().companions.find((companion) => companion.id === 'deepseek-sister')?.llm).toBeUndefined();
  });

  it('starts built-in contacts with global model inheritance', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-default-companions-'));
    roots.push(root);
    const store = new CompanionsStore(path.join(root, 'messages.sqlite'));
    stores.push(store);
    expect(store.state().companions).toHaveLength(BUILTIN_COMPANIONS.length);
    for (const companion of store.state().companions) {
      expect(companion.model).toBe('');
      expect(companion.llm).toBeUndefined();
    }
  });

  it('persists empty-generation attempt cooldown separately from sent count', () => {
    const { databasePath, store } = fixture();
    const companionId = 'deepseek-sister';
    const firstAt = '2026-10-13T02:00:00.000Z';
    const first = store.request({ type: 'proactive.attempt', companionId, at: firstAt }).proactive;
    expect(first).toEqual({ count: 0, lastAttemptAt: firstAt });
    close(store);
    const reopened = open(databasePath);
    expect(reopened.getProactive(companionId)).toEqual(first);
    const laterAt = '2026-10-13T03:00:00.000Z';
    expect(reopened.recordProactiveAttempt(companionId, laterAt)).toEqual({ count: 0, lastAttemptAt: laterAt });
    expect(reopened.recordProactiveAttempt(companionId, firstAt).lastAttemptAt).toBe(laterAt);
    const source = reopened.appendMessage({ conversationId: 'private-deepseek-sister', authorId: 'user', content: '我回来了' });
    expect(reopened.recordProactive(companionId, source.id, laterAt, '2026-10-13')).toMatchObject({ count: 1, lastAttemptAt: laterAt, lastSentAt: laterAt });
    expect(reopened.recordProactiveAttempt(companionId, '2026-10-13T04:00:00.000Z')).toMatchObject({ count: 1, lastSentAt: laterAt, lastAttemptAt: '2026-10-13T04:00:00.000Z' });
    expect(reopened.getProactive('deepseek-flash')).toEqual({ count: 0 });
  });

  it('refuses newer database schema before any write and preserves original bytes', () => {
    const { databasePath, store } = fixture();
    close(store);
    const RawDatabase = BetterSqlite3 as { new(filename: string): { pragma(input: string): unknown; close(): void } };
    const db = new RawDatabase(databasePath);
    db.pragma('user_version = 999');
    db.close();
    const checksum = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex');
    const original = checksum();
    expect(() => new CompanionsStore(databasePath, seeds, welcomes)).toThrow('更新版本');
    expect(checksum()).toBe(original);
  });

  it('rejects invalid internal commands and rolls back failed writes without sequence noise', () => {
    const { store } = fixture();
    const conversationId = 'private-deepseek-sister';
    const before = store.messages({ conversationId }).messages;
    expect(() => store.appendMessage({ conversationId, authorId: 'user', content: 'bad', replyToId: 'missing' })).toThrow();
    expect(store.messages({ conversationId }).messages).toEqual(before);
    expect(store.request({ type: 'messages', conversationId, limit: 1 })).toMatchObject({ ok: true, hasMore: false });
    expect(store.request({ type: 'conversation.update', id: conversationId, muted: true }).conversation?.muted).toBe(true);
  });
});
