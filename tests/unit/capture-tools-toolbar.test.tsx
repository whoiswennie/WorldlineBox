// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CaptureToolsToolbar } from '../../src/renderer/CaptureToolsToolbar';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { CaptureToolsResponse } from '../../src/shared/capture-tools';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); });
async function mount(nativeMenu?: { request: ReturnType<typeof vi.fn<() => Promise<CaptureToolsResponse>>> }, onOpen = vi.fn(), onError = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><CaptureToolsToolbar nativeMenu={nativeMenu} onOpen={onOpen} onError={onError} /></LocaleProvider>));
  return { onOpen, onError, trigger: host.querySelector<HTMLButtonElement>('.application-capture-more')! };
}
it('never mounts a DOM overlay above a native browser, opens a single popup, and dispatches only its selected task', async () => {
  let finish!: (result: CaptureToolsResponse) => void;
  const request = vi.fn(() => new Promise<CaptureToolsResponse>(resolve => { finish = resolve; })), { trigger, onOpen } = await mount({ request });
  await act(() => trigger.click()); await act(() => trigger.click()); expect(request).toHaveBeenCalledOnce();
  expect(trigger.getAttribute('aria-expanded')).toBe('true'); expect(document.querySelector('[role=menu]')).toBeNull(); expect(onOpen).not.toHaveBeenCalled();
  await act(() => finish({ ok: true, menuTask: 'selection' })); expect(onOpen).toHaveBeenCalledExactlyOnceWith('selection'); expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
it('cancels and reports native failures without starting a capture', async () => {
  const request = vi.fn<() => Promise<CaptureToolsResponse>>(async () => ({ ok: true })), { trigger, onOpen, onError } = await mount({ request });
  await act(() => trigger.click()); expect(onOpen).not.toHaveBeenCalled();
  request.mockResolvedValueOnce({ ok: false, error: '工具列表暂时不可用' }); await act(() => trigger.click()); expect(onError).toHaveBeenCalledWith('工具列表暂时不可用'); expect(onOpen).not.toHaveBeenCalled();
});
it('keeps the regular overlay and keyboard navigation in non-native views', async () => {
  const { trigger } = await mount(); await act(() => trigger.click());
  const menu = document.querySelector<HTMLElement>('.application-capture-menu')!; expect(menu.querySelectorAll('[role=menuitem]')).toHaveLength(6);
  await act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))); expect(document.activeElement?.textContent).toBe('划词助手');
  await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(document.querySelector('[role=menu]')).toBeNull();
});
