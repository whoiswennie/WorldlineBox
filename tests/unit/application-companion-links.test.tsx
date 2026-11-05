// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../src/renderer/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('../../src/renderer/theme/AnimatedBackground', () => ({ ThemeBackground: () => null }));
vi.mock('../../src/renderer/hover-tip', () => ({ HoverTipHost: () => null }));
vi.mock('../../src/renderer/edit-text-context-menu', () => ({ EditTextContextMenuHost: () => null }));
vi.mock('../../src/renderer/WindowsWindowControls', () => ({ WindowsWindowControls: () => null }));
vi.mock('../../src/renderer/WindowEdgeResizeHandles', () => ({ WindowEdgeResizeHandles: () => null }));
vi.mock('../../src/renderer/launcher/DshLauncher', () => ({ DshLauncher: () => <div /> }));
vi.mock('../../src/renderer/browser/BrowserPage', () => ({ BrowserPage: () => <div data-native-browser /> }));
vi.mock('../../src/renderer/companion-bot/BotWorkspace', () => ({ BotWorkspace: ({ onOpenUrl }: { onOpenUrl(url: string): void }) => <>
  <input defaultValue="保留聊天草稿" /><button data-chat-web onClick={() => onOpenUrl('https://example.com/docs')}>打开网页</button>
  <button data-chat-unsafe onClick={() => onOpenUrl('file:///C:/private.txt')}>无效链接</button>
</> }));

it('opens companion links as an active built-in browser tab, preserves the chat and never falls back to the system browser', async () => {
  const request = vi.fn().mockResolvedValue({ ok: true }), external = vi.fn();
  Object.defineProperty(window, 'worldlinebox', { configurable: true, value: { browser: { request, onCaptureOpenAssets: () => () => undefined }, shell: { openExternalUrl: external, onApplicationMenuCommand: () => () => undefined } } });
  const { App } = await import('../../src/renderer/Application');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(() => root.render(<LocaleProvider initialPreference="zh-CN"><App /></LocaleProvider>));
    const chat = () => host.querySelector<HTMLButtonElement>('[data-application-module="companions"]')!;
    await act(() => chat().click());
    await act(() => host.querySelector<HTMLButtonElement>('[data-chat-web]')!.click());
    expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'tab.new', url: 'https://example.com/docs', background: false });
    expect(host.querySelector('[data-application-module="browser"]')?.getAttribute('aria-current')).toBe('page');
    await act(() => chat().click()); expect(host.querySelector('input')?.value).toBe('保留聊天草稿');
    await act(() => host.querySelector<HTMLButtonElement>('[data-chat-unsafe]')!.click()); expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error('fixture browser failure'));
    await act(() => host.querySelector<HTMLButtonElement>('[data-chat-web]')!.click());
    expect(chat().getAttribute('aria-current')).toBe('page'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('内置浏览器未能打开');
    expect(external).not.toHaveBeenCalled();
  } finally { await act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window, 'worldlinebox'); }
});
