// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionAction, CompanionConversation, CompanionMemory, CompanionMessage, CompanionState, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });
const date = '2026-10-13T08:00:00.000Z';
const sisters: Companion[] = BUILTIN_COMPANIONS.map(item => ({ ...item, builtin: true, createdAt: date }));
function conversation(id: string, kind: 'private' | 'group', memberIds: string[], pinned = false): CompanionConversation { return { id, kind, title: kind === 'group' ? '海边小屋' : sisters.find(item => item.id === memberIds[0])!.name, memberIds, pinned, muted: false, unread: 0, updatedAt: date, lastMessage: '一起聊聊吧' }; }
function message(sequence: number, content = `第 ${sequence} 条消息`, extra: Partial<CompanionMessage> = {}): CompanionMessage { return { id: `message-${sequence}`, sequence, conversationId: 'private-sister', authorId: sequence % 2 ? 'user' : 'deepseek-sister', kind: 'text', content, createdAt: date, status: 'sent', attachments: [], ...extra }; }

function fixture(extra: Partial<CompanionState> = {}, initialMessages = [message(1, '帮我整理照片'), message(2, '我们慢慢来。')], initialActions: CompanionAction[] = []) {
  let state: CompanionState = { companions: sisters.map(item => ({ ...item })), conversations: [conversation('private-sister', 'private', ['deepseek-sister'], true), conversation('group-home', 'group', ['deepseek-sister', 'deepseek-flash'])], activities: [], configured: true, ...extra };
  let messages = initialMessages;
  let memories: CompanionMemory[] = [];
  let actions: CompanionAction[] = initialActions;
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    switch (input.type) {
      case 'state': return { ok: true, state };
      case 'messages': {
        const all = messages.filter(item => item.conversationId === input.conversationId);
        const anchor = input.around ? all.find(item => item.id === input.around) : undefined;
        const selected = all.filter(item => (input.before === undefined || item.sequence < input.before) && (input.after === undefined || item.sequence > input.after));
        const limit = input.limit ?? 50;
        const page = anchor ? [...all.filter(item => item.sequence <= anchor.sequence).slice(-Math.ceil(limit / 2)), ...all.filter(item => item.sequence > anchor.sequence).slice(0, Math.floor(limit / 2))] : input.after !== undefined ? selected.slice(0, limit) : selected.slice(-limit);
        return { ok: true, messages: page, hasMore: all.some(item => item.sequence < (page[0]?.sequence ?? 0)), hasNewer: all.some(item => item.sequence > (page.at(-1)?.sequence ?? Infinity)) };
      }
      case 'message.search': return { ok: true, messages: messages.filter(item => (!input.conversationId || item.conversationId === input.conversationId) && item.content.includes(input.query)) };
      case 'message.get': return { ok: true, message: messages.find(item => item.id === input.id) };
      case 'conversation.read': state = { ...state, conversations: state.conversations.map(item => item.id === input.id ? { ...item, unread: 0 } : item) }; return { ok: true };
      case 'conversation.open': {
        let selected = state.conversations.find(item => item.kind === 'private' && item.memberIds[0] === input.companionId);
        if (!selected) { selected = conversation(`private-${input.companionId}`, 'private', [input.companionId]); state = { ...state, conversations: [...state.conversations, selected] }; }
        return { ok: true, conversation: selected };
      }
      case 'conversation.create-group': {
        const selected = { ...conversation('new-group', 'group', input.memberIds), title: input.title };
        state = { ...state, conversations: [...state.conversations, selected] }; return { ok: true, conversation: selected };
      }
      case 'conversation.update': {
        state = { ...state, conversations: state.conversations.map(item => item.id === input.id ? { ...item, ...input, id: item.id } : item) };
        return { ok: true, conversation: state.conversations.find(item => item.id === input.id) };
      }
      case 'companion.create': {
        const companion: Companion = { ...input.companion, id: 'new-companion', builtin: false, createdAt: date };
        state = { ...state, companions: [...state.companions, companion] }; return { ok: true, companion };
      }
      case 'companion.update': {
        state = { ...state, companions: state.companions.map(item => item.id === input.id ? { ...item, ...input.companion } : item) };
        return { ok: true, companion: state.companions.find(item => item.id === input.id) };
      }
      case 'companion.delete': state = { ...state, companions: state.companions.filter(item => item.id !== input.id) }; return { ok: true };
      case 'companion.add-builtin': {
        const template = sisters.find(item => item.avatar === input.templateId)!;
        state = { ...state, companions: [...state.companions, template] }; return { ok: true, companion: template };
      }
      case 'message.send': {
        const sent = message((messages.at(-1)?.sequence ?? 0) + 1, input.content, { id: input.clientId, conversationId: input.conversationId, authorId: 'user', replyToId: input.replyToId, attachments: input.attachmentIds?.map(id => ({ id, name: '旅行照片.jpg', mime: 'image/jpeg', size: 2048 })) ?? [] });
        messages = [...messages, sent]; return { ok: true, message: sent };
      }
      case 'attachment.pick': return { ok: true, attachments: [{ id: 'photo', name: '旅行照片.jpg', mime: 'image/jpeg', size: 2048 }] };
      case 'memory.list': return { ok: true, memories: memories.filter(item => item.companionId === input.companionId) };
      case 'memory.save': {
        const saved: CompanionMemory = { id: input.id ?? 'memory-a', companionId: input.companionId, content: input.content, sourceMessageId: input.sourceMessageId, origin: 'user', createdAt: date, updatedAt: date };
        memories = [...memories.filter(item => item.id !== saved.id), saved]; return { ok: true, memories };
      }
      case 'memory.delete': memories = memories.filter(item => item.id !== input.id); return { ok: true };
      case 'actions': return { ok: true, actions: actions.filter(item => item.conversationId === input.conversationId) };
      case 'action.get': return { ok: true, action: actions.find(item => item.id === input.id) };
      case 'actions.page': {
        const items = actions.filter(item => item.conversationId === input.conversationId && (!input.companionId || item.companionId === input.companionId));
        return { ok: true, actionPage: { items: items.slice(0, input.limit), total: items.length, hasMore: false, owners: [] } };
      }
      case 'action.run': {
        actions = [...actions, { id: 'action-a', companionId: input.companionId, conversationId: input.conversationId, sourceMessageId: input.sourceMessageId, title: input.title, status: 'running', createdAt: date, updatedAt: date }]; return { ok: true, actions };
      }
      case 'action.cancel': actions = actions.map(item => item.id === input.id ? { ...item, status: 'cancelled' } : item); return { ok: true };
      default: return { ok: true };
    }
  });
  const api: WorldlineBoxCompanionsApi = { request, onChanged: vi.fn(next => { listener = next; return unsubscribe; }) };
  return { api, request, unsubscribe, state: () => state, async publish(next: Partial<CompanionState> = {}, nextMessages = messages) { state = { ...state, ...next }; messages = nextMessages; await act(() => listener?.()); }, async publishActions(next: CompanionAction[]) { actions = next; await act(() => listener?.()); }, memories: () => memories };
}
async function mount(api: WorldlineBoxCompanionsApi, isActive = true, onOpenSettings = vi.fn()) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<Companions api={api} isActive={isActive} onOpenSettings={onOpenSettings} />));
  return onOpenSettings;
}
function button(label: string, scope: ParentNode = container!): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  if (!found) throw new Error(`Button missing: ${label}`); return found;
}
async function click(label: string, scope?: ParentNode) { await act(() => button(label, scope).click()); }
async function fill(selector: string, value: string) {
  const element = container!.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  if (!element) throw new Error(`Input missing: ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
  return element;
}
async function select(selector: string, value: string) { const element = container!.querySelector<HTMLSelectElement>(selector)!; await act(() => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function submitDialog() { const form = container!.querySelector<HTMLFormElement>('[role="dialog"] form')!; await act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

it('searches and filters the full built-in catalogue and restores the selected role with its own template ID', async () => {
  const f = fixture({ companions: sisters.filter(item => item.id !== 'phoebe') });
  await mount(f.api); await click('联系人'); await click('添加新的伙伴');
  const dialog = container!.querySelector('[role="dialog"]')!;
  expect(dialog.querySelectorAll('[data-builtin-template]')).toHaveLength(15);
  await click('原创角色', dialog);
  expect([...dialog.querySelectorAll('[data-builtin-template]')].map(item => item.getAttribute('data-builtin-template'))).toEqual(['huan-white', 'huan-black']);
  await click('全部', dialog);
  await fill('input[aria-label="搜索内置角色"]', '菲比');
  expect(dialog.querySelectorAll('[data-builtin-template]')).toHaveLength(1);
  const card = dialog.querySelector('[data-builtin-template="phoebe"]')!;
  expect(card.querySelector('.companion-avatar')!.classList.contains('has-square-image')).toBe(true);
  await click('添加', card);
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.add-builtin', templateId: 'phoebe' });
});

it('keeps private and group conversations in the message list and opens the same private conversation from contacts', async () => {
  const f = fixture(); await mount(f.api);
  const navigation = container!.querySelector('nav[aria-label="伙伴导航"]')!;
  expect([...navigation.querySelectorAll('button')].map(item => item.textContent)).toEqual(['消息', '联系人']);
  expect(container!.querySelector('[aria-label="伙伴设置"]')).toBeNull();
  expect(container!.querySelectorAll('[data-companion-conversation]')).toHaveLength(2);
  expect(container!.querySelector('[data-companion-conversation]')!.getAttribute('data-companion-conversation')).toBe('private-sister');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('我们慢慢来。');
  await click('联系人'); await click('发消息');
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.open', companionId: 'deepseek-sister' });
  expect(f.state().conversations).toHaveLength(2);
  expect(container!.querySelector('[data-companion-conversation="private-sister"]')!.classList.contains('is-selected')).toBe(true);
});

it('keeps user messages literal while formatting companion replies as structural Markdown', async () => {
  const f = fixture({}, [message(1, '**原始输入**\n- 保留换行'), message(2, '**伙伴回复**\n\n- 一项结果')]);
  await mount(f.api);
  const userBubble = container!.querySelector('.companions-message.is-own .companions-message-bubble')!;
  expect(userBubble.textContent).toBe('**原始输入**\n- 保留换行');
  expect(userBubble.querySelector('strong, ul')).toBeNull();
  const reply = container!.querySelector('.companions-message:not(.is-own) .companions-message-content')!;
  expect(reply.querySelector('strong')!.textContent).toBe('伙伴回复');
  expect(reply.querySelector('li')!.textContent).toBe('一项结果');
});

it('bounds long drafts in the floating input and returns to a compact height when the draft is sent', async () => {
  const f = fixture(); await mount(f.api);
  const input = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!;
  let measuredHeight = 640;
  Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => measuredHeight });
  await fill('textarea[aria-label="输入消息"]', '很长的消息\n'.repeat(80));
  expect(input.style.height).toBe('176px');
  expect(input.parentElement!.className).toBe('companions-composer');
  measuredHeight = 20;
  await click('发送');
  expect(input.value).toBe('');
  expect(input.style.height).toBe('56px');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', content: '很长的消息\n'.repeat(80) }));
});

it('does not mark messages read while the module is hidden or the contact page is visible', async () => {
  const f = fixture({ conversations: [{ ...conversation('private-sister', 'private', ['deepseek-sister'], true), unread: 3 }] });
  const settings = await mount(f.api, false);
  expect(f.request.mock.calls.some(([input]) => input.type === 'conversation.read')).toBe(false);
  await act(() => root!.render(<Companions api={f.api} isActive onOpenSettings={settings} />));
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.read', id: 'private-sister' });
  await click('联系人'); f.request.mockClear();
  await f.publish({ conversations: [{ ...f.state().conversations[0]!, unread: 4 }] });
  expect(f.request.mock.calls.some(([input]) => input.type === 'conversation.read')).toBe(false);
  await click('消息');
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.read', id: 'private-sister' });
});

it('honors IME and Shift+Enter, accepts new input while the companion is thinking, and does not turn chat into a DSH task', async () => {
  const f = fixture({ activities: [{ companionId: 'deepseek-sister', conversationId: 'private-sister', status: 'thinking' }] });
  await mount(f.api); const textarea = await fill('textarea[aria-label="输入消息"]', '你好，今天看海吗？');
  expect(textarea.disabled).toBe(false);
  await act(() => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }));
  });
  expect(f.request.mock.calls.some(([input]) => input.type === 'message.send')).toBe(false);
  await act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', conversationId: 'private-sister', content: '你好，今天看海吗？' }));
  expect(f.request.mock.calls.some(([input]) => input.type === 'action.run')).toBe(false);
  expect(textarea.value).toBe(''); await click('取消回复');
  expect(f.request).toHaveBeenCalledWith({ type: 'reply.cancel', conversationId: 'private-sister' });
});

it('retains a failed message draft, shows the real error, and offers retry for a failed model reply', async () => {
  const failed = message(3, '服务暂时不可用', { kind: 'notice', authorId: 'system', status: 'failed' });
  const f = fixture({}, [message(1), failed]); const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(input => input.type === 'message.send' ? Promise.resolve({ ok: false, error: '网络连接中断，请稍后重试' }) : original(input));
  await mount(f.api); await fill('textarea[aria-label="输入消息"]', '不要丢掉这句话'); await click('发送');
  expect(container!.querySelector('[role="alert"]')!.textContent).toContain('网络连接中断');
  expect(container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!.value).toBe('不要丢掉这句话');
  await click('重试回复'); expect(f.request).toHaveBeenCalledWith({ type: 'reply.retry', conversationId: 'private-sister' });
});

it('coalesces a double send and keeps text entered during the pending acknowledgement', async () => {
  const f = fixture(); await mount(f.api); const original = f.request.getMockImplementation()!;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.request.mockImplementation(async input => { if (input.type === 'message.send') await pending; return original(input); });
  await fill('textarea[aria-label="输入消息"]', '第一句话');
  await act(() => { button('发送').click(); button('发送').click(); });
  expect(f.request.mock.calls.filter(([input]) => input.type === 'message.send')).toHaveLength(1);
  const textarea = await fill('textarea[aria-label="输入消息"]', '等待时想到的另一句话'); expect(textarea.disabled).toBe(false);
  await act(() => finish());
  expect(textarea.value).toBe('等待时想到的另一句话');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('第一句话');
});

it('sends a referenced message and previews its saved image inside the chat before revealing the file', async () => {
  const f = fixture(); await mount(f.api); await click('引用消息 2'); await click('发送文件或图片'); await click('发送');
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', replyToId: 'message-2', attachmentIds: ['photo'], content: '' }));
  expect(container!.querySelector('[aria-label="取消引用"]')).toBeNull();
  await act(() => container!.querySelector<HTMLButtonElement>('.companions-attachment')!.click());
  expect(container!.querySelector('[role="dialog"][aria-label="图片预览：旅行照片.jpg"]')).not.toBeNull();
  expect(f.request.mock.calls.some(([input]) => input.type === 'attachment.open')).toBe(false);
  await click('查看文件位置');
  expect(f.request).toHaveBeenCalledWith({ type: 'attachment.open', id: 'photo' });
  await click('关闭图片预览'); expect(container!.querySelector('.companions-image-preview')).toBeNull();
});

it('preserves a scrolled history position on new messages and preserves the anchor when older messages load', async () => {
  const history = Array.from({ length: 65 }, (_, index) => message(index + 1)); const f = fixture({}, history); await mount(f.api);
  const scroll = container!.querySelector<HTMLDivElement>('[data-companion-messages]')!;
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
  await act(() => { scroll.scrollTop = 200; scroll.dispatchEvent(new Event('scroll')); });
  await f.publish({}, [...history, message(66, '刚想到一件事。')]);
  expect(scroll.scrollTop).toBe(200); expect(container!.textContent).toContain('有新消息');
  expect(scroll.textContent).toContain('刚想到一件事。');
  await click('查看更早的消息'); expect(f.request).toHaveBeenCalledWith({ type: 'messages', conversationId: 'private-sister', before: 16, limit: 50 });
  expect(scroll.textContent).toContain('第 1 条消息'); expect(scroll.scrollTop).toBe(200);
  await click('回到最新消息'); expect(scroll.scrollTop).toBe(1000);
});

it('evicts messages during 80 consecutive history pages and returns directly to the newest page', async () => {
  const history = Array.from({ length: 5000 }, (_, index) => message(index + 1));
  const f = fixture({}, history); await mount(f.api);
  const scroll = container!.querySelector<HTMLDivElement>('[data-companion-messages]')!;
  for (let page = 0; page < 80; page++) {
    await click('查看更早的消息');
    expect(Number(scroll.dataset.windowCount)).toBeLessThanOrEqual(200);
    expect(scroll.querySelectorAll('[data-companion-message]').length).toBeLessThanOrEqual(200);
  }
  expect(scroll.textContent).not.toContain('第 5000 条消息');
  expect(container!.querySelector('[aria-label="回到最新消息"]')).not.toBeNull();
  await click('回到最新消息');
  expect(Number(scroll.dataset.windowCount)).toBe(50); expect(scroll.textContent).toContain('第 5000 条消息');
  expect(container!.querySelector('.companions-history-chip')).toBeNull();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'messages')).toHaveLength(82);
});

it('uses the messages plus button to choose a chat and reserves contact creation for the contacts tab', async () => {
  const f = fixture({ conversations: [] }, []); await mount(f.api);
  expect(container!.querySelector('[aria-label="添加联系人"]')).toBeNull();
  await click('发起聊天'); expect(container!.querySelector('[role="dialog"][aria-label="发起聊天"]')).not.toBeNull();
  const chooser = container!.querySelector('[role="dialog"]')!;
  const role = [...chooser.querySelectorAll<HTMLButtonElement>('.companions-start-chat-list button')].find(item => item.textContent?.includes('GPT'))!;
  await act(() => role.click()); expect(f.request).toHaveBeenCalledWith({ type: 'conversation.open', companionId: 'gpt' });
  expect(f.request.mock.calls.some(([input]) => input.type === 'companion.create')).toBe(false);
  await click('联系人'); await click('添加联系人'); expect(container!.querySelector('[role="dialog"][aria-label="添加联系人"]')).not.toBeNull();
});

it('fetches an older capability detail on demand instead of loading every historical task into the timeline', async () => {
  const action: CompanionAction = { id: 'old-action', conversationId: 'private-sister', companionId: 'deepseek-sister', sourceMessageId: 'message-1',
    title: '原来的文件处理', status: 'succeeded', createdAt: date, updatedAt: date, result: '原始能力结果已保留' };
  const f = fixture({}, [message(1, '旧任务正文', { segments: [{ text: '旧任务正文', actionIds: [action.id] }] })]);
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(input => input.type === 'action.get' ? Promise.resolve({ ok: true, action }) : original(input));
  await mount(f.api); expect(f.request.mock.calls.some(([input]) => input.type === 'action.get')).toBe(false);
  await click('查看这次能力调用'); expect(f.request).toHaveBeenCalledWith({ type: 'action.get', id: action.id });
  expect(container!.textContent).toContain('原来的文件处理'); expect(container!.textContent).toContain('原始能力结果已保留');
  await f.publish(); expect(container!.textContent).toContain('原来的文件处理');
});

it('opens the exact parallel capability from a lightweight message entry and keeps logs out of the bubble', async () => {
  const first: CompanionAction = { id: 'weather-task', conversationId: 'private-sister', companionId: 'deepseek-sister', sourceMessageId: 'message-1', title: '查询上海天气', status: 'running', createdAt: date, updatedAt: date };
  const second: CompanionAction = { ...first, id: 'clock-task', title: '读取系统时间', events: [{ sequence: 0, type: 'tool_start', summary: '开始读取时间', content: 'CLOCK TOOL STREAM', contentKind: 'output', receivedAt: date }] };
  const f = fixture({}, [message(1, '我看看。', { segments: [{ text: '我看看。', actionIds: [first.id, second.id] }] })]);
  await mount(f.api); await f.publishActions([first, second]);
  const bubble = container!.querySelector('.companions-message-bubble')!;
  expect(bubble.querySelectorAll('.companions-capability-link')).toHaveLength(2);
  expect(bubble.querySelector('.companions-action-card')).toBeNull();
  expect(bubble.querySelector('details')).toBeNull();
  expect(bubble.textContent).not.toContain('CLOCK TOOL STREAM');
  await click('查看任务进度 读取系统时间');
  const monitor = container!.querySelector('[role="dialog"][aria-label="伙伴实时任务"]')!;
  expect(monitor.querySelector('main')!.textContent).toContain('CLOCK TOOL STREAM');
  expect(monitor.querySelector('main')!.textContent).toContain('读取系统时间');
  await click('关闭任务监视'); expect(bubble.textContent).not.toContain('CLOCK TOOL STREAM');
});

it('keeps incoming messages unread while viewing history and clears them when returning to the latest page', async () => {
  const f = fixture({}, Array.from({ length: 80 }, (_, index) => message(index + 1))); await mount(f.api);
  await click('查看更早的消息'); f.request.mockClear();
  await f.publish({ conversations: [{ ...conversation('private-sister', 'private', ['deepseek-sister'], true), unread: 1 }, conversation('group-home', 'group', ['deepseek-sister', 'deepseek-flash'])] });
  expect(f.request.mock.calls.some(([input]) => input.type === 'conversation.read')).toBe(false);
  await click('回到最新消息'); expect(f.request).toHaveBeenCalledWith({ type: 'conversation.read', id: 'private-sister' });
});

it('shows offline avatar presence in the header and contact list and moves notices into the header status panel', async () => {
  const f = fixture({ configured: false }); const settings = await mount(f.api);
  expect(container!.querySelector('.companions-config-hint')).toBeNull();
  expect(container!.querySelector('.companions-history-banner')).toBeNull();
  expect(container!.querySelector('[data-presence-trigger] .companion-avatar-presence')!.getAttribute('data-status')).toBe('offline');
  expect(container!.querySelector('.companions-presence-label')!.textContent).toBe('离线');
  await click('查看伙伴状态'); expect(container!.querySelector('[role="dialog"][aria-label="伙伴状态"]')).not.toBeNull();
  await click('全局模型设置'); expect(settings).toHaveBeenCalledOnce();
  await click('联系人');
  expect(container!.querySelector('[data-companion-contact="gpt"] .companion-avatar-presence')!.getAttribute('data-status')).toBe('offline');
});

it('keeps each group member presence distinct and updates the open status panel with live work and queue counts', async () => {
  const f = fixture({ companions: sisters.map(role => role.id === 'deepseek-sister' ? { ...role, availability: 'working', activeCount: 2, queuedCount: 1 } : role.id === 'deepseek-flash' ? { ...role, availability: 'waiting', queuedCount: 3 } : role) });
  await mount(f.api);
  await act(() => container!.querySelector<HTMLButtonElement>('[data-companion-conversation="group-home"]')!.click());
  await click('查看伙伴状态');
  const panel = container!.querySelector('[aria-label="伙伴状态"]')!;
  expect(panel.querySelector('[data-presence-role="deepseek-sister"]')!.textContent).toContain('2 条回复正在进行 · 1 条等待中');
  expect(panel.querySelector('[data-presence-role="deepseek-flash"]')!.textContent).toContain('3 条消息等待空闲位置');
  await f.publish({ companions: sisters.map(role => role.id === 'deepseek-sister' ? { ...role, availability: 'offline', availabilityReason: '模型认证失败' } : { ...role, availability: 'ready' }) });
  expect(panel.querySelector('[data-presence-role="deepseek-sister"] .companion-avatar-presence')!.getAttribute('data-status')).toBe('offline');
  expect(panel.querySelector('[data-presence-role="deepseek-flash"] .companion-avatar-presence')!.getAttribute('data-status')).toBe('ready');
  expect(container!.querySelector('.companions-chat-header')!.textContent).toContain('1 位离线');
  await act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container!.querySelector('[aria-label="伙伴状态"]')).toBeNull();
});

it('finds an older message and explicitly returns to the latest history without mixing a gap into the timeline', async () => {
  const history = Array.from({ length: 65 }, (_, index) => message(index + 1, index === 2 ? '第一次一起去海边' : `日常 ${index + 1}`));
  const f = fixture({}, history); await mount(f.api); await click('搜索聊天记录');
  await fill('input[aria-label="搜索聊天内容"]', '海边'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
  await act(() => container!.querySelector<HTMLButtonElement>('.companions-history-hit')!.click());
  expect(f.request).toHaveBeenCalledWith({ type: 'messages', conversationId: 'private-sister', around: 'message-3', limit: 50 });
  expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('第一次一起去海边');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).not.toContain('日常 65');
  await f.publish({}, [...history, message(66, '最新的消息')]);
  expect(container!.querySelector('[data-companion-messages]')!.textContent).not.toContain('最新的消息');
  await click('回到最新消息'); expect(container!.querySelector('[data-companion-messages]')!.textContent).toContain('最新的消息');
  expect(container!.querySelector('[data-companion-messages]')!.textContent).not.toContain('第一次一起去海边');
});

it('adds a custom contact with the complete global connection inherited by default', async () => {
  const f = fixture(); await mount(f.api); await click('联系人'); await click('添加联系人'); await click('自定义角色');
  await fill('[role="dialog"] input', '阿蓝'); await fill('[role="dialog"] textarea', '喜欢海风，也会有自己的看法。');
  expect(container!.querySelector('[role="dialog"] input[aria-label="模型"]')).toBeNull();
  await submitDialog();
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.create', companion: { name: '阿蓝', description: '', persona: '喜欢海风，也会有自己的看法。', model: '', avatar: 'custom', proactive: false } });
  await click('联系人'); expect(container!.querySelector('[data-companion-contact="new-companion"]')).not.toBeNull();
});

it('shows a readable biography with the full editable role setting collapsed by default', async () => {
  const f = fixture(); await mount(f.api); await click('联系人');
  const introduction = container!.querySelector('.companions-introduction')!;
  expect(introduction.textContent).toContain('温柔沉稳'); expect(introduction.textContent).toContain('白米饭');
  expect(introduction.textContent).not.toContain('工具凭据');
  const details = container!.querySelector<HTMLDetailsElement>('.companions-persona-details')!;
  expect(details.open).toBe(false); expect(details.querySelector('summary')!.textContent).toBe('查看角色设定');
  await click('编辑资料'); expect(container!.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe(sisters[0]!.persona);
});

it('uses a custom contact description as its biography and keeps instructions inside a collapsed setting', async () => {
  const custom: Companion = { ...sisters[0]!, builtin: false, description: '一起把生活中的小事记下来', persona: '内部角色设定测试文本' };
  const f = fixture({ companions: [custom, sisters[1]!] }); await mount(f.api); await click('联系人');
  expect(container!.querySelector('.companions-introduction')!.textContent).toBe('一起把生活中的小事记下来');
  expect(container!.querySelector<HTMLDetailsElement>('.companions-persona-details')!.open).toBe(false);
});

it('selects a local image avatar, preserves it when contact settings change, and restores the name avatar', async () => {
  const f = fixture(); await mount(f.api); await click('联系人'); await click('添加联系人'); await click('自定义角色');
  await fill('[role="dialog"] input', '海盐'); await fill('[role="dialog"] textarea', '喜欢记录生活中的小事。');
  await click('选择本地头像');
  expect(container!.querySelector<HTMLElement>('.companions-avatar-editor .companion-avatar')!.style.backgroundImage).toContain('worldlinebox-companion://attachment/photo');
  await submitDialog();
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.create', companion: expect.objectContaining({ avatar: 'custom', avatarAttachmentId: 'photo' }) }));
  await click('联系人'); await act(() => container!.querySelector<HTMLButtonElement>('[data-companion-contact="new-companion"]')!.click());
  expect(container!.querySelector<HTMLElement>('.companions-profile-heading .companion-avatar')!.style.backgroundImage).toContain('worldlinebox-companion://attachment/photo');
  await act(() => container!.querySelector<HTMLInputElement>('.companions-contact-profile input[type="checkbox"]')!.click());
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.update').at(-1)![0]).toEqual(expect.objectContaining({ companion: expect.objectContaining({ proactive: true, avatarAttachmentId: 'photo' }) }));
  await click('编辑资料'); await click('恢复名字头像');
  const restored = container!.querySelector<HTMLElement>('.companions-avatar-editor .companion-avatar')!;
  expect(restored.style.backgroundImage).toBe(''); expect(restored.textContent).toBe('海');
  await submitDialog();
  expect(f.state().companions.find(item => item.id === 'new-companion')!.avatarAttachmentId).toBeUndefined();
});

it('rejects a non-image avatar without clearing the previously selected image', async () => {
  const custom: Companion = { ...sisters[0]!, builtin: false, avatar: 'custom', avatarAttachmentId: 'saved-avatar' };
  const f = fixture({ companions: [custom, sisters[1]!] }); const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(input => input.type === 'attachment.pick' ? Promise.resolve({ ok: true, attachments: [{ id: 'not-image', name: 'notes.txt', mime: 'text/plain', size: 120 }] }) : original(input));
  await mount(f.api); await click('联系人'); await click('编辑资料'); await click('选择本地头像');
  expect(container!.querySelector('[role="dialog"] [role="alert"]')!.textContent).toBe('请选择图片文件作为头像。');
  expect(container!.querySelector<HTMLElement>('.companions-avatar-editor .companion-avatar')!.style.backgroundImage).toContain('worldlinebox-companion://attachment/saved-avatar');
});

it('offers built-in and custom contacts and opens an existing built-in instead of duplicating it', async () => {
  const f = fixture(); await mount(f.api); await click('联系人'); await click('添加联系人');
  expect(container!.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('内置角色');
  const card = [...container!.querySelectorAll<HTMLElement>('.companions-builtin-card')].find(item => item.textContent?.includes('大肥鱼'))!;
  await click('已添加 · 打开', card);
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.open', companionId: 'deepseek-sister' });
  expect(f.request.mock.calls.some(([input]) => input.type === 'companion.add-builtin')).toBe(false);
});

it('configures an independent service without revealing a saved key and retains its connection when proactive is toggled', async () => {
  const independent = { ...sisters[0]!, llm: { apiFormat: 'anthropic' as const, baseUrl: 'https://example.test', model: 'test-model', hasKey: true } };
  const f = fixture({ configured: false, companions: [independent, sisters[1]!] }); await mount(f.api);
  expect(container!.querySelector('.companions-config-hint')).toBeNull();
  await click('联系人'); await click('编辑资料');
  const key = container!.querySelector<HTMLInputElement>('input[aria-label="API Key"]')!;
  expect(key.type).toBe('password'); expect(key.value).toBe(''); expect(key.placeholder).toBe('已保存，留空保留');
  await select('select[aria-label="连接方式"]', 'openai_responses');
  await fill('input[aria-label="模型"]', 'another-model'); await submitDialog();
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.update', companion: expect.objectContaining({ model: '', llm: { apiFormat: 'openai_responses', baseUrl: 'https://example.test', model: 'another-model' } }) }));
  const update = f.request.mock.calls.find(([input]) => input.type === 'companion.update')![0]; expect('apiKey' in update).toBe(false);
  const proactive = container!.querySelector<HTMLInputElement>('.companions-contact-profile input[type="checkbox"]')!;
  await act(() => proactive.click());
  expect(f.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'state' }));
  const updateCalls = f.request.mock.calls.filter(([input]) => input.type === 'companion.update');
  expect(updateCalls.at(-1)![0]).toEqual(expect.objectContaining({ companion: expect.objectContaining({ proactive: true, llm: { apiFormat: 'openai_responses', baseUrl: 'https://example.test', model: 'another-model' } }) }));
});

it('creates a group and manages its name and membership in the same conversation', async () => {
  const f = fixture(); await mount(f.api); await click('创建群聊');
  await fill('[role="dialog"] input:not([type="checkbox"])', '摸鱼小组');
  await act(() => container!.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')[0]!.click());
  await submitDialog();
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.create-group', title: '摸鱼小组', memberIds: ['deepseek-sister'] });
  await click('管理群聊'); await fill('[role="dialog"] input:not([type="checkbox"])', '一起看海'); await submitDialog();
  expect(f.request).toHaveBeenCalledWith({ type: 'conversation.update', id: 'new-group', title: '一起看海', memberIds: ['deepseek-sister'] });
  expect(container!.querySelector('.companions-chat-header h2')!.textContent).toContain('一起看海');
});

it('saves and corrects sourced memory without a second manual capability dispatch entry', async () => {
  const f = fixture(); await mount(f.api); await click('记住消息 1'); await fill('textarea[aria-label="共同记忆内容"]', '喜欢把照片按旅行地点整理'); await click('记住这件事');
  expect(f.request).toHaveBeenCalledWith({ type: 'memory.save', companionId: 'deepseek-sister', content: '喜欢把照片按旅行地点整理', sourceMessageId: 'message-1' });
  await click('编辑记忆 memory-a'); await fill('textarea[aria-label="共同记忆内容"]', '这次照片按地点整理'); await click('保存修正');
  expect(f.memories()[0]!.content).toBe('这次照片按地点整理');
  expect(container!.querySelector('[title="交给伙伴处理"]')).toBeNull();
  expect(f.request.mock.calls.some(([input]) => input.type === 'action.run')).toBe(false);
});

it('resolves a reference outside the loaded page and jumps to its original history', async () => {
  const history = Array.from({ length: 65 }, (_, index) => message(index + 1));
  const quote = message(66, '接着聊这件事。', { replyToId: 'message-1' }); const f = fixture({}, [...history, quote]);
  await mount(f.api); expect(button('查看引用消息 message-1').disabled).toBe(false);
  await click('查看引用消息 message-1');
  expect(f.request).toHaveBeenCalledWith({ type: 'message.get', id: 'message-1' });
  expect(f.request).toHaveBeenCalledWith({ type: 'messages', conversationId: 'private-sister', around: 'message-1', limit: 50 });
  expect(container!.querySelector('[data-companion-message="message-1"]')!.classList.contains('is-highlighted')).toBe(true);
  expect(container!.querySelector('.companions-history-chip')).not.toBeNull();
});

it('shows actual action steps and elapsed time, hides private thinking, and keeps completion wording tied to returned results', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(date).getTime() + 5000);
  const action: CompanionAction = { id: 'action-a', conversationId: 'private-sister', companionId: 'deepseek-sister', sourceMessageId: 'message-1', title: '整理照片', status: 'running', stage: '正在调用工具', createdAt: date, updatedAt: date, events: [
    { sequence: 1, type: 'tool_call', toolName: 'read_directory', summary: '读取照片清单', receivedAt: date },
    { sequence: 2, type: 'thinking', summary: '不应显示的私人原始推理', receivedAt: date },
    { sequence: 3, type: 'tool_result', toolName: 'read_directory', summary: '找到三张旅行照片', receivedAt: date },
  ] };
  const f = fixture({}, [message(1), message(2, '', { kind: 'action', actionId: action.id })], [action]); await mount(f.api);
  expect(container!.querySelector('[data-companion-action="action-a"]')).toBeNull();
  await click('查看任务进度 整理照片');
  const card = container!.querySelector('[data-companion-action="action-a"]')!;
  expect(card.textContent).toContain('正在调用工具'); expect(card.textContent).toContain('已用时 5 秒');
  expect(card.querySelector('.companions-action-latest-step')!.textContent).toContain('找到三张旅行照片');
  expect(card.textContent).not.toContain('私人原始推理'); expect(card.textContent).not.toContain('%');
  expect(card.querySelector('.companions-live-progress')).not.toBeNull();
  expect(card.querySelectorAll('.companions-live-output article')).toHaveLength(2);
  await click('停止处理 action-a'); expect(f.request).toHaveBeenCalledWith({ type: 'action.cancel', id: action.id });
  await f.publishActions([{ ...action, status: 'succeeded', stage: 'completed', updatedAt: '2026-10-13T08:00:09.000Z', result: '生成了整理清单。' }]);
  expect(card.textContent).toContain('已返回结果'); expect(card.textContent).toContain('已用时 9 秒');
  expect(card.querySelector('[aria-label="停止处理 action-a"]')).toBeNull();
});

it('tracks real reply elapsed time each second and resumes it accurately after the module is hidden', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T08:00:05.000Z'));
  const f = fixture({ activities: [{ companionId: 'deepseek-sister', conversationId: 'private-sister', status: 'thinking', startedAt: date }] });
  const settings = await mount(f.api); expect(container!.querySelector('.companions-typing-label')!.textContent).toContain('正在回复 · 5 秒');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container!.querySelector('.companions-typing-label')!.textContent).toContain('7 秒');
  await act(() => root!.render(<Companions api={f.api} isActive={false} onOpenSettings={settings} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container!.querySelector('.companions-typing-label')!.textContent).toContain('7 秒');
  await act(() => root!.render(<Companions api={f.api} isActive onOpenSettings={settings} />));
  expect(container!.querySelector('.companions-typing-label')!.textContent).toContain('12 秒');
  expect(f.request.mock.calls.some(([input]) => input.type === 'reply.cancel')).toBe(false);
});

it('uses the image-only picker and displays the pending upload name and size', async () => {
  const f = fixture(); await mount(f.api); await click('发送图片');
  expect(f.request).toHaveBeenCalledWith({ type: 'attachment.pick', kind: 'image' });
  expect(container!.querySelector('.companions-draft-attachments')!.textContent).toContain('旅行照片.jpg');
  expect(container!.querySelector('.companions-draft-attachments')!.textContent).toContain('2.0 KB');
});

it('offers global settings when unconfigured, labels a preset greeting, and cleans up its event subscription', async () => {
  const f = fixture({ configured: false }, [message(1, '你来啦。', { kind: 'notice', authorId: 'deepseek-sister' })]);
  const settings = await mount(f.api); expect(container!.textContent).toContain('内置欢迎'); await click('查看伙伴状态'); await click('全局模型设置'); expect(settings).toHaveBeenCalledOnce();
  await act(() => root!.unmount()); root = undefined; expect(f.unsubscribe).toHaveBeenCalledOnce();
});
