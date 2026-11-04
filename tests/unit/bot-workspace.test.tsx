// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotWorkspace } from '../../src/renderer/companion-bot/BotWorkspace';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { BotEvent, BotMessage, BotRequest, BotResponse, BotSnapshot, WorldlineBoxBotApi } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-11-02T10:00:00Z';
let root: Root | undefined, host: HTMLDivElement, listener: ((event: BotEvent) => void) | undefined;
let snapshots: Record<string, BotSnapshot>, requests: BotRequest[], override: ((request: BotRequest) => Promise<BotResponse> | undefined) | undefined;
const message = (id: string, conversationId: string, sequence: number, content: string, status: BotMessage['status'] = 'sent'): BotMessage => ({
  id, eventId: `event-${id}`, conversationId, sequence, content, status, senderId: 'alice', senderName: 'Alice', createdAt: at,
});
const snapshot = (messages: BotMessage[], hasMore = false): BotSnapshot => ({
  companions: [{ id: 'alice', name: 'Alice', persona: '温柔认真', createdAt: at }, { id: 'bob', name: 'Bob', persona: '直接简明', createdAt: at }],
  conversations: [{ id: 'a', title: '私聊甲', kind: 'direct', memberIds: ['user', 'alice'], createdAt: at }, { id: 'b', title: '私聊乙', kind: 'direct', memberIds: ['user', 'bob'], createdAt: at }],
  messages, tasks: [], hasMore, runtime: { engine: 'worldlinebox', memory: 'vcp-memory', embedding: 'bundled', activeLanes: 1, ready: true, dataRoot: 'test' },
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  snapshots = { a: snapshot([message('reply-a', 'a', 1, '甲的原文', 'running')]), b: snapshot([message('reply-b', 'b', 2, '乙的原文')]) };
  requests = []; override = undefined; listener = undefined;
});
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
async function mount() {
  const api: WorldlineBoxBotApi = {
    async request(request) {
      requests.push(request); const result = override?.(request); if (result) return result;
      if (request.type === 'state') return { ok: true, snapshot: snapshots[request.conversationId ?? 'a'] };
      if (request.type === 'conversation.open') return { ok: true, conversationId: request.companionId === 'alice' ? 'a' : 'b' };
      return { ok: true };
    },
    onEvent(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorkspace api={api} onOpenSettings={() => undefined} /></LocaleProvider>));
}
const composer = () => host.querySelector<HTMLTextAreaElement>('.bot-composer textarea')!;
const transcript = () => host.querySelector('.bot-transcript')!.textContent!;
async function input(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(() => { Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function select(title: string) {
  if (!host.querySelector('.bot-scroll button.bot-contact strong') || ![...host.querySelectorAll('.bot-scroll button.bot-contact strong')].some(item => item.textContent === title)) {
    await act(() => host.querySelectorAll<HTMLButtonElement>('.bot-sidebar-tabs button')[1]!.click());
  }
  const target = [...host.querySelectorAll<HTMLButtonElement>('.bot-scroll button.bot-contact')].find(button => button.querySelector('strong')?.textContent === title)!;
  await act(() => target.click());
}
async function click(label: string) {
  const target = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!;
  expect(target, `button ${label}`).toBeDefined(); await act(() => target.click());
}
async function emit(event: BotEvent) { await act(() => { listener!(event); }); }
async function changed(conversationId = 'a') { await emit({ type: 'changed', conversationId }); await act(() => vi.advanceTimersByTime(110)); }
const sends = () => requests.filter((request): request is Extract<BotRequest, { type: 'message.send' }> => request.type === 'message.send');
const rows = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => {
  const number = first + index;
  // Other conversations also use the global sequence; one conversation is not numerically contiguous.
  return message(`m${number}`, 'a', number * 7, `消息 ${number}`);
});
const visibleIds = () => [...host.querySelectorAll<HTMLElement>('[data-bot-message]')].map(element => element.dataset.botMessage);

it('keeps transport receipts compact and opens the task workspace without adding a composer banner', async () => {
  snapshots.a = snapshot([{ ...message('notice', 'a', 1, 'TASK RAW EXECUTOR OUTPUT '.repeat(100)), senderId: 'task-service', senderName: '任务回执', taskNotice: { taskId: 'task-current', kind: 'task_done' } }, message('character-result', 'a', 2, '我已经把结果整理好了。')]);
  snapshots.a.tasks = [{ id: 'task-current', conversationId: 'a', companionId: 'alice', title: '整理目录', goal: 'Long goal', status: 'running', progress: { phase: 'using-tool', toolName: 'shell' } }];
  override = request => request.type === 'task.list' ? Promise.resolve({ ok: true, taskPage: { items: snapshots.a!.tasks, total: 1, page: 0, limit: 6, activeCount: 1, queuedCount: 0 } })
    : request.type === 'task.get' ? Promise.resolve({ ok: true, task: snapshots.a!.tasks[0] }) : undefined;
  await mount();
  expect(host.querySelector('.bot-chat-tasks')?.textContent).toContain('任务1');
  expect(host.querySelector('.bot-active-tasks')).toBeNull();
  expect(transcript()).not.toContain('TASK RAW EXECUTOR OUTPUT'); expect(transcript()).toContain('我已经把结果整理好了。');
  expect(host.querySelector('[data-bot-message="notice"] .bot-avatar')).not.toBeNull();
  expect(host.querySelector('[data-bot-message="notice"] .bot-task-notice-meta strong')?.textContent).toBe('Alice');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-task-notice button')!.click());
  expect(host.querySelector('[role="dialog"][aria-label="任务工作台"]')).not.toBeNull();
  expect(host.querySelector('.bot-task-heading h4')?.textContent).toBe('整理目录');
});

it('shows partner-initiated groups in the shared chat list and retains participant input', async () => {
  const peer = { id: 'peer', title: 'Alice 和 Bob', kind: 'group' as const, memberIds: ['user', 'bob', 'alice'], createdAt: at, peerConversation: true };
  snapshots.peer = snapshot([{ ...message('alice-peer', 'peer', 1, '一起核对这份清单吧。'), senderId: 'alice', senderName: 'Alice' }, { ...message('bob-peer', 'peer', 2, '好，我来检查遗漏。'), senderId: 'bob', senderName: 'Bob' }]);
  for (const state of Object.values(snapshots)) state.conversations.push(peer);
  await mount();
  expect(host.querySelector('.bot-scroll')?.textContent).toContain(peer.title);
  expect([...host.querySelectorAll('[role="tab"]')].some(button => button.textContent === '伙伴交流')).toBe(false);
  expect(host.querySelector('.bot-peer-avatar')?.children).toHaveLength(2);
  expect([...host.querySelectorAll<HTMLElement>('.bot-scroll .bot-group-portrait')].map(tile => tile.dataset.companionId)).toEqual(['bob', 'alice']);
  await select(peer.title);
  expect(transcript()).toContain('一起核对这份清单吧。'); expect(transcript()).toContain('好，我来检查遗漏。'); expect(transcript()).not.toContain('甲的原文');
  expect(host.querySelector<HTMLTextAreaElement>('.bot-composer textarea')?.disabled).toBe(false);
  expect(host.querySelector('.bot-group-policy')).not.toBeNull();
  expect(host.querySelector('.bot-chat-tasks')?.textContent).toBe('群任务');
  expect(host.querySelector('.bot-chat-identity .bot-peer-avatar')?.children).toHaveLength(2);
  expect([...host.querySelectorAll<HTMLElement>('.bot-chat-identity .bot-group-portrait')].map(tile => tile.dataset.companionId)).toEqual(['bob', 'alice']);
  expect(host.querySelector('.bot-group-members-trigger')?.textContent).toContain('3 位成员');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-group-avatar-trigger')!.click());
  expect(document.querySelector('[role="dialog"] .bot-group-members-header h2')?.textContent).toBe('群聊成员');
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭成员管理"]')!.click());
  expect(document.querySelector('.bot-group-members-backdrop')).toBeNull();
});

it('keeps group admin errors local and refreshes the chat list without rereading a dissolved room', async () => {
  const group = { id: 'group', title: '周末计划', kind: 'group' as const, ownerId: 'user' as const, memberIds: ['user', 'alice', 'bob'], createdAt: at };
  snapshots.group = snapshot([message('group-reply', 'group', 1, '周末见。')]);
  for (const state of Object.values(snapshots)) state.conversations.push(group);
  await mount(); await select(group.title);
  await act(() => host.querySelector<HTMLButtonElement>('.bot-group-members-trigger')!.click());
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="移除 Bob"]')!.click());
  override = request => request.type === 'conversation.members' ? Promise.resolve({ ok: false, error: '成员保存失败' }) : undefined;
  const dialogButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.bot-group-members button')].find(button => button.textContent === text)!;
  await act(() => dialogButton('保存成员').click());
  expect(document.querySelector('.bot-group-members [role="alert"]')?.textContent).toContain('成员保存失败');
  expect(host.querySelector('.bot-error')).toBeNull();
  override = request => {
    if (request.type !== 'conversation.dissolve') return;
    for (const state of Object.values(snapshots)) state.conversations = state.conversations.filter(item => item.id !== group.id);
    return Promise.resolve({ ok: true });
  };
  await act(() => dialogButton('解散群聊').click());
  const priorRequests = requests.length;
  await act(() => document.querySelector<HTMLButtonElement>('.bot-group-dissolve-confirm .is-danger-solid')!.click());
  expect(requests.slice(priorRequests).some(request => request.type === 'conversation.dissolve' && request.conversationId === group.id)).toBe(true);
  expect(requests.slice(priorRequests).some(request => request.type === 'state' && request.conversationId === group.id)).toBe(false);
  expect(host.querySelector('.bot-scroll')?.textContent).not.toContain(group.title);
  expect(document.querySelector('.bot-group-members-backdrop')).toBeNull();
  expect(host.querySelector('.bot-chat-title h2')?.textContent).toBe('私聊甲');
});

it('bounds the chat list to forty rows and searches every conversation beyond the current page', async () => {
  snapshots.a!.conversations.push(...Array.from({ length: 85 }, (_, index) => ({ id: `old-${index}`, title: `历史群聊${index}`, kind: 'group' as const, memberIds: ['user', 'alice'], createdAt: at })));
  await mount();
  expect(host.querySelector('.bot-sidebar .bot-settings')).toBeNull();
  expect(host.querySelectorAll('.bot-conversation')).toHaveLength(40);
  expect(host.querySelector('.bot-sidebar-pagination')?.textContent).toContain('1 / 3');
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="下一页聊天"]')!.click());
  expect(host.querySelectorAll('.bot-conversation')).toHaveLength(40);
  expect(host.querySelector('.bot-sidebar-pagination')?.textContent).toContain('2 / 3');
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="下一页聊天"]')!.click());
  expect(host.querySelectorAll('.bot-conversation')).toHaveLength(7);
  await input(host.querySelector<HTMLInputElement>('.bot-contact-search input')!, '历史群聊84');
  expect(host.querySelectorAll('.bot-conversation')).toHaveLength(1);
  expect(host.querySelector('.bot-scroll')?.textContent).toContain('历史群聊84');
  expect(host.querySelector('.bot-sidebar-pagination')).toBeNull();
  await input(host.querySelector<HTMLInputElement>('.bot-contact-search input')!, '');
  expect(host.querySelectorAll('.bot-conversation')).toHaveLength(7);
});

