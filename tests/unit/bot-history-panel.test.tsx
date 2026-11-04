// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotHistoryDialog, BotHistoryPanel } from '../../src/renderer/companion-bot/BotHistoryPanel';
import type { BotMessage, BotRequest, BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
let requests: BotRequest[], execute: (request: BotRequest) => Promise<BotResponse>;
const locate = vi.fn();
const message = (conversationId: string, sequence: number, content = `原文 ${sequence}`): BotMessage => ({ id: `${conversationId}-${sequence}`, eventId: `event-${conversationId}-${sequence}`,
  conversationId, sequence, content, senderId: 'alice', senderName: 'Alice', status: sequence % 4 ? 'sent' : 'failed', createdAt: '2026-11-02T08:10:00Z' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const api: WorldlineBoxBotApi = { async request(request) { requests.push(request); return execute(request); }, onEvent: () => () => undefined };
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); requests = []; locate.mockReset(); execute = async () => ({ ok: true, history: { items: [], hasMore: false } }); });
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
async function render(conversationId = 'a') {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(() => root!.render(<BotHistoryPanel api={api} conversationId={conversationId} locale="zh-CN" onLocate={locate} />));
}
async function advance(ms = 300) { await act(() => vi.advanceTimersByTime(ms)); }
async function input(value: string) {
  const field = host.querySelector('input')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  expect(button).toBeDefined(); await act(() => button.click());
}

it('isolates late responses across conversation switches and search generations after 300ms debounce', async () => {
  const oldConversation = deferred<BotResponse>(), oldQuery = deferred<BotResponse>();
  execute = async request => {
    if (request.type !== 'history.search') throw Error('Unexpected history transport');
    if (request.conversationId === 'a') return oldConversation.promise;
    if (request.query === '旧词') return oldQuery.promise;
    return { ok: true, history: { items: [message('b', 20, request.query ? '新查询命中' : '乙的原文')], hasMore: false } };
  };
  await render('a'); await advance(); expect(requests).toHaveLength(1);
  await render('b'); await advance(); expect(host.textContent).toContain('乙的原文');
  await act(() => oldConversation.resolve({ ok: true, history: { items: [message('a', 10, '甲迟到内容')], hasMore: false } }));
  expect(host.textContent).not.toContain('甲迟到内容');
  await input('旧词'); await advance();
  await input('新词'); await advance(299);
  expect(requests.filter(request => request.type === 'history.search' && request.query === '新词')).toHaveLength(0);
  await advance(1); expect(host.textContent).toContain('新查询命中');
  await act(() => oldQuery.resolve({ ok: true, history: { items: [message('b', 11, '旧查询迟到内容')], hasMore: false } }));
  expect(host.textContent).not.toContain('旧查询迟到内容'); expect(host.querySelector('input')?.value).toBe('新词');
});

it('continues older pages in a bounded 400-record window and locates the exact untruncated original', async () => {
  const text = '完整原文 '.repeat(100), target = message('a', 400, text);
  execute = async request => {
    if (request.type !== 'history.search') throw Error('Unexpected transport');
    const end = request.before ? request.before - 1 : 560, start = Math.max(1, end - 79);
    return { ok: true, history: { items: Array.from({ length: end - start + 1 }, (_unused, index) => end - index === 400 ? target : message('a', end - index)),
      hasMore: start > 1, nextBefore: start > 1 ? start : undefined } };
  };
  await render(); await advance();
  for (let page = 0; page < 6; page++) {
    await click('加载更早记录'); expect(host.querySelectorAll('.bot-history-record').length).toBeLessThanOrEqual(400);
  }
  expect(host.querySelectorAll('.bot-history-record')).toHaveLength(400);
  expect(host.querySelector('.bot-history-range')).toBeNull();
  expect(host.textContent).not.toContain('原文 560'); expect(host.textContent).toContain('原文 1');
  expect(requests.map(request => request.type === 'history.search' ? request.before : undefined)).toEqual([undefined, 481, 401, 321, 241, 161, 81]);
  const first = host.querySelector<HTMLButtonElement>('.bot-history-locate')!;
  expect(first.textContent).toContain('Alice'); expect(first.textContent).toContain('…');
  await act(() => first.click()); expect(locate).toHaveBeenCalledWith(target); expect(locate.mock.calls[0]![0].content).toBe(text);
});

it('keeps real filter requests separate, groups dates and hides empty reply placeholders', async () => {
  const old = deferred<BotResponse>();
  execute = async request => {
    if (request.type !== 'history.search') throw Error('Unexpected transport');
    if (request.filter === 'files') return old.promise;
    return { ok: true, history: { items: [message('a', 20, ''), message('a', 19, '今天聊过的话'),
      { ...message('a', 18, '昨天聊过的话'), createdAt: '2026-11-01T08:10:00Z' }], hasMore: false } };
  };
  await render(); await advance();
  expect(host.querySelectorAll('.bot-history-record')).toHaveLength(2);
  expect(host.querySelectorAll('.bot-history-date')).toHaveLength(2);
  expect(host.textContent).not.toContain('排队中'); expect(host.textContent).not.toContain('400');
  await click('文件'); await advance();
  expect(requests.at(-1)).toMatchObject({ filter: 'files', query: '' });
  await click('表情'); await advance();
  await act(() => old.resolve({ ok: true, history: { items: [message('a', 17, '过期分类结果')], hasMore: false } }));
  expect(host.textContent).not.toContain('过期分类结果');
  expect(requests.at(-1)).toMatchObject({ filter: 'stickers' });
});

it('opens a labelled dialog, focuses search and closes on Escape without exposing runtime controls', async () => {
  const close = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotHistoryDialog api={api} conversationId="a" title="大肥鱼" locale="zh-CN" onLocate={locate} onClose={close} />));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-label')).toBe('聊天记录'); expect(dialog.textContent).toContain('大肥鱼');
  expect(document.activeElement).toBe(host.querySelector('input'));
  await act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(close).toHaveBeenCalledOnce(); expect(dialog.textContent).not.toContain('运行信息');
});

it('keeps an earlier page and its retry cursor after failure and rejects malformed cross-chat results', async () => {
  let attempts = 0;
  execute = async request => {
    if (request.type !== 'history.search') throw Error('Unexpected transport');
    if (!request.before) return { ok: true, history: { items: [message('a', 90)], hasMore: true, nextBefore: 90 } };
    if (++attempts === 1) return { ok: false, error: '磁盘暂时不可读' };
    return { ok: true, history: { items: [message('a', 50)], hasMore: false } };
  };
  await render(); await advance(); await click('加载更早记录');
  expect(host.textContent).toContain('磁盘暂时不可读'); expect(host.textContent).toContain('原文 90');
  await click('重试'); expect(host.querySelectorAll('.bot-history-record')).toHaveLength(2);
  expect(requests.slice(-2)).toEqual([expect.objectContaining({ before: 90 }), expect.objectContaining({ before: 90 })]);
  execute = async () => ({ ok: true, history: { items: [message('a', 100, '跨域不应显示')], hasMore: false } });
  await render('b'); await advance(); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.textContent).not.toContain('跨域不应显示');
});
