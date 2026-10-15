// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionSocialMonitor } from '../../src/renderer/companions/CompanionSocialMonitor';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionSocialConversation, CompanionSocialMessage } from '../../src/shared/companion-social';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });
const at = '2026-10-15T01:00:00.000Z', virtual = '2098-04-10T10:00:00.000Z';
const companions: Companion[] = BUILTIN_COMPANIONS.slice(0, 2).map(item => ({ ...item, builtin: true, createdAt: at }));
const [one, two] = companions as [Companion, Companion];
function row(sequence: number, authorId: string, content: string, conversationId = 'pair'): CompanionSocialMessage {
  return { message: { id: 'message_' + sequence, sequence, conversationId, authorId, kind: 'text', content, status: 'sent', createdAt: at, attachments: [] }, virtualCreatedAt: virtual, recipientIds: [authorId === one.id ? two.id : one.id] };
}
const latest = [row(51, one.id, '**今天的海风**很舒服，要一起去散步吗？'), row(52, two.id, '姐姐，等我把书放好就来。')];
const conversation: CompanionSocialConversation = { id: 'pair', kind: 'private', title: '海边的小日常', memberIds: [one.id, two.id], updatedAt: at, messageCount: 52, lastMessage: latest[1] };
const context = { timeZone: 'Asia/Shanghai', observedDay: '2098-04-10', virtualNow: virtual, backlog: false };
function fixture() { return vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
  if (input.type === 'social.days') return { ok: true, socialDays: { ...context, days: [{ day: '2098-04-10', messageCount: 52, conversationCount: 1 }] } };
  if (input.type === 'social.conversations') return { ok: true, socialConversationPage: { ...context, items: [conversation], total: 21, hasMore: true, nextCursor: { updatedAt: at, id: conversation.id } } };
  if (input.type === 'social.messages') return { ok: true, socialMessagePage: { ...context, items: input.before ? [row(1, one.id, '这是很早以前的第一句。'), row(2, two.id, '早期记录已经保存。')] : latest, total: 52, hasMore: !input.before, ...(!input.before ? { nextCursor: { sequence: 51 } } : {}) } };
  return { ok: true };
}); }
async function mount(request = fixture(), onClose = vi.fn()) {
  vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CompanionSocialMonitor companions={companions} request={request} onClose={onClose} onOpenUrl={vi.fn()} />));
  await act(async () => vi.advanceTimersByTimeAsync(300)); return { request, onClose };
}
async function click(label: string) { const button = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label)!; await act(async () => button.click()); }
async function fill(label: string, value: string) { const input = container!.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); await vi.advanceTimersByTimeAsync(300); }); }