it('shows only real current-room task summaries in the collapsible companion context', async () => {
  snapshots.a!.tasks = [
    { id: 'current-task', conversationId: 'a', companionId: 'alice', title: '整理资料', goal: 'DO NOT SHOW THE LONG EXECUTOR PROMPT', status: 'running', progress: { phase: 'using-tool', toolName: 'shell' } },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `more-task-${index}`, conversationId: 'a', companionId: 'alice', title: `后续任务${index}`, goal: 'long hidden prompt', status: 'queued' })),
    { id: 'private-task', conversationId: 'b', companionId: 'bob', title: '其他私聊任务', goal: 'PRIVATE', status: 'running' },
  ];
  await mount();
  const details = () => host.querySelector('.bot-chat-context');
  expect(details()?.textContent).toContain('整理资料'); expect(details()?.textContent).not.toContain('其他私聊任务');
  expect(details()?.querySelectorAll('.bot-context-task')).toHaveLength(5);
  expect(details()?.textContent).toContain('还有 1 项');
  expect(details()?.textContent).not.toContain('DO NOT SHOW'); expect(details()?.textContent).not.toMatch(/\d+%|预计.*分钟/);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起聊天信息"]')!.click());
  expect(details()).toBeNull();
  expect(host.querySelector('.bot-workspace')?.classList.contains('context-collapsed')).toBe(true);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开聊天信息"]')!.click());
  expect(details()).not.toBeNull();
});

