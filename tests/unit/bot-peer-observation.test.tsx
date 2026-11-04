// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotWorkspace } from '../../src/renderer/companion-bot/BotWorkspace';
import { BotChatContext } from '../../src/renderer/companion-bot/BotChatContext';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { BotConversation, BotMessage, BotRequest, BotResponse, BotSnapshot, WorldlineBoxBotApi } from '../../src/shared/companion-bot';

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
async function mount(override?: (input: BotRequest) => Promise<BotResponse> | undefined) {
  requests.length = 0;
  const api: WorldlineBoxBotApi = {
    async request(input) {
      requests.push(input); const result = override?.(input); if (result) return result;
      if (input.type === 'state') {
        const room = input.conversationId ?? direct.id;
        const snapshot: BotSnapshot = { companions, conversations: [direct, peer, group], messages: room === peer.id
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
    onEvent: () => () => undefined,
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorkspace api={api} onOpenSettings={() => undefined} /></LocaleProvider>));
}
async function click(label: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  expect(button, label).toBeDefined(); await act(() => button!.click());
}
async function select(title: string) { const button = [...host.querySelectorAll<HTMLButtonElement>('.bot-conversation')].find(item => item.querySelector('strong')?.textContent === title); expect(button).toBeDefined(); await act(() => button!.click()); }
async function input(element: HTMLInputElement | HTMLTextAreaElement, text: string) { await act(() => { const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, text); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
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

it('replaces the duplicate world shortcut with an explicit two-companion selector that never sends a message', async () => {
  await mount(); expect([...host.querySelectorAll('.bot-sidebar-shortcuts button')].some(item => item.textContent?.includes('世界'))).toBe(false);
  await click('伙伴私聊'); const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="查看伙伴私聊"]')!;
  expect(dialog).not.toBeNull(); expect(host.contains(dialog)).toBe(false);
  await click('Alice', dialog); await click('Bob', dialog);
  expect(dialog.querySelector<HTMLButtonElement>('[aria-label="Carol"]')!.disabled).toBe(true);
  expect(dialog.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
  await input(dialog.querySelector('input')!, 'Carol'); expect(dialog.querySelectorAll('.bot-peer-picker-list button')).toHaveLength(1);
  expect(dialog.querySelector('footer')?.textContent).toContain('Alice × Bob');
  await click('查看私聊', dialog);
  expect(document.querySelector('.bot-peer-picker')).toBeNull(); expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe(peer.title);
  expect(requests.filter(item => item.type === 'conversation.peer.open')).toEqual([{ type: 'conversation.peer.open', memberIds: ['alice', 'bob'] }]);
  expect(requests.some(item => ['message.send', 'conversation.create', 'world.event'].includes(item.type))).toBe(false);
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

it('cancels an outstanding pair-open without stealing focus or selecting a room after the selector closes', async () => {
  const pending = deferred<BotResponse>(); await mount(input => input.type === 'conversation.peer.open' ? pending.promise : undefined);
  const trigger = [...host.querySelectorAll<HTMLButtonElement>('.bot-sidebar-shortcuts button')].find(item => item.textContent === '伙伴私聊')!;
  trigger.focus(); await click('伙伴私聊'); await click('Alice', document.querySelector('.bot-peer-picker')!); await click('Bob', document.querySelector('.bot-peer-picker')!); await click('查看私聊');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); await act(() => document.querySelector('.bot-peer-picker')!.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true); expect(document.activeElement).toBe(trigger);
  await act(() => pending.resolve({ ok: true, conversationId: peer.id })); expect(host.querySelector('.bot-chat-header h2')?.textContent).toBe(direct.title);
});

it('gives observed peers a participant summary without exposing task or memory mutations', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const memory = vi.fn(), tasks = vi.fn(), join = vi.fn(), contact = vi.fn();
  await act(() => root!.render(<BotChatContext conversation={peer} companions={companions.slice(0, 2)} tasks={[{ id: 'private-task', conversationId: peer.id, companionId: 'alice', goal: 'private task details', status: 'running' }]} locale="zh-CN" onClose={() => undefined} onEdit={() => undefined} onMemory={memory} onTask={tasks} onMembers={() => undefined} onJoinPeer={join} onContact={contact} />));
  expect(host.textContent).toContain('两位伙伴的真实私聊'); expect(host.querySelector('.bot-context-brain,.bot-context-tasks,.bot-context-actions')).toBeNull(); expect(host.textContent).not.toContain('private task details');
  await click('创建群聊，一起参与', host); expect(join).toHaveBeenCalledOnce();
  await act(() => host.querySelector<HTMLButtonElement>('.bot-context-peer-members li>button')!.click()); expect(contact).toHaveBeenCalledWith('alice'); expect(memory).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled();
});
