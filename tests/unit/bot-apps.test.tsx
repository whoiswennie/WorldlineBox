// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotApps } from '../../src/renderer/companion-bot/BotApps';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
async function render(onAssets: () => Promise<void>, onBrowser = vi.fn(async () => undefined)) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<BotApps locale="zh-CN" browserAvailable assetAttached={false} onAssets={onAssets} onBrowser={onBrowser} />));
}
it('uses a single Apps entry and only activates the explicitly chosen app', async () => {
  const assets = vi.fn(async () => undefined), browser = vi.fn(async () => undefined); await render(assets, browser);
  expect(host.querySelector('[aria-label="应用"]')?.textContent).toContain('应用'); expect(assets).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="应用"]')!.click());
  const choices = host.querySelectorAll<HTMLButtonElement>('.bot-app-choice'); expect(choices).toHaveLength(2);
  await act(() => choices[1]!.click()); expect(assets).toHaveBeenCalledOnce(); expect(browser).not.toHaveBeenCalled(); expect(host.querySelector('[role="dialog"]')).toBeNull();
});
it('keeps connection errors in the app picker and allows another attempt', async () => {
  await render(async () => { throw Error('服务端口被占用，请更换端口。'); });
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="应用"]')!.click());
  await act(() => host.querySelectorAll<HTMLButtonElement>('.bot-app-choice')[1]!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('端口被占用'); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});