it('keeps concurrent conversation streams in their own transcript and retires completed overlays', async () => {
  await mount();
  await emit({ type: 'text', conversationId: 'b', messageId: 'reply-a', text: '另一会话不能覆盖' });
  expect(transcript()).toContain('甲的原文'); expect(transcript()).not.toContain('不能覆盖');
  await emit({ type: 'text', conversationId: 'a', messageId: 'reply-a', text: '当前真实流' }); expect(transcript()).toContain('当前真实流');
  await select('私聊乙'); expect(transcript()).toContain('乙的原文'); expect(transcript()).not.toContain('当前真实流');
  await select('私聊甲'); snapshots.a = snapshot([message('reply-a', 'a', 1, '正式最终正文')]); await changed();
  await emit({ type: 'text', conversationId: 'a', messageId: 'reply-a', text: '迟到流帧' });
  expect(transcript()).toContain('正式最终正文'); expect(transcript()).not.toContain('迟到');
  snapshots.a = snapshot([message('reply-a', 'a', 1, '', 'queued')]); await changed();
  expect(transcript()).toContain('等待处理'); expect(transcript()).not.toContain('当前真实流');
});
it('uses the complete active task count instead of the bounded snapshot rows in the chat header', async () => {
  snapshots.a!.taskSummary = { activeCount: 500, queuedCount: 490, items: [] };
  await mount(); expect(host.querySelector('.bot-chat-tasks')?.textContent).toBe('任务500');
  await select('私聊乙'); expect(host.querySelector('.bot-chat-tasks')?.textContent).toBe('任务');
});
it('aggregates task updates at the header and reads only the room opened through the composer', async () => {
  const presence: NonNullable<BotSnapshot['presence']> = { alice: { status: 'idle', updatedAt: at,
    counts: { activeTasks: 0, queued: 0, running: 0, waiting: 0, stopping: 0, blocked: 0, replying: 0, pendingMessages: 0 }, events: [] } };
  for (const state of Object.values(snapshots)) state.presence = presence;
  snapshots.a!.taskSummary = { activeCount: 500, queuedCount: 490, items: [] };
  await mount(); expect(host.querySelector('.bot-task-updates')).toBeNull();
  const events = ['a', 'a', 'b'].map((conversationId, index) => ({ id: `update-${index}`, sequence: index + 1, kind: 'task-completed' as const,
    taskId: `task-${index}`, title: '已完成的任务', conversationId, status: 'succeeded', occurredAt: at }));
  for (const state of Object.values(snapshots)) state.presence = { alice: { ...presence.alice!, events } };
  await changed();
  expect(host.querySelectorAll('.bot-task-updates')).toHaveLength(1);
  expect(host.querySelector('.bot-task-updates')?.getAttribute('data-count')).toBe('2');
  expect(host.querySelector('.bot-chat-tasks')?.textContent).toContain('任务500');
  expect(host.querySelector('.bot-presence-feedback')).toBeNull();
  expect(host.querySelector('[role="dialog"][aria-label="任务工作台"]')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('.bot-composer [aria-label="任务"]')!.click());
  expect(host.querySelector('[role="dialog"][aria-label="任务工作台"]')).not.toBeNull();
  expect(host.querySelector('.bot-task-updates')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭任务"]')!.click());
  await changed(); expect(host.querySelector('.bot-task-updates')).toBeNull();
  await select('私聊乙'); expect(host.querySelector('.bot-task-updates')?.getAttribute('data-count')).toBe('1');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-chat-tasks')!.click());
  expect(host.querySelector('.bot-task-updates')).toBeNull();
});
it('ignores an old snapshot that resolves after the user has switched conversations', async () => {
  await mount(); const old = deferred<BotResponse>();
  override = request => request.type === 'state' && request.conversationId === 'a' ? old.promise : undefined;
  await changed(); await select('私聊乙'); expect(transcript()).toContain('乙的原文');
  await act(() => old.resolve({ ok: true, snapshot: snapshot([message('old', 'a', 1, '迟到甲快照')]) }));
  expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe('私聊乙'); expect(transcript()).toContain('乙的原文'); expect(transcript()).not.toContain('迟到甲');
});
it('keeps the host-reported reply stage visible alongside streamed text and renders measured terminal timing', async () => {
  snapshots.a = snapshot([{ ...message('phase-a', 'a', 1, '', 'running'), progress: { phase: 'preparing-context', detail: '正在准备这段聊天的上下文' } }]);
  await mount(); expect(transcript()).toContain('准备上下文');
  snapshots.a = snapshot([{ ...message('phase-a', 'a', 1, '', 'running'), progress: { phase: 'waiting-model' } }]); await changed();
  expect(transcript()).toContain('等待模型'); expect(transcript()).not.toContain('准备上下文');
  await emit({ type: 'text', conversationId: 'a', messageId: 'phase-a', text: '真实生成中的正文' });
  expect(transcript()).toContain('真实生成中的正文'); expect(host.querySelector('.bot-reply-progress')?.textContent).toContain('等待模型响应');
  snapshots.a = snapshot([{ ...message('phase-a', 'a', 1, '真实生成中的正文', 'running'), progress: { phase: 'using-tool', toolName: 'memory_history', detail: 'DO NOT DISPLAY {keyword: private}' } }]); await changed();
  expect(host.querySelector('.bot-message-text')?.textContent).toContain('真实生成中的正文');
  expect(host.querySelector('.bot-reply-progress')?.textContent).toContain('查找聊天记录');
  expect(transcript()).not.toContain('DO NOT DISPLAY');
  snapshots.a = snapshot([{ ...message('phase-a', 'a', 1, '真实生成中的正文', 'running'), progress: { phase: 'generating' } }]); await changed();
  expect(host.querySelector('.bot-reply-progress')?.textContent).toContain('正在生成回复');
  snapshots.a = snapshot([{ ...message('phase-a', 'a', 1, '真实最终正文'), timing: { elapsedMs: 4300, prepareMs: 200 } }]); await changed();
  expect(host.querySelector('.bot-message-duration')?.textContent).toContain('用时 4.3 秒');
  expect(transcript()).toContain('真实最终正文'); expect(transcript()).not.toContain('真实生成中的正文');
  expect(host.querySelector('.bot-reply-progress')).toBeNull();
});

it('ticks only the active reply clock without rendering the 400-message transcript and stops after cancellation', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at) + 2000);
  snapshots.a = snapshot([...rows(1, 399), { ...message('active-last', 'a', 4000, '已收到的部分回复', 'running'), progress: { phase: 'compacting-context' } }]);
  await mount();
  const dates = vi.spyOn(Date.prototype, 'toLocaleTimeString');
  try {
    expect(host.querySelector('.bot-reply-progress')?.textContent).toContain('已用 2 秒');
    now.mockReturnValue(Date.parse(at) + 5000); await act(() => vi.advanceTimersByTime(3000));
    expect(host.querySelector('.bot-reply-progress')?.textContent).toContain('已用 5 秒');
    expect(dates.mock.calls.length).toBe(0); expect(visibleIds()).toHaveLength(400);
    expect(host.querySelector('[data-bot-message="active-last"] .bot-message-text')?.textContent).toContain('已收到的部分回复');
    snapshots.a = snapshot([{ ...message('active-last', 'a', 4000, '已收到的部分回复', 'cancelled') }]);
    await click('停止'); expect(requests).toContainEqual({ type: 'reply.cancel', messageId: 'active-last' });
    expect(host.querySelector('.bot-reply-progress')).toBeNull();
    dates.mockClear(); await act(() => vi.advanceTimersByTime(3000)); expect(dates.mock.calls.length).toBe(0);
  } finally { dates.mockRestore(); now.mockRestore(); }
});
it('does not let a slow contact-open request undo the later contact selection', async () => {
  await mount(); const old = deferred<BotResponse>();
  override = request => request.type === 'conversation.open' && request.companionId === 'alice' ? old.promise : undefined;
  await select('Alice'); await select('Bob');
  await act(() => old.resolve({ ok: true, conversationId: 'a' }));
  expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe('私聊乙'); expect(transcript()).toContain('乙的原文');
});
it('retains failed drafts and reuses the ingress ID when retrying an uncertain send', async () => {
  await mount(); let attempts = 0;
  override = request => request.type === 'message.send' ? Promise.resolve(++attempts === 1 ? { ok: false, error: '连接中断' } : { ok: true }) : undefined;
  await input(composer(), '需要可靠投递'); await click('发送 ↑');
  expect(composer().value).toBe('需要可靠投递'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('连接中断');
  await click('发送 ↑'); expect(composer().value).toBe(''); expect(sends()[0]?.requestId).toBe(sends()[1]?.requestId);
  await input(composer(), '需要可靠投递'); await click('发送 ↑'); expect(sends()[2]?.requestId).not.toBe(sends()[1]?.requestId);
});
it('preserves newer drafts in both conversations when an earlier send completes', async () => {
  await mount(); const sent = deferred<BotResponse>();
  override = request => request.type === 'message.send' ? sent.promise : undefined;
  await input(composer(), '已发送甲'); await click('发送 ↑');
  await input(composer(), '甲的新草稿'); await select('私聊乙'); await input(composer(), '乙的草稿');
  await act(() => sent.resolve({ ok: true }));
  expect(composer().value).toBe('乙的草稿'); expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe('私聊乙');
  await select('私聊甲'); expect(composer().value).toBe('甲的新草稿');
});
it('does not send Enter during IME composition or Shift Enter but sends a normal Enter', async () => {
  await mount(); await input(composer(), '中文输入');
  await act(() => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })); });
  await act(() => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })); });
  await act(() => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
  expect(sends()).toHaveLength(0);
  await act(() => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(sends()).toHaveLength(1); expect(sends()[0]?.conversationId).toBe('a');
});
it('stops exactly the selected reply and shows the durable cancelled outcome', async () => {
  await mount();
  override = request => {
    if (request.type !== 'reply.cancel') return;
    snapshots.a = snapshot([message('reply-a', 'a', 1, '', 'cancelled')]); return Promise.resolve({ ok: true });
  };
  await click('停止'); expect(requests.find(request => request.type === 'reply.cancel')).toEqual({ type: 'reply.cancel', messageId: 'reply-a' });
  expect(transcript()).toContain('已停止'); expect(host.querySelector('.bot-stop')).toBeNull();
});
it('keeps loaded earlier pages through refreshes and deduplicates overlap without replacing newer messages', async () => {
  snapshots.a = snapshot([message('m3', 'a', 3, '第三条'), message('m4', 'a', 4, '第四条')], true);
  await mount();
  override = request => request.type === 'state' && request.before ? Promise.resolve({ ok: true, snapshot: snapshot([
    message('m1', 'a', 1, '第一条'), message('m2', 'a', 2, '第二条'), message('m3', 'a', 3, '过期第三条'),
  ], false) }) : undefined;
  await click('查看更早消息');
  expect(host.querySelectorAll('.bot-message')).toHaveLength(4); expect(transcript()).not.toContain('过期');
  expect(requests.find(request => request.type === 'state' && request.before)).toEqual({ type: 'state', conversationId: 'a', before: 3 });
  snapshots.a = snapshot([message('m3', 'a', 3, '第三条'), message('m4', 'a', 4, '最新第四条')], true); await changed();
  expect(host.querySelectorAll('.bot-message')).toHaveLength(4); expect(transcript()).toContain('第一条'); expect(transcript()).toContain('最新第四条');
  expect(host.querySelector('.bot-earlier')).toBeNull();
});
it('bounds a long live conversation while preserving access to evicted messages and the latest reply', async () => {
  snapshots.a = snapshot(rows(1, 80)); await mount();
  for (const end of [128, 192, 256, 320, 384, 448, 512, 560]) {
    const page = rows(end - 79, end); page.at(-1)!.status = 'running'; snapshots.a = snapshot(page, true);
    await changed(); await emit({ type: 'text', conversationId: 'a', messageId: `m${end}`, text: `实时回复 ${end}` });
    expect(visibleIds().length).toBeLessThanOrEqual(400); expect(transcript()).toContain(`实时回复 ${end}`);
  }
  expect(visibleIds()).toHaveLength(400); expect(visibleIds()[0]).toBe('m161'); expect(visibleIds().at(-1)).toBe('m560');
  snapshots.a = snapshot(rows(481, 560), true); await changed(); expect(transcript()).not.toContain('实时回复');
  override = request => request.type === 'state' && request.before
    ? Promise.resolve({ ok: true, snapshot: snapshot(rows(81, 160), true) }) : undefined;
  await click('查看更早消息');
  expect(requests.filter(request => request.type === 'state' && request.before).at(-1)).toEqual({ type: 'state', conversationId: 'a', before: 161 * 7 });
  expect(visibleIds()).toHaveLength(400); expect(visibleIds()[0]).toBe('m81'); expect(visibleIds().at(-1)).toBe('m480');
  await changed(); expect(visibleIds().at(-1)).toBe('m480');
  await click('回到最新'); expect(visibleIds()).toHaveLength(80); expect(visibleIds()[0]).toBe('m481'); expect(visibleIds().at(-1)).toBe('m560');
});
it('resets to the incoming page after an inactive gap instead of joining disconnected history', async () => {
  snapshots.a = snapshot(rows(1, 80)); await mount();
  snapshots.a = snapshot(rows(801, 880), true); await changed();
  expect(visibleIds()).toHaveLength(80); expect(visibleIds()[0]).toBe('m801'); expect(visibleIds()).not.toContain('m80');
  override = request => request.type === 'state' && request.before ? Promise.resolve({ ok: true, snapshot: snapshot(rows(721, 800), true) }) : undefined;
  await click('查看更早消息'); expect(visibleIds()).toHaveLength(160); expect(visibleIds()[0]).toBe('m721'); expect(visibleIds().at(-1)).toBe('m880');
  expect(requests.filter(request => request.type === 'state' && request.before).at(-1)).toMatchObject({ before: 801 * 7 });
});
it('updates loaded history without appending a newer page or moving the reader, then jumps to the actual latest page', async () => {
  snapshots.a = snapshot(rows(81, 160), true); await mount();
  override = request => request.type === 'state' && request.before ? Promise.resolve({ ok: true, snapshot: snapshot(rows(1, 80), false) }) : undefined;
  await click('查看更早消息');
  const log = host.querySelector<HTMLElement>('.bot-transcript')!; log.scrollTop = 123;
  const latest = rows(141, 220); latest.find(item => item.id === 'm150')!.content = '已有消息的最终更正'; snapshots.a = snapshot(latest, true);
  await emit({ type: 'text', conversationId: 'a', messageId: 'm220', text: '历史窗口外的流式消息' }); await changed();
  expect(visibleIds()).toHaveLength(160); expect(visibleIds()).not.toContain('m161'); expect(transcript()).toContain('已有消息的最终更正');
  expect(transcript()).not.toContain('历史窗口外的流式消息'); expect(transcript()).toContain('有新消息'); expect(log.scrollTop).toBe(123);
  expect(host.querySelector('.bot-earlier')).toBeNull();
  await click('回到最新'); expect(visibleIds()).toHaveLength(80); expect(visibleIds()[0]).toBe('m141'); expect(visibleIds().at(-1)).toBe('m220');
  expect(transcript()).not.toContain('有新消息'); expect(host.querySelector('.bot-earlier')).not.toBeNull();
});
it('rejects a late earlier-page response after jumping to latest and a late jump after switching conversations', async () => {
  snapshots.a = snapshot(rows(101, 180), true); await mount();
  const oldPage = deferred<BotResponse>();
  override = request => request.type === 'state' && request.before ? oldPage.promise : undefined;
  await click('查看更早消息'); snapshots.a = snapshot(rows(501, 580), true); await click('回到最新');
  await act(() => oldPage.resolve({ ok: true, snapshot: snapshot(rows(21, 100), true) }));
  expect(visibleIds()).toHaveLength(80); expect(visibleIds()[0]).toBe('m501');
  override = request => request.type === 'state' && request.before ? Promise.resolve({ ok: true, snapshot: snapshot(rows(421, 500), true) }) : undefined;
  await click('查看更早消息'); const lateJump = deferred<BotResponse>();
  override = request => request.type === 'state' && request.conversationId === 'a' && !request.before ? lateJump.promise : undefined;
  await click('回到最新'); await select('私聊乙');
  await act(() => lateJump.resolve({ ok: true, snapshot: snapshot(rows(901, 980), true) }));
  expect(visibleIds()).toEqual(['reply-b']); expect(transcript()).toContain('乙的原文'); expect(transcript()).not.toContain('正在读取最新');
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '回到最新')).toBe(false);
});
it('preserves the same visible message when prepending a page drops the old tail at the window limit', async () => {
  snapshots.a = snapshot(rows(721, 800), true); await mount();
  override = request => {
    if (request.type !== 'state' || !request.before) return;
    const last = request.before / 7 - 1; return Promise.resolve({ ok: true, snapshot: snapshot(rows(last - 79, last), true) });
  };
  for (let page = 0; page < 4; page++) await click('查看更早消息');
  expect(visibleIds()).toHaveLength(400); expect(visibleIds()[0]).toBe('m401');
  const log = host.querySelector<HTMLElement>('.bot-transcript')!; log.scrollTop = 40;
  const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 300, x: 0, y: top, width: 300, height, toJSON: () => ({}) });
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === log) return rect(0, 100);
    if (this.dataset.botMessage) return rect(visibleIds().indexOf(this.dataset.botMessage) * 20 - log.scrollTop, 20);
    return rect(0, 0);
  });
  try {
    expect(host.querySelector<HTMLElement>('[data-bot-message="m403"]')!.getBoundingClientRect().top).toBe(0);
    await click('查看更早消息');
    expect(visibleIds()).toHaveLength(400); expect(visibleIds()[0]).toBe('m321'); expect(visibleIds().at(-1)).toBe('m720');
    expect(log.scrollTop).toBe(1640); expect(host.querySelector<HTMLElement>('[data-bot-message="m403"]')!.getBoundingClientRect().top).toBe(0);
  } finally { bounds.mockRestore(); }
});
it('jumps out of history after a successful send in the same conversation but preserves a later selection', async () => {
  snapshots.a = snapshot(rows(81, 160), true); await mount();
  override = request => request.type === 'state' && request.before ? Promise.resolve({ ok: true, snapshot: snapshot(rows(1, 80)) }) : undefined;
  await click('查看更早消息'); await input(composer(), '自己的新消息');
  snapshots.a = snapshot([...rows(82, 160), { ...message('new-user', 'a', 1127, '自己的新消息'), senderId: 'user' }], true);
  await click('发送 ↑'); expect(composer().value).toBe(''); expect(visibleIds()).toHaveLength(80); expect(visibleIds().at(-1)).toBe('new-user');
  await click('查看更早消息'); const sent = deferred<BotResponse>();
  override = request => request.type === 'message.send' ? sent.promise : undefined;
  await input(composer(), '发送中'); await click('发送 ↑'); await select('私聊乙');
  await act(() => sent.resolve({ ok: true }));
  expect(visibleIds()).toEqual(['reply-b']); expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe('私聊乙');
});
it('does not lose a successful send or refresh notification that arrives while a latest-page request is in flight', async () => {
  snapshots.a = snapshot(rows(81, 160), true); await mount();
  override = request => request.type === 'state' && request.before ? Promise.resolve({ ok: true, snapshot: snapshot(rows(1, 80)) }) : undefined;
  await click('查看更早消息');
  const jump = deferred<BotResponse>(), olderLatest = snapshot(rows(141, 220), true); let firstLatest = true;
  override = request => {
    if (request.type === 'state' && request.conversationId === 'a' && !request.before && firstLatest) { firstLatest = false; return jump.promise; }
    if (request.type === 'message.send') {
      snapshots.a = snapshot([...rows(142, 220), { ...message('own-latest', 'a', 221 * 7, request.content), senderId: 'user' }], true);
      return Promise.resolve({ ok: true });
    }
  };
  await click('回到最新'); await input(composer(), '跳转期间发送'); await click('发送 ↑'); await changed();
  await act(() => jump.resolve({ ok: true, snapshot: olderLatest }));
  expect(composer().value).toBe(''); expect(visibleIds().at(-1)).toBe('own-latest'); expect(transcript()).toContain('跳转期间发送');
  expect(visibleIds().length).toBeLessThanOrEqual(400); expect(transcript()).not.toContain('正在读取最新消息');
});
it('identifies the app brain separately from the DSH task executor in runtime details', async () => {
  await mount(); await click('任务'); await click('运行信息');
  const runtime = host.querySelector<HTMLElement>('.bot-runtime')!;
  expect(runtime).not.toBeNull();
  expect(runtime.textContent).toContain('WorldlineBox 主脑 · DSH 任务执行器');
  expect(runtime.textContent).toContain('VCP Memory 记忆');
  expect(runtime.textContent).not.toContain('dsh · vcp-memory');
  expect(runtime.querySelector('.bot-model-context')).toBeNull();
});
it('shows the actual metadata window and labels the byte estimate as a capacity check', async () => {
  snapshots.a!.runtime.modelContext = { window: 1048576, source: 'metadata', estimate: 'utf8-byte-upper-bound' };
  await mount(); await click('任务'); await click('运行信息');
  const capacity = host.querySelector('.bot-model-context')!;
  expect(capacity.textContent).toContain('模型上下文窗口：1,048,576 tokens');
  expect(capacity.textContent).toContain('规格来源：模型元数据');
  expect(capacity.textContent).toContain('容量检查使用 UTF-8 字节上界估算。');
  expect(capacity.textContent).not.toContain('保守估计');
});
it('marks an unknown window as conservative and refreshes the source when verified specifications arrive', async () => {
  snapshots.a!.runtime.modelContext = { window: 32768, source: 'unknown', estimate: 'utf8-byte-upper-bound' };
  await mount(); await click('任务'); await click('运行信息');
  expect(host.querySelector('.bot-model-context')?.textContent).toContain('模型窗口（保守估计）：32,768 tokens');
  expect(host.querySelector('.bot-model-context')?.textContent).toContain('未发现模型元数据');
  snapshots.a!.runtime.modelContext = { window: 1048576, source: 'official-default', estimate: 'utf8-byte-upper-bound' };
  await changed();
  const capacity = host.querySelector('.bot-model-context')!;
  expect(capacity.textContent).toContain('模型上下文窗口：1,048,576 tokens'); expect(capacity.textContent).toContain('规格来源：官方默认规格');
  expect(capacity.textContent).not.toContain('保守估计'); expect(capacity.textContent).not.toContain('未发现模型元数据');
});
it('opens the standalone memory workspace and closes it before changing audience', async () => {
  await mount();
  override = request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: [], tags: [], total: 0 } }) : undefined;
  await click('记忆');
  expect(host.querySelector('.bot-memory-workspace[role="dialog"]')).not.toBeNull();
  expect(host.querySelector('.bot-detail')).toBeNull();
  expect(requests.find(request => request.type === 'memory.catalog')).toMatchObject({ conversationId: 'a', companionId: 'alice', limit: 24 });
  await select('私聊乙'); expect(host.querySelector('.bot-memory-workspace')).toBeNull();
});

