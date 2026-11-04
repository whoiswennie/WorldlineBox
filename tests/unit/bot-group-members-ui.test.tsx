// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotGroupMembers } from '../../src/renderer/companion-bot/BotGroupMembers';
import type { BotCompanion, BotConversation, BotRequest, BotResponse } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const companions: BotCompanion[] = [
  { id: 'fish', name: '大肥鱼', persona: '私人设定不应显示在成员列表', createdAt: '2026-11-04' },
  { id: 'gpt', name: 'GPT', persona: '另一个私人设定', createdAt: '2026-11-04' },
  { id: 'gemini', name: 'Gemini', persona: '成员', createdAt: '2026-11-04' },
];
const conversation: BotConversation = { id: 'group-a', title: '一起聊天', kind: 'group', memberIds: ['user', 'fish', 'gpt'], createdAt: '2026-11-04', ownerId: 'user' };
async function mount(overrides: Partial<ComponentProps<typeof BotGroupMembers>> = {}) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  const request = vi.fn<(input: BotRequest) => Promise<BotResponse>>(async () => ({ ok: true })), onChanged = vi.fn(async () => undefined), onClose = vi.fn(), onDissolved = vi.fn();
  await act(() => root!.render(<BotGroupMembers conversation={conversation} companions={companions} locale="zh-CN" request={request} onChanged={onChanged} onClose={onClose} onDissolved={onDissolved} {...overrides} />));
  return { request, onChanged, onClose, onDissolved };
}
function button(label: string): HTMLButtonElement {
  const target = [...document.querySelectorAll<HTMLButtonElement>('.bot-group-members button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  expect(target, label).toBeDefined(); return target!;
}
async function click(label: string) { await act(async () => { button(label).click(); await Promise.resolve(); }); }
async function search(value: string) {
  const field = document.querySelector<HTMLInputElement>('[aria-label="搜索群成员"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }

it('keeps the user as a fixed owner and commits only selected companion IDs to this group', async () => {
  const f = await mount(); expect(document.querySelector('.is-owner')?.textContent).toContain('群主'); expect(document.body.textContent).not.toContain(companions[0]!.persona);
  expect(document.querySelector('.is-owner button')).toBeNull(); expect(button('保存成员').disabled).toBe(true);
  await click('移除 GPT'); await click('添加伙伴'); await click('添加 Gemini');
  expect(f.request).not.toHaveBeenCalled(); await click('保存成员');
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'conversation.members', conversationId: 'group-a', memberIds: ['fish', 'gemini'] });
  expect(f.onChanged).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledOnce(); expect(f.onDissolved).not.toHaveBeenCalled();
});
it('requires at least one companion and prevents selecting more than 16 before a request is sent', async () => {
  await mount({ conversation: { ...conversation, memberIds: ['user', 'fish'] } }); await click('移除 大肥鱼');
  expect(button('保存成员').disabled).toBe(true); expect(document.body.textContent).toContain('请至少保留一位伙伴');
  await act(() => root!.unmount()); root = undefined; host.remove();
  const many = Array.from({ length: 18 }, (_, index) => ({ id: 'p' + index, name: '伙伴 ' + index, persona: '', createdAt: '2026-11-04' }));
  const f = await mount({ companions: many, conversation: { ...conversation, memberIds: ['user', ...many.slice(0, 16).map(item => item.id)] } });
  await click('添加伙伴'); await click('添加 伙伴 16');
  expect(document.querySelector('[role=alert]')?.textContent).toContain('最多加入 16 位伙伴'); expect(f.request).not.toHaveBeenCalled(); expect(button('保存成员').disabled).toBe(true);
});
it('bounds the DOM for hundreds of companions and searches names across pages without rendering personas', async () => {
  const many = Array.from({ length: 523 }, (_, index) => ({ id: 'member-' + index, name: `伙伴${String(index).padStart(3, '0')}`, persona: 'x'.repeat(10000), createdAt: '2026-11-04' }));
  await mount({ companions: many, conversation: { ...conversation, memberIds: ['user', many[0]!.id] } }); await click('添加伙伴');
  expect(document.querySelectorAll('.bot-group-member')).toHaveLength(40); expect(document.body.textContent?.length).toBeLessThan(10000);
  await click('下一页'); expect(document.querySelector('.bot-group-member strong')?.textContent).toBe('伙伴041');
  await search('伙伴522'); expect(document.querySelectorAll('.bot-group-member')).toHaveLength(1); expect(button('添加 伙伴522')).toBeDefined();
  await search('不存在'); expect(document.querySelectorAll('.bot-group-member')).toHaveLength(0); expect(document.body.textContent).toContain('没有匹配的伙伴');
});
it('uses a second confirmation for dissolution, returns to a legal chat, and never reloads the revoked group', async () => {
  const order: string[] = [], f = await mount({ onDissolved: () => { order.push('dissolved'); }, onClose: () => { order.push('closed'); } });
  await click('解散群聊'); expect(f.request).not.toHaveBeenCalled(); expect(document.querySelector('[role=alertdialog]')).not.toBeNull();
  await click('保留群聊'); expect(document.querySelector('[role=alertdialog]')).toBeNull(); expect(f.request).not.toHaveBeenCalled();
  await click('解散群聊'); await click('确认解散'); expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'conversation.dissolve', conversationId: 'group-a' });
  expect(order).toEqual(['dissolved', 'closed']); expect(f.onChanged).not.toHaveBeenCalled();
});
it('reports a failed change locally, keeps the draft, and prevents duplicate posts while a save is pending', async () => {
  const pending = deferred<BotResponse>(); let first = true;
  const request = vi.fn<(input: BotRequest) => Promise<BotResponse>>(async () => first ? pending.promise : { ok: true }); const f = await mount({ request });
  await click('移除 GPT'); await click('保存成员'); expect(request).toHaveBeenCalledOnce(); expect(button('正在处理…').disabled).toBe(true);
  await act(() => button('正在处理…').click()); expect(request).toHaveBeenCalledOnce();
  await act(() => pending.resolve({ ok: false, error: '成员权限已变化，请重试' })); expect(document.querySelector('[role=alert]')?.textContent).toContain('成员权限已变化');
  expect(document.querySelectorAll('.bot-group-member')).toHaveLength(2); expect(f.onChanged).not.toHaveBeenCalled(); first = false; await click('保存成员');
  expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[1]![0]).toEqual(request.mock.calls[0]![0]); expect(f.onChanged).toHaveBeenCalledOnce();
});
it('does not let a closed old-group response update callbacks or the new group draft', async () => {
  const pending = deferred<BotResponse>(), request = vi.fn<(input: BotRequest) => Promise<BotResponse>>(async () => pending.promise), changed = vi.fn(async () => undefined), dissolved = vi.fn();
  const old = await mount({ request, onChanged: changed, onDissolved: dissolved }); await click('移除 GPT'); await click('保存成员'); await click('关闭成员管理');
  expect(old.onClose).toHaveBeenCalledOnce();
  await mount({ conversation: { ...conversation, id: 'group-b', title: '另一个群', memberIds: ['user', 'gemini'] } }); await act(() => pending.resolve({ ok: true }));
  expect(changed).not.toHaveBeenCalled(); expect(dissolved).not.toHaveBeenCalled(); expect(document.querySelector('.bot-group-members-header p')?.textContent).toBe('另一个群');
  expect(document.querySelectorAll('.bot-group-member')).toHaveLength(2); expect(button('保存成员').disabled).toBe(true);
});
it('shows a dissolution error inside the active confirmation rather than behind its overlay', async () => {
  const f = await mount({ request: async () => ({ ok: false, error: '群聊权限已变化' }) });
  await click('解散群聊'); await click('确认解散');
  expect(document.querySelector('[role=alertdialog] [role=alert]')?.textContent).toBe('群聊权限已变化');
  expect(f.onDissolved).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled();
});
it('does not submit management operations for direct chats, world channels or dissolved groups', async () => {
  for (const variant of [{ ...conversation, kind: 'direct' as const }, { ...conversation, kind: 'world' as const }, { ...conversation, dissolvedAt: '2026-11-04T10:00:00Z' }]) {
    const f = await mount({ conversation: variant }); expect(button('解散群聊').disabled).toBe(true); await click('移除 GPT'); await click('保存成员');
    expect(f.request).not.toHaveBeenCalled(); expect(document.querySelector('[role=status]')?.textContent).toContain('不支持群成员管理');
  }
});
it('shows real member presence without changing the owner or member management request', async () => {
  const f = await mount({ presence: { fish: { status: 'working', updatedAt: '2026-11-04T10:00:00Z',
    counts: { activeTasks: 2, queued: 1, running: 1, waiting: 0, stopping: 0, blocked: 0, replying: 0, pendingMessages: 0 },
    activity: { taskId: 'private-task', conversationId: 'private-chat', title: '不应显示的私人任务正文', phase: 'using-tool', updatedAt: '2026-11-04T10:00:00Z' } } } });
  const fish = [...document.querySelectorAll('.bot-group-member')].find(row => row.querySelector('strong')?.textContent === '大肥鱼')!;
  expect(fish.querySelector('.bot-presence-dot')?.getAttribute('data-presence')).toBe('working');
  expect(fish.querySelector('.bot-presence-text')?.textContent).toBe('执行任务 · 2 项任务');
  expect(document.querySelector('.is-owner .bot-presence-dot')).toBeNull(); expect(button('保存成员').disabled).toBe(true);
  expect(document.body.textContent).not.toContain('不应显示的私人任务正文');
  expect([...document.querySelectorAll('.bot-group-member')].find(row => row.querySelector('strong')?.textContent === 'GPT')?.querySelector('small')?.textContent).toBe('群聊成员');
  await click('移除 GPT'); await click('保存成员');
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'conversation.members', conversationId: 'group-a', memberIds: ['fish'] });
});
