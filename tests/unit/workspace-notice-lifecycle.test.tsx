// @vitest-environment happy-dom
import { Activity, act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../../src/renderer/i18n';
import { useToastNotifications } from '../../src/renderer/useToastNotifications';
import { WorkspaceNoticeBanner } from '../../src/renderer/WorkspaceNoticeBanner';
import { WorkspaceNoticeStack } from '../../src/renderer/WorkspaceNoticeStack';
import { TOAST_EXIT_DURATION_MS, TOAST_NOTICE_DURATION_MS } from '../../src/renderer/toast-notifications';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

function AssetNotices({ active }: { active: boolean }) {
  const toast = useToastNotifications();
  return <><button data-emit onClick={() => toast.setNotice('已自动同步 3 项磁盘变化。')}>同步</button>
    {toast.renderedStack.length ? <WorkspaceNoticeStack active={active}><div className="workspace-notice-stack">{toast.renderedStack.map(message => <WorkspaceNoticeBanner key={message.id} message={message} toastId={message.id}
      closing={message.closing} onDismiss={() => toast.dismissToast(message.id)} onTransitionEnd={toast.handleToastTransitionEnd} />)}</div></WorkspaceNoticeStack> : null}</>;
}
async function render(active: boolean, keepEffectsActive = false, strict = false, settingsOpen = false) {
  const content = <LocaleProvider initialPreference="zh-CN"><Activity mode={active || keepEffectsActive ? 'visible' : 'hidden'}><div hidden={!active}><AssetNotices active={active || settingsOpen} /></div></Activity></LocaleProvider>;
  await act(() => root.render(strict ? <StrictMode>{content}</StrictMode> : content));
}
const entries = () => [...document.querySelectorAll<HTMLElement>('[data-toast-id]')];
async function emit() { await act(() => host.querySelector<HTMLButtonElement>('[data-emit]')!.click()); }

it('removes the body notice portal when a retained asset module is hidden, without waiting for timers', async () => {
  await render(true); await emit(); expect(entries()).toHaveLength(1);
  await render(false);
  expect(entries()).toHaveLength(0);
});

it('does not revive old sync notices on return and keeps fresh identical events dismissible and expiring', async () => {
  await render(true); await emit(); await render(false); await render(true);
  expect(entries()).toHaveLength(0);
  await emit(); expect(entries()).toHaveLength(1);
  await act(() => entries()[0]!.querySelector<HTMLButtonElement>('.ui-feedback__dismiss')!.click());
  expect(entries()[0]!.classList.contains('is-closing')).toBe(true);
  await act(() => { vi.advanceTimersByTime(TOAST_EXIT_DURATION_MS + 50); }); expect(entries()).toHaveLength(0);
  await emit(); expect(entries()).toHaveLength(1);
  await act(() => { vi.advanceTimersByTime(TOAST_NOTICE_DURATION_MS + TOAST_EXIT_DURATION_MS + 50); }); expect(entries()).toHaveLength(0);
});

it('does not leak asset notices when another retained controller keeps module effects alive', async () => {
  await render(true, true); await emit(); expect(entries()).toHaveLength(1);
  await render(false, true); expect(entries()).toHaveLength(0);
});

it('supports actual dismiss and fallback removal after StrictMode effect cleanup', async () => {
  await render(true, false, true); await emit(); expect(entries()).toHaveLength(1);
  await act(() => entries()[0]!.querySelector<HTMLButtonElement>('.ui-feedback__dismiss')!.click());
  await act(() => { vi.advanceTimersByTime(TOAST_EXIT_DURATION_MS + 50); }); expect(entries()).toHaveLength(0);
});

it('allows notices for an explicitly open global settings overlay while the assets view remains hidden', async () => {
  await render(false, true, false, true); await emit(); expect(entries()).toHaveLength(1);
  await act(() => entries()[0]!.querySelector<HTMLButtonElement>('.ui-feedback__dismiss')!.click());
  await act(() => { vi.advanceTimersByTime(TOAST_EXIT_DURATION_MS + 50); }); expect(entries()).toHaveLength(0);
  await emit(); await render(false, true, false, false); expect(entries()).toHaveLength(0);
});