it('creates groups with the explicitly selected participation policy', async () => {
  await mount(); await click('新群聊');
  const form = host.querySelector<HTMLFormElement>('.bot-modal')!;
  const title = form.querySelector<HTMLInputElement>('input:not([type=checkbox])')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '讨论组'); title.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => form.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  const policy = form.querySelector<HTMLSelectElement>('select')!;
  expect(policy.value).toBe('automatic');
  await act(() => { policy.value = 'mentions'; policy.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('创建');
  expect(requests.find(request => request.type === 'conversation.create')).toEqual({ type: 'conversation.create', title: '讨论组', kind: 'group', memberIds: ['alice'], participationMode: 'mentions' });
});

it('keeps long persona edits local instead of rendering the 400-message transcript on each keystroke', async () => {
  snapshots.a = snapshot(rows(1, 400)); await mount(); await click('编辑伙伴');
  const field = host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!;
  const dates = vi.spyOn(Date.prototype, 'toLocaleTimeString');
  try {
    const longPersona = '认真表达，保留自己的边界与真实经历。\n'.repeat(1000);
    await input(field, longPersona);
    await input(field, longPersona + '新的约定😀');
    expect(dates.mock.calls.length).toBe(0);
    await click('保存');
    expect(requests.find(request => request.type === 'companion.update')).toEqual({ type: 'companion.update', companionId: 'alice', name: 'Alice', persona: longPersona + '新的约定😀' });
  } finally { dates.mockRestore(); }
});

it('preserves the full 24000-character persona through refresh, IME composition and a failed save', async () => {
  await mount(); await click('编辑伙伴');
  const form = host.querySelector<HTMLFormElement>('.bot-modal')!, field = form.querySelector('textarea')!;
  const persona = '设'.repeat(23998) + '😀';
  expect(field.maxLength).toBe(24000); expect(form.querySelector('input')?.maxLength).toBe(80);
  await input(field, persona); await changed(); expect(field.value).toBe(persona);
  await act(() => field.dispatchEvent(new Event('compositionstart', { bubbles: true })));
  await act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(requests.filter(request => request.type === 'companion.update')).toHaveLength(0);
  await act(() => field.dispatchEvent(new Event('compositionend', { bubbles: true })));
  let attempts = 0;
  override = request => request.type === 'companion.update' ? Promise.resolve(++attempts === 1 ? { ok: false, error: '请重试保存' } : { ok: true }) : undefined;
  await click('保存'); expect(field.value).toBe(persona); expect(form.querySelector('[role=alert]')?.textContent).toContain('请重试保存');
  await click('保存'); expect(host.querySelector('.bot-modal')).toBeNull();
  expect(requests.filter(request => request.type === 'companion.update')).toEqual([
    { type: 'companion.update', companionId: 'alice', name: 'Alice', persona }, { type: 'companion.update', companionId: 'alice', name: 'Alice', persona },
  ]);
});

it('discards cancelled drafts and separates existing companions, new companions and new groups', async () => {
  await mount(); await click('编辑伙伴'); await input(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!, '不应保存的Alice草稿'); await click('取消');
  expect(requests.some(request => ['companion.update', 'companion.create'].includes(request.type))).toBe(false);
  await select('私聊乙'); await click('编辑伙伴'); expect(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!.value).toBe('直接简明'); await click('取消');
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="新伙伴"]')!.click());
  expect(host.querySelector<HTMLInputElement>('.bot-modal input')!.value).toBe(''); expect(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!.value).toBe('');
  await input(host.querySelector<HTMLInputElement>('.bot-modal input')!, '新名字'); await input(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!, '新伙伴草稿'); await click('取消');
  await click('新群聊'); expect(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!.value).toBe(''); expect(host.querySelector('.bot-modal textarea')).toBeNull();
  expect([...host.querySelectorAll<HTMLInputElement>('.bot-modal input[type=checkbox]')].some(input => input.checked)).toBe(false);
  await click('取消'); await click('编辑伙伴'); expect(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!.value).toBe('直接简明');
});

