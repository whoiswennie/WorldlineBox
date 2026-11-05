// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotCallCaption } from '../../src/renderer/companion-bot/BotCallCaption';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); });
const text = '第一段，今天天气很好，我们慢慢说。'.repeat(30);
async function fixture(revealedText = '') {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const full = vi.fn();
  const render = async (prefix: string, speaking = true, waiting?: string) => { await act(() => root!.render(<BotCallCaption text={text} revealedText={prefix} waiting={waiting} speaking={speaking} locale="zh-CN" onOpenFull={full} />)); };
  await render(revealedText); return { render, full };
}
const displayed = () => host.querySelector('.bot-call-caption-text')!.textContent!;
async function click(label: string) { const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; expect(button).not.toBeNull(); await act(() => button.click()); }
it('keeps only a short spoken page visible and retains the last page after playback completes', async () => {
  const f = await fixture(text.slice(0, 180)); expect(displayed().length).toBeLessThan(90); expect(displayed()).not.toBe(text.slice(0, 180));
  await f.render(text, false); expect(displayed().length).toBeLessThan(90); expect(text.endsWith(displayed())).toBe(true);
  expect(host.textContent).toContain('查看完整回复'); await act(() => [...host.querySelectorAll('button')].find(button => button.textContent === '查看完整回复')!.click()); expect(f.full).toHaveBeenCalledOnce();
});
it('keeps a manually selected earlier page while speech advances, with an explicit follow control', async () => {
  const f = await fixture(text.slice(0, 250)); await click('上一段回应'); const prior = displayed();
  await f.render(text.slice(0, 400)); expect(displayed()).toBe(prior);
  await act(() => [...host.querySelectorAll('button')].find(button => button.textContent === '跟随语音')!.click()); expect(displayed()).not.toBe(prior);
});
it('shows a quiet waiting status instead of complete generated text before audio starts', async () => {
  const f = await fixture(); await f.render('', false, '正在准备语音…');
  expect(displayed()).toBe('正在准备语音…'); expect(host.querySelector('nav')).toBeNull(); expect(displayed()).not.toContain('第一段');
});
