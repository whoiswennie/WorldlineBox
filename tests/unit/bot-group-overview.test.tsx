// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotGroupOverview } from '../../src/renderer/companion-bot/BotGroupOverview';
import type { BotRequest, BotResponse } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const at = '2026-11-04T03:55:00.000Z';
const props = (): ComponentProps<typeof BotGroupOverview> => {
  const companions = Array.from({ length: 14 }, (_, index) => ({ id: `person-${index}`, name: `伙伴 ${index}`, persona: '', createdAt: at }));
  return { conversation: { id: 'group', kind: 'group', title: '一起做世界线', ownerId: 'user', memberIds: ['user', ...companions.map(person => person.id)], createdAt: at }, companions, locale: 'zh-CN', request: vi.fn(async () => ({ ok: true })), onChanged: vi.fn(), onMembers: vi.fn(), onContact: vi.fn() };
};
async function mount(value: ComponentProps<typeof BotGroupOverview>) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(() => root!.render(<BotGroupOverview {...value} />)); }
async function click(name: string) { await act(() => { const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name); expect(button).toBeDefined(); button!.click(); }); }
async function input(field: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(() => { const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('keeps fourteen-partner groups readable with seven rows, searchable full membership and real contact/management actions', async () => {
  const value = props(); await mount(value);
  expect(host.querySelectorAll('li')).toHaveLength(7); expect(host.textContent).toContain('群成员 15'); expect(host.textContent).toContain('群主');
  await click('下一页群成员'); expect(host.querySelectorAll('li')).toHaveLength(7); expect(host.textContent).toContain('伙伴 12');
  await input(host.querySelector<HTMLInputElement>('input[type="search"]')!, '伙伴 13');
  expect(host.querySelectorAll('li')).toHaveLength(1); expect(host.querySelector('.bot-group-members-pages')?.textContent).toContain('1 / 1');
  expect([...host.querySelectorAll<HTMLButtonElement>('.bot-group-members-pages button')].every(button => button.disabled)).toBe(true);
  await act(() => host.querySelector<HTMLButtonElement>('li button')!.click()); expect(value.onContact).toHaveBeenCalledWith('person-13');
  await click('管理↗'); expect(value.onMembers).toHaveBeenCalledOnce();
});

it('saves and clears with the visible announcement version, keeping a real conflict local without losing the draft', async () => {
  const value = props(), calls: BotRequest[] = [];
  value.conversation.announcement = { text: '原公告', updatedAt: at };
  value.request = vi.fn(async input => { calls.push(input); return { ok: false, error: '公告已更新，请重新读取后再保存。' }; });
  await mount(value); await click('编辑群公告'); await input(host.querySelector('textarea')!, '周末一起整理资料。');
  await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(calls).toEqual([{ type: 'conversation.announcement', conversationId: 'group', content: '周末一起整理资料。', expectedUpdatedAt: at }]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('公告已更新'); expect(host.querySelector('textarea')?.value).toBe('周末一起整理资料。'); expect(value.onChanged).not.toHaveBeenCalled();
  value.request = vi.fn(async input => { calls.push(input); return { ok: true }; }); await act(() => root!.render(<BotGroupOverview {...value} />));
  await input(host.querySelector('textarea')!, ''); await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(calls.at(-1)).toMatchObject({ type: 'conversation.announcement', content: '', expectedUpdatedAt: at }); expect(value.onChanged).toHaveBeenCalledOnce(); expect(host.querySelector('form')).toBeNull();
});

it('renders announcement text as data and hides edits for a dissolved or non-owner group', async () => {
  const value = props(); value.conversation = { ...value.conversation, ownerId: undefined, announcement: { text: '<img src=x onerror=alert(1)>\n群内规则', updatedAt: at } };
  await mount(value); expect(host.querySelector('.bot-group-notice-text')?.textContent).toContain('<img src=x'); expect(host.querySelector('.bot-group-announcement img')).toBeNull(); expect(host.querySelector('[aria-label="编辑群公告"]')).toBeNull();
});

it('does not refresh a newly selected room when the old announcement request resolves after unmount', async () => {
  const value = props(); let resolve!: (value: BotResponse) => void; value.request = () => new Promise(done => { resolve = done; });
  await mount(value); await click('编辑群公告'); await input(host.querySelector('textarea')!, '稍后保存');
  await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await act(() => root!.unmount()); root = undefined; await act(() => resolve({ ok: true })); expect(value.onChanged).not.toHaveBeenCalled();
});

it('opens all 4000 announcement characters as inert plain text without changing the selected member page', async () => {
  const value = props(), full = ('<img src=x onerror=alert(1)>\n# 这不是 Markdown\n' + '保留全部原文。'.repeat(800)).slice(0, 3996) + '全文尾部';
  value.conversation.announcement = { text: full, updatedAt: at };
  await mount(value); await click('下一页群成员');
  const rows = [...host.querySelectorAll('li')].map(item => item.textContent), page = host.querySelector('.bot-group-members-pages')!.textContent;
  const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '查看全文')!;
  trigger.focus(); await click('查看全文');
  const reader = document.querySelector<HTMLElement>('[role="dialog"]')!, content = reader.querySelector<HTMLElement>('.bot-group-announcement-reader-content')!;
  expect(host.contains(reader)).toBe(false); expect(reader.getAttribute('aria-modal')).toBe('true');
  expect(content.textContent).toBe(full); expect(content.textContent).toHaveLength(4000); expect(content.textContent?.endsWith('全文尾部')).toBe(true);
  expect(reader.querySelector('img,script,iframe,a,h1')).toBeNull(); expect(host.querySelector('.is-expanded')).toBeNull();
  content.focus(); const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); await act(() => content.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect([...host.querySelectorAll('li')].map(item => item.textContent)).toEqual(rows); expect(host.querySelector('.bot-group-members-pages')!.textContent).toBe(page);
  expect(value.request).not.toHaveBeenCalled(); expect(value.onChanged).not.toHaveBeenCalled();
});

it('traps reader keyboard focus and restores a filtered member list when closed with its button', async () => {
  const value = props(); value.conversation.announcement = { text: '需要独立阅读的公告。'.repeat(30), updatedAt: at };
  await mount(value); await input(host.querySelector('input[type="search"]')!, '伙伴 13');
  const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '查看全文')!;
  trigger.focus(); await click('查看全文');
  const reader = document.querySelector<HTMLElement>('[role="dialog"]')!, close = reader.querySelector<HTMLButtonElement>('button')!, content = reader.querySelector<HTMLElement>('[tabindex="0"]')!;
  expect(document.activeElement).toBe(close);
  const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }); await act(() => close.dispatchEvent(back));
  expect(back.defaultPrevented).toBe(true); expect(document.activeElement).toBe(content);
  const next = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); await act(() => content.dispatchEvent(next));
  expect(next.defaultPrevented).toBe(true); expect(document.activeElement).toBe(close);
  await act(() => close.click()); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect(host.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('伙伴 13'); expect(host.querySelectorAll('li')).toHaveLength(1);
  expect(host.querySelector('.bot-group-members-pages')!.textContent).toContain('1 / 1');
});

it('keeps a short notice directly readable without a redundant full-text control', async () => {
  const value = props(); value.conversation.announcement = { text: '周六下午两点见。', updatedAt: at };
  await mount(value); expect(host.querySelector('.bot-group-notice-text')!.textContent).toBe('周六下午两点见。');
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '查看全文')).toBe(false);
});