it('does not close or replace a newer group draft when a cancelled editor save finishes late', async () => {
  await mount(); const pending = deferred<BotResponse>();
  override = request => request.type === 'companion.update' ? pending.promise : undefined;
  await click('编辑伙伴'); await input(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!, '仅Alice的新设定'); await click('保存');
  expect(host.querySelector<HTMLButtonElement>('.bot-editor-primary')!.disabled).toBe(true);
  await click('取消'); await click('新群聊');
  await input(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!, '后打开的群');
  await act(() => host.querySelector<HTMLInputElement>('.bot-modal input[type=checkbox]')!.click());
  await act(() => pending.resolve({ ok: true }));
  expect(host.querySelector('.bot-modal h2')?.textContent).toBe('新群聊'); expect(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!.value).toBe('后打开的群');
  await click('创建');
  expect(requests.find(request => request.type === 'companion.update')).toEqual({ type: 'companion.update', companionId: 'alice', name: 'Alice', persona: '仅Alice的新设定' });
  expect(requests.find(request => request.type === 'conversation.create')).toEqual({ type: 'conversation.create', title: '后打开的群', kind: 'group', memberIds: ['alice'], participationMode: 'automatic' });
});

it('changes only the originating group policy and ignores its late completion after switching chats', async () => {
  snapshots.a!.conversations[0] = { ...snapshots.a!.conversations[0]!, kind: 'group', memberIds: ['user', 'alice', 'bob'] };
  await mount(); const pending = deferred<BotResponse>();
  override = request => request.type === 'conversation.policy' ? pending.promise : undefined;
  const policy = host.querySelector<HTMLSelectElement>('.bot-group-policy select')!;
  expect(policy.value).toBe('all');
  await act(() => { policy.value = 'automatic'; policy.dispatchEvent(new Event('change', { bubbles: true })); });
  await select('私聊乙'); const previousStates = requests.filter(request => request.type === 'state').length;
  await act(() => pending.resolve({ ok: true }));
  expect(requests.find(request => request.type === 'conversation.policy')).toEqual({ type: 'conversation.policy', conversationId: 'a', participationMode: 'automatic' });
  expect(requests.filter(request => request.type === 'state')).toHaveLength(previousStates);
  expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe('私聊乙');
});

