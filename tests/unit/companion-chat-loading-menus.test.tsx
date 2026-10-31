// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionMessage, CompanionState, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
const at = '2026-10-29T00:00:00Z';
const companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
const room = { id: 'room', kind: 'private' as const, title: companion.name, memberIds: [companion.id], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '上次聊天' };
const state: CompanionState = { companions: [companion], conversations: [room], activities: [], configured: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function mount(readMessages: () => Promise<CompanionsResponse>) {
  const api: WorldlineBoxCompanionsApi = {
    async request(input) { return input.type === 'state' ? { ok: true, state } : input.type === 'messages' ? readMessages() : input.type === 'actions' ? { ok: true, actions: [] } : { ok: true }; },
    onChanged() { return () => undefined; }, onReplyStream() { return () => undefined; },
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<Companions api={api} onOpenSettings={() => undefined} />));
}
const button = (label: string) => host!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

it('shows message loading before the first snapshot and only shows the welcome for a confirmed empty page', async () => {
  const read = deferred<CompanionsResponse>(); await mount(() => read.promise);
  expect(host!.querySelector('.companions-message-loading[role="status"]')?.textContent).toBe('正在读取聊天记录…');
  expect(host!.querySelector('.companions-loading-spinner')).not.toBeNull();
  expect(host!.querySelector('.companions-chat-welcome')).toBeNull();
  expect(host!.querySelector('.companions-composer .companion-model-usage')).toBeNull();
  await act(() => read.resolve({ ok: true, messages: [], hasMore: false }));
  expect(host!.querySelector('.companions-message-loading')).toBeNull();
  expect(host!.querySelector('.companions-chat-welcome')).not.toBeNull();
});

it('keeps a failed initial read distinct from an empty history and can retry without clearing the conversation', async () => {
  const first = deferred<CompanionsResponse>(), retry = deferred<CompanionsResponse>(); let reads = 0;
  await mount(() => ++reads === 1 ? first.promise : retry.promise);
  await act(() => first.resolve({ ok: false, error: '读取失败' }));
  expect(host!.querySelector('.companions-message-load-failed')?.textContent).toContain('聊天记录暂时未能读取');
  expect(host!.querySelector('.companions-chat-welcome')).toBeNull();
  await act(() => host!.querySelector<HTMLButtonElement>('.companions-message-load-failed button')!.click());
  expect(host!.querySelector('.companions-message-loading')).not.toBeNull();
  await act(() => retry.resolve({ ok: true, messages: [], hasMore: false }));
  expect(host!.querySelector('.companions-message-load-failed')).toBeNull();
  expect(host!.querySelector('.companions-chat-welcome')).not.toBeNull();
});

it('dismisses more actions on an outside press or Escape while preserving inside presses and IME composition', async () => {
  await mount(async () => ({ ok: true, messages: [], hasMore: false }));
  await act(() => button('更多聊天操作').click());
  const menu = () => host!.querySelector('[aria-label="更多聊天操作菜单"]');
  expect(menu()).not.toBeNull();
  await act(() => menu()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  expect(menu()).not.toBeNull();
  await act(() => host!.querySelector('textarea')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  expect(menu()).toBeNull(); expect(button('更多聊天操作').getAttribute('aria-expanded')).toBe('false');
  await act(() => button('更多聊天操作').click());
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true })));
  expect(menu()).not.toBeNull();
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(button('更多聊天操作'));
  await act(() => button('更多聊天操作').click());
  await act(() => button('更多聊天操作').click()); expect(menu()).toBeNull();
});

it('places separate context records below their own replies and keeps the composer free of usage counters', async () => {
  const reply = (id: string, sequence: number, inputTokens: number): CompanionMessage => ({ id, sequence, conversationId: room.id, authorId: companion.id, kind: 'text', content: `回复 ${id}`, createdAt: at, status: 'sent', attachments: [],
    modelUsage: { revision: 1, current: { attemptId: id, model: 'actual-model', providerFormat: 'openai', phase: 'finished', updatedAt: at, estimate: { inputTokens, method: 'utf8_bytes_div_3', hasUnmeteredImages: false, breakdown: { system: inputTokens, dialogue: 0, toolDefinitions: 0, toolHistory: 0, other: 0 } }, actual: { inputTokens } }, totals: { inputTokens, requests: 1, reportedRequests: 1, complete: false } } });
  await mount(async () => ({ ok: true, messages: [reply('one', 1, 1200), reply('two', 2, 2400)], hasMore: false }));
  expect(host!.querySelector('[data-companion-message="one"] [data-message-model-usage="one"]')?.textContent).toContain('上下文 1.2K');
  expect(host!.querySelector('[data-companion-message="two"] [data-message-model-usage="two"]')?.textContent).toContain('上下文 2.4K');
  expect(host!.querySelector('.companions-composer .companion-model-usage')).toBeNull();
});
