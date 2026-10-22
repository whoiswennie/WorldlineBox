// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionConversation, CompanionMessage, CompanionState, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionTopic } from '../../src/shared/companion-topic';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); });
const date = '2026-10-23T08:00:00.000Z';
const room: CompanionConversation = { id: 'room', title: '伙伴群聊', kind: 'group', memberIds: ['deepseek-sister', 'deepseek-flash'], pinned: true, muted: false, unread: 0, updatedAt: date, lastMessage: '日常消息' };
const topic = (id: string, title: string): CompanionTopic => ({ id, title, conversationId: room.id, kind: 'game', status: 'active', participantIds: ['user', ...room.memberIds], invitedIds: [], tags: [], moderatorId: 'user', revision: 1, createdAt: date, updatedAt: date });
const message = (sequence: number, content: string, topicId?: string): CompanionMessage => ({ id: `m-${sequence}`, sequence, content, conversationId: room.id, authorId: 'user', kind: 'text', status: 'sent', attachments: [], createdAt: date, topicId });
function fixture() {
  let conversation = { ...room };
  let topics = [topic('wolves', '狼人杀'), topic('trip', '周末旅行')];
  let messages = [message(1, '日常消息'), message(2, '第一局开始', 'wolves'), message(3, '去海边', 'trip')];
  const listeners = new Set<() => void>();
  let pendingPick: ((value: CompanionsResponse) => void) | undefined;
  let deferPick = false;
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    switch (input.type) {
      case 'state': return { ok: true, state: { companions: BUILTIN_COMPANIONS.map(role => ({ ...role, builtin: true, createdAt: date })), conversations: [conversation], activities: [], configured: true } satisfies CompanionState };
      case 'topic.list': return { ok: true, topics: topics.filter(topic => !input.query || topic.title.includes(input.query)), hasMore: false };
      case 'topic.activate': conversation = { ...conversation, activeTopicId: input.topicId ?? undefined }; return { ok: true, conversation };
      case 'topic.create': { const created = { ...topic('created-topic', input.title), participantIds: ['user'], invitedIds: input.participantIds ?? room.memberIds, tags: input.tags ?? [], kind: input.kind }; topics = [...topics, created]; return { ok: true, topic: created }; }
      case 'topic.pause': case 'topic.resume': case 'topic.close': case 'topic.reopen': {
        const changed = { ...topics.find(item => item.id === input.topicId)!, status: input.type === 'topic.pause' ? 'paused' as const : input.type === 'topic.close' ? 'closed' as const : 'active' as const, revision: input.expectedRevision + 1 };
        topics = topics.map(item => item.id === changed.id ? changed : item); return { ok: true, topic: changed };
      }
      case 'topic.update': { const changed = { ...topics.find(topic => topic.id === input.topicId)!, title: input.patch.title!, tags: input.patch.tags ?? [], revision: input.expectedRevision + 1 }; topics = topics.map(topic => topic.id === changed.id ? changed : topic); return { ok: true, topic: changed }; }
      case 'topic.fork': { const created = { ...topics.find(topic => topic.id === input.topicId)!, id: 'forked', title: input.title, forkedFromTopicId: input.topicId, revision: 1 }; topics = [...topics, created]; return { ok: true, topic: created }; }
      case 'topic.join': case 'topic.leave': { const old = topics.find(topic => topic.id === input.topicId)!; const joined = input.type === 'topic.join'; const changed = { ...old, participantIds: joined ? [...old.participantIds, 'user'] : old.participantIds.filter(id => id !== 'user'), invitedIds: joined ? old.invitedIds.filter(id => id !== 'user') : [...old.invitedIds, 'user'], revision: old.revision + 1 }; topics = topics.map(topic => topic.id === changed.id ? changed : topic); return { ok: true, topic: changed }; }
      case 'topic.delete': topics = topics.filter(topic => topic.id !== input.topicId); if (conversation.activeTopicId === input.topicId) conversation = { ...conversation, activeTopicId: undefined }; return { ok: true };
      case 'messages': {
        const all = messages.filter(item => input.topicId === undefined || (item.topicId ?? null) === input.topicId);
        return { ok: true, messages: all, hasMore: false, hasNewer: false };
      }
      case 'message.send': {
        const sent = { ...message(messages.length + 1, input.content, input.topicId ?? undefined), id: input.clientId, attachmentIds: input.attachmentIds };
        messages = [...messages, sent]; return { ok: true, message: sent };
      }
      case 'attachment.pick': if (deferPick) return new Promise(resolve => { pendingPick = resolve; }); return { ok: true, attachments: [] };
      case 'actions': return { ok: true, actions: [] };
      default: return { ok: true };
    }
  });
  const api: WorldlineBoxCompanionsApi = { request, onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); }, onReplyStream: () => () => undefined };
  return { api, request, deferAttachment() { deferPick = true; }, async finishAttachment() { await act(() => pendingPick?.({ ok: true, attachments: [{ id: 'image', name: '附件只属于狼人杀.png', mime: 'image/png', size: 10 }] })); } };
}
async function mount(api: WorldlineBoxCompanionsApi) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<Companions api={api} onOpenSettings={() => undefined} />));
}
function button(label: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`); return found;
}
async function click(label: string, scope?: ParentNode) { await act(() => button(label, scope).click()); }
async function select(label: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(() => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
}
async function fill(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
function input() { return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!; }
function timeline() { return container.querySelector('[data-companion-messages]')!.textContent; }
function row(title: string) { return [...container.querySelectorAll<HTMLElement>('.companions-topic-library-list article')].find(element => element.querySelector('strong')!.textContent === title)!; }
async function openTopics() { if (!container.querySelector('section[aria-label="话题列表"]')) { await click('选择发送话题'); await act(() => new Promise(resolve => setTimeout(resolve, 10))); } }
async function enterTopic(title: string) { await openTopics(); await click('进入话题', row(title)); }
function destination() { return container.querySelector('[aria-label="当前发送话题"]')!.textContent; }

it('keeps current destination separate from historical topic browsing and sends explicit topic identities', async () => {
  const test = fixture(); await mount(test.api);
  expect(timeline()).toContain('日常消息'); expect(timeline()).not.toContain('第一局开始');
  await fill('输入消息', '日常草稿');
  await enterTopic('狼人杀');
  expect(timeline()).toContain('第一局开始'); expect(timeline()).not.toContain('日常消息'); expect(input().value).toBe('');
  await fill('输入消息', '狼人杀草稿');
  await click('查看记录', row('周末旅行'));
  expect(timeline()).toContain('去海边'); expect(timeline()).not.toContain('第一局开始');
  expect(container.querySelector('.companions-composer-destination')!.textContent).toContain('狼人杀');
  await click('发送');
  expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', content: '狼人杀草稿', topicId: 'wolves' }));
  await click('返回日常'); expect(input().value).toBe('日常草稿');
  await click('发送'); expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', content: '日常草稿', topicId: null }));
  expect(test.request.mock.calls.some(([call]) => call.type === 'topic.read')).toBe(false);
});

it('creates game topics, pauses and resumes them, and preserves pending attachment ownership across topic switches', async () => {
  const test = fixture(); await mount(test.api);
  await click('新建话题'); await fill('话题名称', '狼人杀第二局'); await select('话题类型', 'game');
  await act(() => container.querySelector<HTMLFormElement>('form[aria-label="新建聊天话题"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(test.request).toHaveBeenCalledWith({ type: 'topic.create', conversationId: 'room', title: '狼人杀第二局', kind: 'game', tags: [], participantIds: room.memberIds });
  expect(destination()).toContain('狼人杀第二局');
  await click('暂停话题'); expect(input().disabled).toBe(true); expect(button('发送').disabled).toBe(true);
  await click('返回日常'); await openTopics(); await click('恢复并进入', row('狼人杀第二局'));
  expect(test.request).toHaveBeenCalledWith({ type: 'topic.resume', conversationId: 'room', topicId: 'created-topic', expectedRevision: 2 });
  expect(input().disabled).toBe(false);
  await enterTopic('狼人杀'); test.deferAttachment(); await click('发送文件或图片');
  await enterTopic('周末旅行'); await test.finishAttachment();
  expect(container.querySelector('.companions-draft-attachments')).toBeNull();
  await enterTopic('狼人杀'); expect(container.querySelector('.companions-draft-attachments')!.textContent).toContain('附件只属于狼人杀.png');
  await click('结束话题'); expect(destination()).toContain('日常聊天');
});

it('manages long-lived topics with rename, restore, fork, search and explicit deletion', async () => {
  const test = fixture(); await mount(test.api);
  await openTopics();
  await click('编辑话题', row('狼人杀')); await fill('新的话题名称', '狼人杀长期会话'); await fill('编辑话题标签', '游戏, 长期');
  await act(() => container.querySelector<HTMLFormElement>('form[aria-label="重命名话题"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(test.request).toHaveBeenCalledWith({ type: 'topic.update', conversationId: 'room', topicId: 'wolves', expectedRevision: 1, patch: { title: '狼人杀长期会话', tags: ['游戏', '长期'], invitedIds: [] } });
  await enterTopic('狼人杀长期会话'); await click('结束话题'); expect(row('狼人杀长期会话').textContent).toContain('已结束');
  await click('恢复并进入', row('狼人杀长期会话')); expect(destination()).toContain('狼人杀长期会话');
  await click('创建分支', row('狼人杀长期会话')); await fill('分支话题名称', '平行第二局');
  await act(() => container.querySelector<HTMLFormElement>('form[aria-label="创建话题分支"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(test.request).toHaveBeenCalledWith({ type: 'topic.fork', conversationId: 'room', topicId: 'wolves', title: '平行第二局' });
  expect(destination()).toContain('平行第二局');
  await fill('搜索话题', '平行'); await act(() => new Promise(resolve => setTimeout(resolve, 230)));
  expect(row('平行第二局')).toBeDefined(); expect(row('周末旅行')).toBeUndefined();
  await click('删除', row('平行第二局'));
  expect(test.request.mock.calls.some(([call]) => call.type === 'topic.delete')).toBe(false);
  await click('确认删除话题', row('平行第二局'));
  expect(test.request).toHaveBeenCalledWith({ type: 'topic.delete', conversationId: 'room', topicId: 'forked', expectedRevision: 1 });
  expect(destination()).toContain('日常聊天');
  expect(container.textContent).not.toContain('归档');
});

it('joins and leaves only as the user while other participants remain in their own topics', async () => {
  const test = fixture(); await mount(test.api); await openTopics(); await enterTopic('狼人杀');
  await click('退出话题', row('狼人杀'));
  expect(test.request).toHaveBeenCalledWith({ type: 'topic.leave', conversationId: 'room', topicId: 'wolves' });
  expect(destination()).toContain('日常聊天'); expect(row('狼人杀').textContent).toContain('受邀加入');
  expect(row('狼人杀').textContent).toContain('大肥鱼');
  await click('加入话题', row('狼人杀'));
  expect(test.request).toHaveBeenCalledWith({ type: 'topic.join', conversationId: 'room', topicId: 'wolves' });
  expect(destination()).toContain('狼人杀');
  expect(test.request.mock.calls.filter(([call]) => call.type.startsWith('topic.')).every(([call]) => !('readerId' in call))).toBe(true);
});

it('pages and searches large topic collections without building an unbounded selector', async () => {
  const test = fixture(); const original = test.request.getMockImplementation()!;
  test.request.mockImplementation(async input => {
    if (input.type !== 'topic.list') return original(input);
    const offset = input.before === undefined ? 1000 : input.before;
    return { ok: true, topics: Array.from({ length: 50 }, (_, index) => topic(`topic-${offset - index}`, `历史会话 ${offset - index}`)), hasMore: offset > 50, topicNextCursor: offset - 50 };
  });
  await mount(test.api); await openTopics();
  expect(container.querySelectorAll('.companions-topic-library-list article')).toHaveLength(50);
  expect(container.querySelectorAll('select[aria-label="话题历史筛选"] option').length).toBe(3);
  await click('读取更早的话题');
  expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'topic.list', before: 950, limit: 50 }));
  expect(container.querySelectorAll('.companions-topic-library-list article')).toHaveLength(100);
  await fill('搜索话题', '历史 会话'); await fill('按标签搜索话题', '游戏,夜晚');
  await act(() => new Promise(resolve => setTimeout(resolve, 230)));
  expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'topic.list', query: '历史 会话', tags: ['游戏', '夜晚'], before: undefined, limit: 50 }));
  await select('话题状态筛选', 'paused'); await act(() => new Promise(resolve => setTimeout(resolve, 230)));
  expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'topic.list', status: 'paused', limit: 50 }));
});

it('allows an empty invitation list and validates tags before creating a topic', async () => {
  const test = fixture(); await mount(test.api); await click('新建话题');
  await fill('话题名称', '自己的工作区'); await fill('话题标签', 'x'.repeat(81));
  expect(button('创建并进入').disabled).toBe(true); expect(container.querySelector('[role="alert"]')!.textContent).toContain('80');
  await fill('话题标签', '写作,私稿');
  await act(() => container.querySelectorAll<HTMLInputElement>('form[aria-label="新建聊天话题"] input[type="checkbox"]').forEach(input => input.click()));
  await act(() => container.querySelector<HTMLFormElement>('form[aria-label="新建聊天话题"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(test.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'topic.create', title: '自己的工作区', participantIds: [], tags: ['写作', '私稿'] }));
});