it('shows actual companion presence and opens the task in its source room rather than the current private chat', async () => {
  const presence: NonNullable<BotSnapshot['presence']> = { alice: { status: 'working', updatedAt: at, counts: { activeTasks: 2, queued: 1, running: 1, waiting: 0, stopping: 0, blocked: 0, replying: 0, pendingMessages: 0 }, activity: { taskId: 'cross-room', conversationId: 'b', title: '整理素材', phase: 'using-tool', updatedAt: at }, events: [] } };
  snapshots.a!.presence = presence; snapshots.b!.presence = presence;
  for (const value of Object.values(snapshots)) value.conversations[1] = { ...value.conversations[1]!, kind: 'group', memberIds: ['user', 'alice', 'bob'] };
  const task = { id: 'cross-room', conversationId: 'b', companionId: 'alice', goal: '完整要求', title: '整理素材', status: 'running' };
  override = request => request.type === 'task.list' ? Promise.resolve({ ok: true, taskPage: { items: [task], total: 1, activeCount: 1, queuedCount: 0, page: 0, limit: 6 } }) : request.type === 'task.get' ? Promise.resolve({ ok: true, task }) : undefined;
  await mount();
  expect(host.querySelector('.bot-chat-identity .bot-presence-dot')?.getAttribute('data-presence')).toBe('working');
  expect(host.querySelector('.bot-presence-summary')?.textContent).toContain('执行任务 · 2 项任务');
  expect(host.querySelector('.bot-active-tasks')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('.bot-presence-summary')!.click());
  expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe('私聊乙');
  expect(requests.filter(request => request.type === 'task.get').at(-1)).toMatchObject({ conversationId: 'b', taskId: 'cross-room' });
  expect(host.querySelector('[data-bot-task]')?.getAttribute('data-bot-task')).toBe('cross-room');
});

it('keeps a confirmed paused task visible in the header task count', async () => {
  snapshots.a!.tasks = [{ id: 'paused', conversationId: 'a', companionId: 'alice', title: '保留进度', goal: '任务', status: 'paused', progress: { phase: 'paused' } }];
  await mount(); expect(host.querySelector('.bot-chat-tasks')?.textContent).toBe('任务1');
});
