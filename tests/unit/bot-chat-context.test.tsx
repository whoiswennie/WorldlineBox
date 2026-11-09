// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotChatContext } from '../../src/renderer/companion-bot/BotChatContext';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const at = '2026-11-04T03:55:00.000Z';
const companions = ['大肥鱼', 'GPT'].map((name, index) => ({ id: `person-${index}`, name, persona: '', createdAt: at }));
const props = (): ComponentProps<typeof BotChatContext> => ({
  conversation: { id: 'room', title: '一起做世界线', kind: 'group', memberIds: ['user', ...companions.map(person => person.id)], createdAt: at },
  companions, locale: 'zh-CN', onClose: vi.fn(), onEdit: vi.fn(), onMemory: vi.fn(), onMembers: vi.fn(),
});
async function mount(value: ComponentProps<typeof BotChatContext>) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(() => root!.render(<BotChatContext {...value} />)); }
it('keeps group details and members while removing task and app-brain controls', async () => {
  await mount(props());
  expect(host.querySelector('.bot-group-overview')).not.toBeNull();
  expect(host.textContent).toContain('群成员');
  expect(host.querySelector('.bot-context-brain,.bot-context-tasks,.bot-context-group-tabs')).toBeNull();
  expect(host.textContent).not.toContain('任务中心');
  const hide = host.querySelector<HTMLButtonElement>('header button')!;
  expect(hide.getAttribute('aria-label')).toBe('收起聊天信息');
});

it('keeps direct-chat character and memory actions', async () => {
  const value = props(); value.conversation = { ...value.conversation, kind: 'direct', memberIds: ['user', companions[0]!.id] }; value.companions = [companions[0]!];
  await mount(value);
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('.bot-context-actions button')];
  await act(() => buttons[0]!.click()); expect(value.onEdit).toHaveBeenCalledWith(companions[0]);
  await act(() => buttons[1]!.click()); expect(value.onMemory).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain('主脑');
});

it('keeps peer observation and its explicit join action without a task workspace', async () => {
  const value = props(); value.conversation = { ...value.conversation, kind: 'peer', memberIds: companions.map(person => person.id) }; value.onJoinPeer = vi.fn(); value.onContact = vi.fn();
  await mount(value);
  expect(host.textContent).toContain('你正在旁观');
  await act(() => host.querySelector<HTMLButtonElement>('.bot-context-peer-members li button')!.click()); expect(value.onContact).toHaveBeenCalledWith(companions[0]!.id);
  await act(() => host.querySelector<HTMLButtonElement>('.bot-context-peer-join')!.click()); expect(value.onJoinPeer).toHaveBeenCalledOnce();
  expect(host.querySelector('.bot-context-brain,.bot-context-tasks')).toBeNull();
});
