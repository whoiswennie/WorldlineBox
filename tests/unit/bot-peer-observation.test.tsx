// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { botUiSharedLauncher } from '../fixtures/bot-ui-shared-launcher';
import { BotWorkspace } from '../../src/renderer/companion-bot/BotWorkspace';
import { BotChatContext } from '../../src/renderer/companion-bot/BotChatContext';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { BotConversation, BotEvent, BotMessage, BotRequest, BotResponse, BotSnapshot, WorldlineBoxBotApi } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const at = '2026-11-04T08:00:00Z';
const companions = ['Alice', 'Bob', 'Carol'].map(name => ({ id: name.toLowerCase(), name, persona: '', createdAt: at }));
const direct: BotConversation = { id: 'direct', kind: 'direct', title: 'Alice', memberIds: ['user', 'alice'], createdAt: at };
const peer: BotConversation = { id: 'pair', kind: 'peer', title: 'Bob × Alice', memberIds: ['bob', 'alice'], userRole: 'observer', createdAt: at };
const group: BotConversation = { id: 'group', kind: 'group', title: '一起讨论', memberIds: ['user', 'alice', 'bob'], ownerId: 'user', createdAt: at };
const message = (id: string, room: string, sender: string, content: string, status: BotMessage['status'] = 'sent'): BotMessage => ({ id, eventId: id, conversationId: room, senderId: sender, senderName: companions.find(person => person.id === sender)?.name ?? '我', content, createdAt: at, sequence: id.length, status });
const requests: BotRequest[] = [];
const activity = (sequence: number, senderName: string, preview: string) => ({ messageId: `sent-${sequence}`, sequence, senderName, preview, updatedAt: at });
let fixtureConversations: BotConversation[], fixtureActivity: NonNullable<BotSnapshot['conversationActivity']>, notify: ((event: BotEvent) => void) | undefined;
async function mount(override?: (input: BotRequest) => Promise<BotResponse> | undefined, initial?: { rooms: BotConversation[]; activity: NonNullable<BotSnapshot['conversationActivity']> }) {
  requests.length = 0;
  fixtureConversations = initial?.rooms ?? [direct, peer, group];
  fixtureActivity = initial?.activity ?? { direct: activity(1, '我', '只在用户私聊里的历史。'), pair: activity(2, 'Bob', '我们在私聊里核对。') };
  const api: WorldlineBoxBotApi = {
    async request(input) {
      requests.push(input); const result = override?.(input); if (result) return result;
      if (input.type === 'state') {
        const room = input.conversationId ?? direct.id;
        const snapshot: BotSnapshot = { companions, conversations: fixtureConversations, conversationActivity: fixtureActivity, messages: room === peer.id
          ? [message('bob-peer', room, 'bob', '我们在私聊里核对。'), { ...message('alice-peer', room, 'alice', '我正核对清单。', 'running'), progress: { phase: 'waiting-model' } }]
          : room === group.id ? [] : [message('direct-only', direct.id, 'user', '只在用户私聊里的历史。')], tasks: [], hasMore: false,
          runtime: { engine: 'worldlinebox', memory: 'vcp-memory', embedding: 'bundled', activeLanes: 0, ready: true, dataRoot: 'isolated' } };
        return { ok: true, snapshot };
      }
      if (input.type === 'conversation.peer.open') return { ok: true, conversationId: peer.id };
      if (input.type === 'conversation.peer.join') return { ok: true, conversationId: group.id };
      if (input.type === 'conversation.open') return { ok: true, conversationId: direct.id };
      if (input.type === 'history.search') return { ok: true, history: { items: [], hasMore: false } };
      return { ok: true };
    },
    onEvent: listener => { notify = listener; return () => { notify = undefined; }; },
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorkspace launcherApi={botUiSharedLauncher()} api={api} onOpenSettings={() => undefined} /></LocaleProvider>));
}
async function click(label: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  expect(button, label).toBeDefined(); await act(() => button!.click());
}
async function select(title: string) { const button = [...host.querySelectorAll<HTMLButtonElement>('.bot-conversation')].find(item => item.querySelector('strong')?.textContent === title); expect(button).toBeDefined(); await act(() => button!.click()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('shows a real two-actor peer conversation in the shared list with read-only history and no user controls', async () => {
  await mount(); await select(peer.title);
  const row = [...host.querySelectorAll('.bot-conversation')].find(item => item.querySelector('strong')?.textContent === peer.title)!;
  expect(row.textContent).toContain('伙伴私聊 · 旁观'); expect([...row.querySelectorAll<HTMLElement>('.bot-group-portrait')].map(item => item.dataset.companionId)).toEqual(['bob', 'alice']);
  expect(host.querySelector('.bot-chat-header')?.textContent).toContain('伙伴私聊 · 旁观');
  expect(host.querySelector('.bot-transcript')?.textContent).toContain('我们在私聊里核对。'); expect(host.querySelector('.bot-transcript')?.textContent).toContain('我正核对清单。');
  expect(host.querySelector('.bot-transcript')?.textContent).not.toContain('只在用户私聊里的历史');
  expect(host.querySelector('.bot-peer-observer-progress')?.textContent).toContain('等待模型响应');
  expect(host.querySelector('.bot-composer,.bot-chat-tasks,.bot-stop,.bot-group-policy,.bot-group-members-trigger')).toBeNull();
  expect(host.querySelector('.bot-peer-observer-dock')?.textContent).toContain('正在旁观伙伴私聊');
  await click('聊天记录', host.querySelector('.bot-peer-observer-dock')!);
  expect(document.querySelector('[role="dialog"][aria-label="聊天记录"]')).not.toBeNull();
  await act(() => new Promise(resolve => setTimeout(resolve, 350)));
  expect(requests.some(item => item.type === 'history.search' && item.conversationId === peer.id)).toBe(true);
  expect(requests.some(item => ['message.send', 'reply.cancel', 'memory.recall', 'task.list'].includes(item.type))).toBe(false);
});

it('filters existing private messages directly without selecting people or creating an empty room', async () => {
  await mount(); expect([...host.querySelectorAll('.bot-sidebar-shortcuts button')].some(item => item.textContent?.includes('世界'))).toBe(false);
  await click('伙伴私聊');
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(host.querySelectorAll('.bot-conversation')).toHaveLength(1);
  expect(host.querySelector('.bot-conversation')?.textContent).toContain('Bob：我们在私聊里核对。');
  expect(host.querySelector('.bot-peer-list-hint')).toBeNull();
  await select(peer.title); expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe(peer.title);
  await click('聊天'); expect(host.querySelectorAll('.bot-conversation')).toHaveLength(3);
  expect(requests.some(item => ['conversation.peer.open', 'message.send', 'conversation.create', 'world.event'].includes(item.type))).toBe(false);
});

it('creates or reuses a separate participant group without copying the private transcript', async () => {
  const pending = deferred<BotResponse>(); await mount(input => input.type === 'conversation.peer.join' ? pending.promise : undefined); await select(peer.title);
  await click('创建群聊，一起参与', host.querySelector('.bot-peer-observer-dock')!);
  expect(host.querySelector<HTMLButtonElement>('.bot-peer-observer-dock button:last-child')!.disabled).toBe(true);
  await click('创建群聊，一起参与', host.querySelector('.bot-context-peer-members')!);
  expect(requests.filter(item => item.type === 'conversation.peer.join')).toEqual([{ type: 'conversation.peer.join', conversationId: peer.id }]);
  await act(() => pending.resolve({ ok: true, conversationId: group.id }));
  expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe(group.title); expect(host.querySelector('.bot-composer textarea')).not.toBeNull();
  expect(host.querySelector('.bot-peer-observer-dock')).toBeNull(); expect(host.querySelector('.bot-transcript')?.textContent).not.toContain('我们在私聊里核对。');
  expect(requests.some(item => item.type === 'message.send')).toBe(false);
});

it('does not jump back to an old observed room when a delayed join finishes after navigating away', async () => {
  const pending = deferred<BotResponse>(); await mount(input => input.type === 'conversation.peer.join' ? pending.promise : undefined); await select(peer.title);
  await click('创建群聊，一起参与', host.querySelector('.bot-peer-observer-dock')!); await select(direct.title);
  await act(() => pending.resolve({ ok: true, conversationId: group.id }));
  expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe(direct.title); expect(host.querySelector('.bot-composer textarea')).not.toBeNull();
});

it('adds a real incoming peer conversation and preview automatically without taking over the current chat', async () => {
  await mount(undefined, { rooms: [direct, group], activity: { direct: activity(10, '我', '现有私聊') } });
  expect(host.querySelectorAll('.bot-conversation')).toHaveLength(2);
  fixtureConversations = [direct, peer, group]; fixtureActivity = { ...fixtureActivity, pair: activity(11, 'Bob', '我们先核对交付顺序。') };
  await act(() => { notify?.({ type: 'changed', conversationId: peer.id }); }); await act(() => new Promise(resolve => setTimeout(resolve, 130)));
  expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe(direct.title);
  const row = host.querySelector<HTMLElement>('.bot-conversation')!;
  expect(row.querySelector('strong')?.textContent).toBe(peer.title); expect(row.textContent).toContain('Bob：我们先核对交付顺序。');
  expect(row.querySelector('[aria-label="有新消息"]')).not.toBeNull(); expect(host.querySelector('[aria-label="伙伴私聊有新消息"]')).not.toBeNull();
  expect(requests.some(item => item.type === 'state' && item.conversationId === peer.id)).toBe(false);
  await select(peer.title); expect(host.querySelector('.bot-conversation-unread')).toBeNull();
  await click('聊天记录', host.querySelector('.bot-peer-observer-dock')!);
  fixtureActivity = { ...fixtureActivity, pair: activity(12, 'Bob', '这是查看历史期间收到的新消息。') };
  await act(() => { notify?.({ type: 'changed', conversationId: peer.id }); }); await act(() => new Promise(resolve => setTimeout(resolve, 130)));
  expect(host.querySelector('.bot-conversation-unread')).not.toBeNull();
  await click('关闭', document.querySelector('[role="dialog"][aria-label="聊天记录"]')!);
  expect(host.querySelector('.bot-conversation-unread')).toBeNull();
  fixtureActivity = { ...fixtureActivity, pair: activity(9, 'Bob', '更早的消息') };
  await act(() => { notify?.({ type: 'changed', conversationId: peer.id }); }); await act(() => new Promise(resolve => setTimeout(resolve, 130)));
  expect(host.querySelector('.bot-conversation-unread')).toBeNull();
  expect(requests.some(item => ['conversation.peer.open', 'message.send'].includes(item.type))).toBe(false);
});

it('shows an honest empty peer filter without offering an empty pair creator', async () => {
  await mount(undefined, { rooms: [direct, group], activity: {} }); await click('伙伴私聊');
  expect(host.querySelectorAll('.bot-conversation')).toHaveLength(0); expect(host.querySelector('.bot-peer-list-hint,.bot-sidebar-no-results')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(requests.some(item => item.type === 'conversation.peer.open')).toBe(false);
});

it('gives observed peers a participant summary without exposing task or memory mutations', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const memory = vi.fn(), tasks = vi.fn(), join = vi.fn(), contact = vi.fn();
  await act(() => root!.render(<BotChatContext conversation={peer} companions={companions.slice(0, 2)} tasks={[{ id: 'private-task', conversationId: peer.id, companionId: 'alice', goal: 'private task details', status: 'running' }]} locale="zh-CN" onClose={() => undefined} onEdit={() => undefined} onMemory={memory} onTask={tasks} onMembers={() => undefined} onJoinPeer={join} onContact={contact} />));
  expect(host.textContent).toContain('两位伙伴的真实私聊'); expect(host.querySelector('.bot-context-brain,.bot-context-tasks,.bot-context-actions')).toBeNull(); expect(host.textContent).not.toContain('private task details');
  await click('创建群聊，一起参与', host); expect(join).toHaveBeenCalledOnce();
  await act(() => host.querySelector<HTMLButtonElement>('.bot-context-peer-members li>button')!.click()); expect(contact).toHaveBeenCalledWith('alice'); expect(memory).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled();
});
