// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RendererReady, StartupScreen } from '../../src/renderer/StartupScreen';
import { escapeStartupText, STARTUP_PHASES, startupMarkup } from '../../src/shared/startup-presentation';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('escapes dynamic labels and exposes real phase steps without a made-up percentage', () => {
  const html = startupMarkup('test.png', '<unsafe>', 'a & b');
  expect(html).toContain('&lt;unsafe&gt;'); expect(html).toContain('a &amp; b'); expect(html).not.toContain('aria-valuenow');
  expect(STARTUP_PHASES.map(value => value.id)).toEqual(['environment', 'services', 'storage', 'interface']); expect(escapeStartupText('"')).toBe('&quot;');
});
it('hands the pre-React shell off to the reusable observer loader', async () => {
  const shell = document.createElement('div'); shell.id = 'startup-shell'; document.body.append(shell);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(() => root.render(<StartupScreen title="正在打开伙伴世界" detail="读取真实世界状态" stage="连接世界" compact />));
  expect(document.getElementById('startup-shell')).toBeNull(); expect(host.querySelector('h1')?.textContent).toBe('正在打开伙伴世界'); expect(host.querySelector('[role="status"]')?.textContent).toContain('连接世界');
  expect(host.querySelector('.startup-screen')?.classList.contains('is-compact')).toBe(true); await act(() => root.unmount()); host.remove();
});
it('keeps animation elements and their phase while elapsed time updates', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(() => root.render(<StartupScreen />));
    const track = host.querySelector('.startup-track > span'), orbit = host.querySelector('.startup-orbit');
    await act(() => vi.advanceTimersByTime(1250));
    expect(host.querySelector('.startup-track > span')).toBe(track); expect(host.querySelector('.startup-orbit')).toBe(orbit);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('1.3 秒');
  } finally { await act(() => root.unmount()); host.remove(); vi.useRealTimers(); }
});
it('notifies native readiness after paint and cancels StrictMode and unmount callbacks', async () => {
  let sequence = 0; const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const notify = vi.fn(); window.worldlineboxStartup = { notify };
  const nextFrame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(performance.now())); };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(() => root.render(<StrictMode><RendererReady><p>真实主界面</p></RendererReady></StrictMode>));
    expect(frames.size).toBe(1); expect(notify).not.toHaveBeenCalled();
    nextFrame(); expect(notify).not.toHaveBeenCalled(); nextFrame();
    expect(notify).toHaveBeenCalledExactlyOnceWith('ready');
    await act(() => root.render(<RendererReady key="replacement"><p>替换界面</p></RendererReady>));
    await act(() => root.unmount()); nextFrame(); nextFrame(); expect(notify).toHaveBeenCalledTimes(1);
  } finally { host.remove(); delete window.worldlineboxStartup; vi.unstubAllGlobals(); }
});
