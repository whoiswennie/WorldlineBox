// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotComposer } from '../../src/renderer/companion-bot/BotComposer';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
const sendSticker = vi.fn(async () => undefined);
const sticker: BotMediaRef = { id: 'real-ref', name: '辉夜 好耶', mimeType: 'image/webp', size: 100, url: 'worldlinebox://bot-media/public/ref', kind: 'sticker' };
beforeEach(() => { localStorage.clear(); sendSticker.mockClear(); });
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; localStorage.clear(); });
async function mount(mediaApi?: WorldlineBoxBotMediaApi) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  function Harness() {
    const [draft, setDraft] = useState('前后');
    return <BotComposer locale="zh-CN" draft={draft} setDraft={setDraft} disabled={false} busy={false} group={false} world={false} panel={null} setPanel={() => undefined}
      send={async () => undefined} mediaApi={mediaApi} conversationId="own-chat" addFiles={async () => undefined} removeFile={() => undefined} sendSticker={sendSticker} />;
  }
  await act(async () => root!.render(<Harness />));
}
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}

it('inserts emoji at the caret without a media service and restores focus on selection or Escape', async () => {
  await mount();
  const input = host.querySelector('textarea')!; input.setSelectionRange(1, 1);
  await click('表情'); expect(host.querySelector('.bot-expression-emoji-grid')).not.toBeNull();
  expect(host.querySelector('[aria-label="导入表情包"]')).toBeNull();
  await click('🐳'); await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(input.value).toBe('前🐳后'); expect(input.selectionStart).toBe(3); expect(document.activeElement).toBe(input);
  expect(host.querySelector('.bot-expression-picker')).toBeNull();
  await click('表情');
  // Recent and category copies of the same emoji are intentionally both valid choices.
  expect(host.querySelectorAll('button[aria-label="🐳"]')).toHaveLength(2);
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('.bot-expression-picker')).toBeNull(); expect(document.activeElement).toBe(input);
});

it('retains the emoji tab after asynchronous pack loading and switches four actual pack selectors without touching the draft', async () => {
  const calls: unknown[] = [];
  await mount({ getDroppedFilePaths: () => [], async request(request) {
    calls.push(request);
    return request.type === 'packs.list' ? { ok: true, packs: ['甲', '乙', '丙', '丁'].map((name, index) => ({ id: 'pack-'+index, name, builtin: true, count: 1 })) }
      : { ok: true, media: [sticker] };
  } });
  expect(host.querySelectorAll('.bot-expression-tools>button')).toHaveLength(1);
  expect(host.querySelector('.bot-expression-tools>button[aria-label="表情包"]')).toBeNull();
  await click('表情');
  expect(host.querySelector('.bot-expression-emoji-grid')).not.toBeNull();
  expect(host.querySelectorAll('nav[aria-label="表情包分类"] button')).toHaveLength(4);
  await click('乙'); expect(calls).toContainEqual({ type: 'stickers.list', conversationId: 'own-chat', packId: 'pack-1' });
  expect(host.querySelector('.bot-expression-emoji-grid')).toBeNull();
  await click(sticker.name); expect(sendSticker).toHaveBeenCalledWith(sticker);
  expect(host.querySelector('textarea')?.value).toBe('前后'); expect(host.querySelector('.bot-expression-picker')).toBeNull();
  await click('表情');
  expect(host.querySelector('[role="tab"][aria-label="表情包"]')?.getAttribute('aria-selected')).toBe('true');
});

it('opens sticker search only on request and restores the full pack when collapsed', async () => {
  await mount({ getDroppedFilePaths: () => [], async request(request) {
    return request.type === 'packs.list' ? { ok: true, packs: [{ id: 'kaguya', name: '辉夜', builtin: true, count: 2 }] }
      : { ok: true, media: [sticker, { ...sticker, id: 'other-ref', name: '辉夜 晚安' }] };
  } });
  await click('表情'); await click('表情包');
  expect(host.querySelector('input[aria-label="搜索表情"]')).toBeNull();
  expect(host.querySelectorAll('.bot-sticker-grid button')).toHaveLength(2);
  await click('搜索表情包');
  const query = host.querySelector<HTMLInputElement>('input[aria-label="搜索表情"]')!;
  expect(query).not.toBeNull(); expect(document.activeElement).toBe(query);
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, '好耶'); query.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(host.querySelectorAll('.bot-sticker-grid button')).toHaveLength(1);
  expect(host.querySelector('.bot-sticker-grid button')?.getAttribute('aria-label')).toBe(sticker.name);
  await click('收起搜索');
  expect(host.querySelector('input[aria-label="搜索表情"]')).toBeNull();
  expect(host.querySelectorAll('.bot-sticker-grid button')).toHaveLength(2);
  await click('搜索表情包');
  expect(host.querySelector<HTMLInputElement>('input[aria-label="搜索表情"]')?.value).toBe('');
  expect(host.querySelectorAll('.bot-sticker-grid button')).toHaveLength(2);
});

it('keeps original-file meaning visible and searchable even when the display name differs', async () => {
  const original: BotMediaRef = { ...sticker, name: '归一化显示名', originalName: '开心到飞起来_原图.GIF', description: '适合分享好消息', tags: ['庆祝'] };
  await mount({ getDroppedFilePaths: () => [], async request(request) {
    return request.type === 'packs.list' ? { ok: true, packs: [{ id: 'kaguya', name: '辉夜', builtin: true, count: 2 }] }
      : { ok: true, media: [original, { ...sticker, id: 'other-ref', name: '辉夜 晚安' }] };
  } });
  await click('表情'); await click('表情包');
  const item = host.querySelector<HTMLButtonElement>(`.bot-sticker-grid button[aria-label="${original.name}"]`)!;
  expect(item.querySelector('.bot-sticker-caption')?.textContent).toBe('开心到飞起来_原图');
  expect(item.title).toBe('开心到飞起来_原图.GIF\n适合分享好消息');
  await click('搜索表情包');
  const query = host.querySelector<HTMLInputElement>('input[aria-label="搜索表情"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(query, '开心到飞起来_原图.GIF'); query.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(host.querySelectorAll('.bot-sticker-grid button')).toHaveLength(1);
  expect(host.querySelector('.bot-sticker-grid button')?.getAttribute('aria-label')).toBe(original.name);
  await click(original.name); expect(sendSticker).toHaveBeenCalledWith(original);
});