it('opens the actual virtual day and reuses chat bubbles with two real companion subjects, recipients and observer perspective', async () => {
  const { request } = await mount();
  expect(request).toHaveBeenCalledWith({ type: 'social.conversations', day: '2098-04-10', limit: 20 });
  expect(container!.textContent).toContain('52 条交流 · 1 个会话');
  expect(container!.querySelectorAll('[data-social-message]')).toHaveLength(2);
  expect(container!.querySelector('.companions-message-bubble strong')!.textContent).toBe('今天的海风');
  expect(container!.querySelector('[data-social-message="message_51"]')!.textContent).toContain('对 ' + two.name + ' 说');
  expect(container!.querySelector('[data-social-message="message_51"]')!.classList.contains('is-own')).toBe(true);
  const view = container!.querySelector<HTMLSelectElement>('[aria-label="社交聊天观察视角"]')!;
  await act(async () => { view.value = two.id; view.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container!.querySelector('[data-social-message="message_52"]')!.classList.contains('is-own')).toBe(true);
  expect(container!.querySelector('[data-social-message="message_51"]')!.classList.contains('is-own')).toBe(false);
  expect(container!.querySelectorAll('textarea, [contenteditable="true"]')).toHaveLength(0);
  expect(request.mock.calls.every(([input]) => input.type.startsWith('social.'))).toBe(true);
});

it('paginates durable messages and conversations and scopes date, owner and search without creating conversations', async () => {
  const { request } = await mount();
  await click('更早的消息');
  expect(request).toHaveBeenCalledWith({ type: 'social.messages', conversationId: 'pair', day: '2098-04-10', before: { sequence: 51 }, limit: 50 });
  expect(container!.querySelector('[aria-label="伙伴对话记录"]')!.textContent).toContain('很早以前的第一句');
  await click('较新的消息'); expect(container!.querySelector('[aria-label="伙伴对话记录"]')!.textContent).toContain('海风');
  await click('下一页'); expect(request).toHaveBeenCalledWith({ type: 'social.conversations', day: '2098-04-10', before: { updatedAt: at, id: 'pair' }, limit: 20 });
  await click('所有日期'); expect(request).toHaveBeenCalledWith({ type: 'social.conversations', limit: 20 });
  await click('今天'); expect(container!.querySelector<HTMLInputElement>('[aria-label="社交记录日期"]')!.value).toBe('2098-04-10');
  await click('今天'); expect(container!.querySelectorAll('[data-social-conversation]')).toHaveLength(1);
  const select = container!.querySelector<HTMLSelectElement>('[aria-label="筛选社交伙伴"]')!;
  await act(async () => { select.value = two.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await fill('搜索伙伴社交记录', '海风');
  expect(request).toHaveBeenCalledWith({ type: 'social.conversations', companionId: two.id, day: '2098-04-10', query: '海风', limit: 20 });
  await fill('在伙伴对话中查找', '姐姐');
  expect(request).toHaveBeenCalledWith({ type: 'social.messages', conversationId: 'pair', day: '2098-04-10', query: '姐姐', limit: 50 });
});

it('shows recoverable read errors and closes observation without affecting any peer conversation', async () => {
  const request = vi.fn(async (): Promise<CompanionsResponse> => ({ ok: false, error: '暂时读不到社交记录' }));
  const closed = vi.fn(); await mount(request, closed);
  expect(container!.querySelector('[role="alert"]')!.textContent).toContain('暂时读不到');
  await click('重试'); expect(request).toHaveBeenCalledTimes(2);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(closed).toHaveBeenCalledOnce();
});

it('preserves a scrolled reading window when a new peer message arrives until the observer asks for latest', async () => {
  const base = fixture(); let extra = false, changed: (() => void) | undefined;
  const request = vi.fn(async (input: CompanionsRequest) => {
    const result = await base(input);
    return input.type === 'social.messages' && extra && result.socialMessagePage ? { ...result, socialMessagePage: { ...result.socialMessagePage, items: [...latest, row(53, one.id, '刚到达的新消息')], total: 53 } } : result;
  });
  await mount(request);
  const api: WorldlineBoxCompanionsApi = { request, onChanged: listener => { changed = listener; return () => { changed = undefined; }; }, onReplyStream: () => () => undefined };
  await act(async () => root!.render(<CompanionSocialMonitor companions={companions} request={request} api={api} onClose={vi.fn()} onOpenUrl={vi.fn()} />));
  const list = container!.querySelector<HTMLElement>('[aria-label="伙伴对话记录"]')!;
  Object.defineProperties(list, { scrollHeight: { value: 1200, configurable: true }, clientHeight: { value: 300, configurable: true } });
  list.scrollTop = 100; await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  extra = true; await act(async () => { changed!(); await vi.advanceTimersByTimeAsync(450); });
  expect(list.textContent).not.toContain('刚到达的新消息');
  expect(container!.textContent).toContain('有新消息，回到最新记录');
  expect(list.scrollTop).toBe(100);
  await click('有新消息，回到最新记录');
  expect(list.textContent).toContain('刚到达的新消息');
});

it('shows actual face-to-face and phone channels on the reused private chat, without inventing a historical channel', async () => {
  const base = fixture();
  const request = vi.fn(async (input: CompanionsRequest) => {
    const result = await base(input);
    return input.type === 'social.messages' && !input.before && result.socialMessagePage ? { ...result, socialMessagePage: { ...result.socialMessagePage,
      items: [{ ...latest[0]!, channel: 'phone' as const }, { ...latest[1]!, channel: 'face_to_face' as const }, row(53, one.id, '这条旧记录没有交流方式。')] } } : result;
  });
  await mount(request);
  expect(container!.querySelector('[data-social-message="message_51"] [data-social-channel="phone"]')!.textContent).toBe('手机消息');
  expect(container!.querySelector('[data-social-message="message_52"] [data-social-channel="face_to_face"]')!.textContent).toBe('当面交流');
  const historical = container!.querySelector('[data-social-message="message_53"]')!;
  expect(historical.querySelector('[data-social-channel="unknown"]')!.textContent).toBe('方式未记录'); expect(historical.querySelector('[data-social-channel="phone"]')).toBeNull();
  expect(container!.querySelector('.companions-message-bubble strong')!.textContent).toBe('今天的海风');
  await click('更早的消息');
  expect(container!.querySelectorAll('[data-social-channel="unknown"]')).toHaveLength(2);
});
