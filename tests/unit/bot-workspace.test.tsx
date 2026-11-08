// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotWorkspace } from '../../src/renderer/companion-bot/BotWorkspace';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { BotEvent, BotMessage, BotPersonaTemplate, BotRequest, BotResponse, BotSnapshot, WorldlineBoxBotApi } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-11-02T10:00:00Z';
let root: Root | undefined, host: HTMLDivElement, listener: ((event: BotEvent) => void) | undefined;
let snapshots: Record<string, BotSnapshot>, requests: BotRequest[], override: ((request: BotRequest) => Promise<BotResponse> | undefined) | undefined;
let personas: Map<string, BotPersonaTemplate>;
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
  personas = new Map(snapshots.a!.companions.map(companion => [companion.id, { id: 'default', name: '默认人格', prompt: companion.persona, builtin: false, isDefault: true, modified: false, charCount: companion.persona.length, updatedAt: at }]));
  requests = []; override = undefined; listener = undefined;
});
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
function boundLauncherState(): DshLauncherState {
  const runtime = { id: 'runtime-a', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64' as const, adapter: 'node-cli-web-v1' as const, source: '', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 1, byteLength: 1 };
  return { supported: true, rootPath: 'fixture', runtimes: [runtime], instances: ['alice','bob'].map(id => ({ id: `${id}-instance`, companionId: id, name: id, runtimeId: runtime.id, profile: 'web', status: 'stopped', isDefault: false, homePath: '', agentsPath: '', workspacePath: '', browserPartition: id, createdAt: at, updatedAt: at })), snapshots: [], packs: [], operations: [] };
}
async function mount(launcherApi: WorldlineBoxDshLauncherApi = { request: async () => ({ ok: true, state: boundLauncherState() }), onChanged: () => () => undefined }) {
  const api: WorldlineBoxBotApi = {
    async request(request) {
      requests.push(request); const result = override?.(request); if (result) return result;
      if (request.type === 'state') return { ok: true, snapshot: snapshots[request.conversationId ?? 'a'] };
      if (request.type === 'conversation.open') return { ok: true, conversationId: request.companionId === 'alice' ? 'a' : 'b' };
      if (request.type === 'companion.personas.list' || request.type === 'companion.personas.get' || request.type === 'companion.personas.save') {
        let persona = personas.get(request.companionId)!;
        if (request.type === 'companion.personas.save') {
          persona = { ...persona, name: request.name, prompt: request.prompt, charCount: request.prompt.length, modified: true }; personas.set(request.companionId, persona);
          for (const state of Object.values(snapshots)) state.companions = state.companions.map(companion => companion.id === request.companionId ? { ...companion, persona: request.prompt } : companion);
        }
        const summary = { id: persona.id, name: persona.name, builtin: persona.builtin, isDefault: persona.isDefault, modified: persona.modified, charCount: persona.charCount, updatedAt: persona.updatedAt };
        return { ok: true, personas: { items: [summary], activeId: 'default', limit: 64 }, ...(request.type !== 'companion.personas.list' ? { persona } : {}) };
      }
      return { ok: true };
    },
    onEvent(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorkspace api={api} launcherApi={launcherApi} onOpenSettings={() => undefined} /></LocaleProvider>));
}
const composer = () => host.querySelector<HTMLTextAreaElement>('.bot-composer textarea')!;
it('blocks private chat and calls until the user explicitly selects a runtime and binds the companion', async () => {
  let state = boundLauncherState(); state.instances = [{ ...state.instances[0]!, id: 'ordinary-default', isDefault: true, companionId: undefined }];
  const launcherRequest = vi.fn<WorldlineBoxDshLauncherApi['request']>(async request => {
    if (request.type === 'companion.environment.create') state = { ...state, instances: [...state.instances, { ...boundLauncherState().instances[0]!, runtimeId: request.runtimeId }] };
    return { ok: true, state };
  });
  await mount({ request: launcherRequest, onChanged: () => () => undefined });
  expect(composer()).toBeNull(); expect(host.querySelector<HTMLButtonElement>('.bot-call-entry')?.disabled).toBe(true);
  expect(host.querySelector('[data-companion-binding="alice"]')).not.toBeNull();
  expect(launcherRequest.mock.calls.every(([value]) => value.type === 'state')).toBe(true);
  await click('稍后设置'); expect(host.querySelector('[data-companion-binding]')).toBeNull(); expect(composer()).toBeNull();
  await click('绑定实例');
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="选择 DSH 版本"]')!;
  await act(() => { select.value = 'runtime-a'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('确认创建并绑定');
  expect(composer()).not.toBeNull(); expect(host.querySelector('[data-companion-binding]')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('.bot-call-entry')?.disabled).toBe(false);
  expect(sends()).toHaveLength(0);
});
it('requires both group bindings, including the installed runtime, and does not allow the first bound member to unlock chat', async () => {
  snapshots.a!.conversations[0] = { ...snapshots.a!.conversations[0]!, kind: 'group', memberIds: ['user', 'alice', 'bob'] };
  let state = boundLauncherState(); state.instances = [{ ...state.instances[0]!, runtimeId: 'removed-runtime' }];
  let change: (value: DshLauncherState) => void = () => undefined;
  await mount({ request: async () => ({ ok: true, state }), onChanged: listener => { change = listener; return () => undefined; } });
  expect(host.textContent).toContain('已绑定实例的运行版本不可用'); expect(composer()).toBeNull();
  state = { ...state, instances: boundLauncherState().instances.slice(0, 1) };
  await act(() => change(state));
  expect(host.querySelector('[data-companion-binding="bob"]')).not.toBeNull(); expect(composer()).toBeNull();
  state = boundLauncherState(); await act(() => change(state));
  expect(host.querySelector('[data-companion-binding]')).toBeNull(); expect(composer()).not.toBeNull(); expect(sends()).toHaveLength(0);
});
it('shows a disabled companion clearly and re-enables through the shared runtime command before chatting', async () => {
  snapshots.a!.companions[0]!.enabled = false;
  override = request => {
    if (request.type !== 'companion.runtime') return undefined;
    snapshots.a!.companions[0]!.enabled = request.operation === 'start';
    return Promise.resolve({ ok: true, snapshot: snapshots.a });
  };
  await mount();
  expect(host.querySelector('.bot-chat-title-status')?.textContent).toContain('已关闭');
  expect(host.querySelector('.bot-sidebar .bot-contact-status')?.textContent).toBe('已关闭');
  expect(host.querySelector('.bot-composer')).toBeNull();
  expect(host.querySelector<HTMLButtonElement>('.bot-call-entry')?.disabled).toBe(true);
  await click('启用伙伴');
  expect(requests).toContainEqual({ type: 'companion.runtime', companionId: 'alice', operation: 'start' });
  expect(host.querySelector('.bot-companion-disabled')).toBeNull();
  expect(composer()).not.toBeNull();
});
it('stops a group discussion through a user message without erasing the current composer draft', async () => {
  snapshots.a!.conversations[0] = { ...snapshots.a!.conversations[0]!, kind: 'group', memberIds: ['user', 'alice', 'bob'] };
  await mount(); await input(composer(), '还没发出的草稿'); await click('停止讨论');
  expect(requests).toContainEqual(expect.objectContaining({ type: 'message.send', conversationId: 'a', content: '停止讨论' }));
  expect(composer().value).toBe('还没发出的草稿');
});
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
async function closeEditor() { await act(() => host.querySelector<HTMLButtonElement>('.bot-editor-close')!.click()); }
async function emit(event: BotEvent) { await act(() => { listener!(event); }); }
async function changed(conversationId = 'a') { await emit({ type: 'changed', conversationId }); await act(() => vi.advanceTimersByTime(110)); }
const sends = () => requests.filter((request): request is Extract<BotRequest, { type: 'message.send' }> => request.type === 'message.send');
const rows = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => {
  const number = first + index;
  // Other conversations also use the global sequence; one conversation is not numerically contiguous.
  return message(`m${number}`, 'a', number * 7, `消息 ${number}`);
});
const visibleIds = () => [...host.querySelectorAll<HTMLElement>('[data-bot-message]')].map(element => element.dataset.botMessage);

it.each(['direct', 'group'] as const)('retains %s task activity across a natural reply, later messages and conversation switches', async kind => {
  const people = kind === 'group' ? ['alice', 'bob'] : ['alice'];
  const notices = people.map((owner, index) => ({ ...message(`notice-${owner}`, 'a', index * 2 + 1, 'RAW EXECUTOR OUTPUT'), senderId: 'task-service', senderName: '任务回执',
    taskNotice: { taskId: `task-${owner}`, kind: 'task_done' as const, replyMessageId: `result-${owner}`, companionId: owner, companionName: owner === 'alice' ? 'Alice' : 'Bob', title: `整理资料 · ${owner}`, status: 'succeeded' } }));
  snapshots.a = snapshot(notices.flatMap((notice, index) => [notice, message(`result-${people[index]}`, 'a', index * 2 + 2, '', 'running')]));
  snapshots.a.conversations[0] = { ...snapshots.a.conversations[0]!, kind, memberIds: ['user', ...people] };
  await mount();
  const expectedIds = notices.map(notice => notice.id);
  const noticeIds = () => [...host.querySelectorAll<HTMLElement>('.bot-task-notice')].map(element => element.dataset.botMessage);
  expect(noticeIds()).toEqual(expectedIds);
  const original = host.querySelector('[data-bot-message="notice-alice"]');
  snapshots.a.messages = snapshots.a.messages.map(entry => entry.senderId === 'task-service' ? entry : { ...entry, status: 'sent', content: '结果已整理好。' });
  await changed();
  expect(noticeIds()).toEqual(expectedIds); expect(host.querySelector('[data-bot-message="notice-alice"]')).toBe(original);
  snapshots.a.messages.push(message('later-chat', 'a', 10, '新的日常对话'));
  await changed(); expect(noticeIds()).toEqual(expectedIds); expect(transcript()).not.toContain('RAW EXECUTOR OUTPUT');
  expect([...host.querySelectorAll('.bot-task-notice-meta strong')].map(element => element.textContent)).toEqual(people.map(owner => owner === 'alice' ? 'Alice' : 'Bob'));
  expect(snapshots.a.tasks).toHaveLength(0); // Historical tasks need not be in the current task window.
  await select('私聊乙'); expect(noticeIds()).toEqual([]);
  await select('私聊甲'); expect(noticeIds()).toEqual(expectedIds);
  expect(visibleIds()).toEqual([...snapshots.a.messages.map(entry => entry.id)]);
});

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

function taskFollowupFixture(status = 'running') {
  snapshots.a!.tasks = [{ id: 'task-original', conversationId: 'a', companionId: 'alice', title: '整理项目目录', goal: '只整理项目目录', status }];
  override = request => request.type === 'task.list' ? Promise.resolve({ ok: true, taskPage: { items: snapshots.a!.tasks, total: 1, page: 0, limit: 6, activeCount: ['succeeded', 'failed', 'cancelled'].includes(status) ? 0 : 1, queuedCount: 0 } })
    : request.type === 'task.get' ? Promise.resolve({ ok: true, task: snapshots.a!.tasks[0] }) : undefined;
}
async function followOriginalTask() {
  await act(() => host.querySelector<HTMLButtonElement>('.bot-chat-tasks')!.click()); await click('跟进这个任务');
}

it('follows an existing task through the normal chat composer without replacing its draft or exposing task IDs', async () => {
  taskFollowupFixture(); await mount(); await input(composer(), '请保留原始文件名。'); await followOriginalTask();
  expect(host.querySelector('[aria-label="任务工作台"]')).toBeNull(); expect(document.activeElement).toBe(composer());
  expect(host.querySelector('.bot-task-followup')?.textContent).toContain('跟进任务 · 整理项目目录');
  expect(host.querySelector('.bot-task-followup')?.textContent).toContain('Alice'); expect(host.querySelector('.bot-task-followup')?.textContent).not.toContain('task-original');
  expect(composer().value).toBe('请保留原始文件名。');
  await input(composer(), '长'.repeat(16001)); expect(composer().value).toHaveLength(16001); expect(composer().maxLength).toBe(16000);
  expect(host.querySelector<HTMLButtonElement>('.bot-send')!.disabled).toBe(true); expect(host.querySelector('.bot-task-followup')?.textContent).toContain('最多16000字');
  await input(composer(), '请保留原始文件名。');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-send')!.click());
  expect(sends().at(-1)).toMatchObject({ conversationId: 'a', content: '请保留原始文件名。', replyToTaskId: 'task-original' });
  expect(requests.some(request => request.type === 'task.control' && request.operation === 'send')).toBe(false);
  expect(host.querySelector('.bot-task-followup')).toBeNull(); expect(composer().value).toBe('');
  await input(composer(), '普通聊天继续。'); await act(() => host.querySelector<HTMLButtonElement>('.bot-send')!.click());
  expect(sends().at(-1)?.replyToTaskId).toBeUndefined();
});

it('keeps task follow-up targets with each chat draft and lets the user cancel only the target', async () => {
  taskFollowupFixture(); await mount(); await input(composer(), '甲任务的补充。'); await followOriginalTask();
  await select('私聊乙'); expect(host.querySelector('.bot-task-followup')).toBeNull(); await input(composer(), '乙的普通草稿');
  await select('私聊甲'); expect(composer().value).toBe('甲任务的补充。'); expect(host.querySelector('.bot-task-followup')).not.toBeNull();
  const cancel = host.querySelector<HTMLButtonElement>('[aria-label="取消任务跟进"]')!; await act(() => cancel.click());
  expect(host.querySelector('.bot-task-followup')).toBeNull(); expect(composer().value).toBe('甲任务的补充。');
  await select('私聊乙'); expect(composer().value).toBe('乙的普通草稿');
  expect(sends()).toHaveLength(0);
});
it('shows actual follow-up delivery beside the user message and opens its original task', async () => {
  taskFollowupFixture();
  const sent = { ...message('guidance', 'a', 2, '请同时提供 HTML。'), senderId: 'user', taskFollowup: { taskId: 'task-original', title: '整理项目目录', state: 'queued' as const } };
  snapshots.a!.messages = [sent]; await mount();
  expect(host.querySelector('.bot-followup-receipt')?.textContent).toContain('正在交给原任务');
  snapshots.a!.messages = [{ ...sent, taskFollowup: { ...sent.taskFollowup, state: 'delivered' } }]; await changed();
  expect(host.querySelector('.bot-followup-receipt')?.textContent).toContain('已交给原任务'); expect(host.querySelector('.bot-followup-receipt')?.textContent).not.toContain('task-original');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-followup-receipt button')!.click());
  expect(host.querySelector('[aria-label="任务工作台"]')).not.toBeNull(); expect(requests.some(request => request.type === 'task.get' && request.taskId === 'task-original')).toBe(true);
});

it('retains a rejected task follow-up for retry and refuses to silently send it as ordinary chat after a human stop', async () => {
  taskFollowupFixture(); const previous = override; override = request => request.type === 'message.send' ? Promise.resolve({ ok: false, error: '任务连接暂未就绪' }) : previous?.(request);
  await mount(); await followOriginalTask(); await input(composer(), '仅分析，不修改。');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-send')!.click()); const first = sends().at(-1)!;
  expect(host.querySelector('.bot-task-followup')).not.toBeNull(); expect(composer().value).toBe('仅分析，不修改。');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-send')!.click()); expect(sends().at(-1)?.requestId).toBe(first.requestId);
  snapshots.a = { ...snapshots.a!, tasks: [{ ...snapshots.a!.tasks[0]!, status: 'cancelled', cancelRequested: true, followupAvailable: false }] }; await changed();
  expect(host.querySelector('.bot-task-followup')?.textContent).toContain('任务当前不可跟进'); expect(host.querySelector<HTMLButtonElement>('.bot-send')!.disabled).toBe(true);
  const sentCount = sends().length; await act(() => composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(sends()).toHaveLength(sentCount);
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="取消任务跟进"]')!.click()); expect(host.querySelector<HTMLButtonElement>('.bot-send')!.disabled).toBe(false);
  await act(() => host.querySelector<HTMLButtonElement>('.bot-send')!.click()); expect(sends().at(-1)?.replyToTaskId).toBeUndefined();
});

it.each(['succeeded', 'failed'])('offers an explicitly authorized %s task continuation without waking work until the user sends', async status => {
  taskFollowupFixture(status); snapshots.a!.tasks[0]!.followupAvailable = true; await mount();
  await act(() => host.querySelector<HTMLButtonElement>('.bot-chat-tasks')!.click()); await click('继续这个任务');
  expect(host.querySelector('.bot-task-followup')?.textContent).toContain('继续任务 · 整理项目目录'); expect(sends()).toHaveLength(0);
  expect(requests.some(request => request.type === 'task.control')).toBe(false);
  await input(composer(), '沿原任务继续，补充核对文件数量。'); await act(() => host.querySelector<HTMLButtonElement>('.bot-send')!.click());
  expect(sends().at(-1)).toMatchObject({ conversationId: 'a', replyToTaskId: 'task-original', content: '沿原任务继续，补充核对文件数量。' });
  expect(host.querySelector('.bot-task-followup')).toBeNull();
});

it.each([{ status: 'succeeded', followupAvailable: false, humanStopped: true }, { status: 'failed' }, { status: 'cancelled', followupAvailable: false }, { status: 'unknown', followupAvailable: false }])('does not offer historical continuation without a current host grant: %j', async state => {
  taskFollowupFixture(state.status); Object.assign(snapshots.a!.tasks[0]!, state); await mount();
  await act(() => host.querySelector<HTMLButtonElement>('.bot-chat-tasks')!.click());
  expect(host.querySelector('.bot-task-follow-action')).toBeNull(); expect(sends()).toHaveLength(0);
});

it('keeps the draft but disables a selected historical continuation after its task record is removed', async () => {
  taskFollowupFixture('succeeded'); snapshots.a!.tasks[0]!.followupAvailable = true;
  const previous = override;
  override = request => {
    if (request.type === 'task.control' && request.operation === 'remove') { snapshots.a = { ...snapshots.a!, tasks: [] }; return Promise.resolve({ ok: true, taskRemoved: true }); }
    if (request.type === 'task.get' && !snapshots.a!.tasks.length) return Promise.resolve({ ok: true, taskRemoved: true });
    return previous?.(request);
  };
  await mount(); await act(() => host.querySelector<HTMLButtonElement>('.bot-chat-tasks')!.click()); await click('继续这个任务');
  await input(composer(), '仍然保留的草稿。'); await act(() => host.querySelector<HTMLButtonElement>('.bot-chat-tasks')!.click()); await click('移除记录');
  expect(host.querySelector('.bot-task-follow-action')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭任务"]')!.click());
  expect(composer().value).toBe('仍然保留的草稿。'); expect(host.querySelector('.bot-task-followup')?.textContent).toContain('任务当前不可跟进');
  expect(host.querySelector<HTMLButtonElement>('.bot-send')!.disabled).toBe(true); expect(sends()).toHaveLength(0);
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
  snapshots.a = snapshot(rows(1, 400)); await mount(); await click('角色卡');
  const field = host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!;
  const dates = vi.spyOn(Date.prototype, 'toLocaleTimeString');
  try {
    const longPersona = '认真表达，保留自己的边界与真实经历。\n'.repeat(1000);
    await input(field, longPersona);
    await input(field, longPersona + '新的约定😀');
    expect(dates.mock.calls.length).toBe(0);
    await click('保存修改');
    expect(requests.find(request => request.type === 'companion.personas.save')).toEqual({ type: 'companion.personas.save', companionId: 'alice', id: 'default', name: '默认人格', prompt: longPersona + '新的约定😀', activate: false });
    expect(host.querySelector('textarea[name=persona]')).toBe(field);
  } finally { dates.mockRestore(); }
});

it('preserves the full 24000-character persona through refresh, IME composition and a failed save', async () => {
  await mount(); await click('角色卡');
  const dialog = host.querySelector<HTMLElement>('.bot-modal')!, field = dialog.querySelector('textarea')!;
  const persona = '设'.repeat(23998) + '😀';
  expect(field.maxLength).toBe(24000); expect(dialog.querySelector<HTMLInputElement>('input[name=templateName]')?.maxLength).toBe(80);
  await input(field, persona); await changed(); expect(field.value).toBe(persona);
  await act(() => field.dispatchEvent(new Event('compositionstart', { bubbles: true })));
  await click('保存修改');
  expect(field.form).toBeNull();
  expect(requests.filter(request => request.type === 'companion.personas.save')).toHaveLength(0);
  await act(() => field.dispatchEvent(new Event('compositionend', { bubbles: true })));
  let attempts = 0;
  override = request => request.type === 'companion.personas.save' && ++attempts === 1 ? Promise.resolve({ ok: false, error: '请重试保存' }) : undefined;
  await click('保存修改'); expect(field.value).toBe(persona); expect(dialog.querySelector('[role=alert]')?.textContent).toContain('请重试保存');
  await click('保存修改'); expect(host.querySelector('.bot-modal')).toBe(dialog); expect(field.value).toBe(persona);
  expect(dialog.textContent).toContain('已保存并启用');
  expect(requests.filter(request => request.type === 'companion.personas.save')).toEqual([
    { type: 'companion.personas.save', companionId: 'alice', id: 'default', name: '默认人格', prompt: persona, activate: false },
    { type: 'companion.personas.save', companionId: 'alice', id: 'default', name: '默认人格', prompt: persona, activate: false },
  ]);
});

it('discards cancelled drafts and separates existing companions, new companions and new groups', async () => {
  await mount(); await click('角色卡'); await input(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!, '不应保存的Alice草稿'); await closeEditor();
  expect(requests.some(request => ['companion.update', 'companion.create', 'companion.personas.save'].includes(request.type))).toBe(false);
  await select('私聊乙'); await click('角色卡'); expect(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!.value).toBe('直接简明'); await closeEditor();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="新伙伴"]')!.click());
  expect(host.querySelector<HTMLInputElement>('.bot-modal input')!.value).toBe(''); expect(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!.value).toBe('');
  await input(host.querySelector<HTMLInputElement>('.bot-modal input')!, '新名字'); await input(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!, '新伙伴草稿'); await click('取消');
  await click('新群聊'); expect(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!.value).toBe(''); expect(host.querySelector('.bot-modal textarea')).toBeNull();
  expect([...host.querySelectorAll<HTMLInputElement>('.bot-modal input[type=checkbox]')].some(input => input.checked)).toBe(false);
  await click('取消'); await click('角色卡'); expect(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!.value).toBe('直接简明');
});

it('does not close or replace a newer group draft when a cancelled editor save finishes late', async () => {
  await mount(); const pending = deferred<BotResponse>();
  override = request => request.type === 'companion.update' ? pending.promise : undefined;
  await click('角色卡'); await click('基本资料'); await input(host.querySelector<HTMLInputElement>('.bot-editor-basics input[name=name]')!, 'Alice 的新名字'); await click('保存');
  expect(host.querySelector<HTMLButtonElement>('.bot-editor-basics .bot-editor-primary')!.disabled).toBe(true);
  await closeEditor(); await click('新群聊');
  await input(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!, '后打开的群');
  await act(() => host.querySelector<HTMLInputElement>('.bot-modal input[type=checkbox]')!.click());
  await act(() => pending.resolve({ ok: true }));
  expect(host.querySelector('.bot-modal h2')?.textContent).toBe('新群聊'); expect(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!.value).toBe('后打开的群');
  await click('创建');
  expect(requests.find(request => request.type === 'companion.update')).toEqual({ type: 'companion.update', companionId: 'alice', name: 'Alice 的新名字' });
  expect(requests.find(request => request.type === 'conversation.create')).toEqual({ type: 'conversation.create', title: '后打开的群', kind: 'group', memberIds: ['alice'], participationMode: 'automatic' });
});

it('does not refresh or replace a newer group draft when a closed persona template save finishes late', async () => {
  await mount(); const pending = deferred<BotResponse>();
  override = request => request.type === 'companion.personas.save' ? pending.promise : undefined;
  await click('角色卡'); await input(host.querySelector<HTMLTextAreaElement>('.bot-modal textarea')!, '仅Alice的新设定'); await click('保存修改');
  expect(host.querySelector<HTMLButtonElement>('.bot-personas__editor-footer .bot-editor-primary')!.disabled).toBe(true);
  await closeEditor(); await click('新群聊');
  await input(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!, '另一个新群草稿');
  const before = requests.filter(request => request.type === 'state').length;
  await act(() => pending.resolve({ ok: true }));
  expect(requests.filter(request => request.type === 'state')).toHaveLength(before);
  expect(host.querySelector('.bot-modal h2')?.textContent).toBe('新群聊'); expect(host.querySelector<HTMLInputElement>('.bot-modal input:not([type=checkbox])')!.value).toBe('另一个新群草稿');
  expect(requests.find(request => request.type === 'companion.personas.save')).toEqual({ type: 'companion.personas.save', companionId: 'alice', id: 'default', name: '默认人格', prompt: '仅Alice的新设定', activate: false });
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
