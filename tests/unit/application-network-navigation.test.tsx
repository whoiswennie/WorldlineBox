// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import type { ApplicationNetworkResponse, ApplicationNetworkState } from '../../src/shared/application-network';
import { LocaleProvider } from '../../src/renderer/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/theme/AnimatedBackground', () => ({ ThemeBackground: () => null }));
vi.mock('../../src/renderer/hover-tip', () => ({ HoverTipHost: () => null }));
vi.mock('../../src/renderer/edit-text-context-menu', () => ({ EditTextContextMenuHost: () => null }));
vi.mock('../../src/renderer/WindowsWindowControls', () => ({ WindowsWindowControls: () => null }));
vi.mock('../../src/renderer/WindowEdgeResizeHandles', () => ({ WindowEdgeResizeHandles: () => null }));
vi.mock('../../src/renderer/launcher/DshLauncher', () => ({ DshLauncher: ({ api }: { api?: WorldlineBoxDshLauncherApi }) => {
  useEffect(() => { void api?.request({ type: 'state' }); }, [api]);
  return <div data-launcher-test />;
} }));
vi.mock('../../src/renderer/browser/BrowserPage', () => ({ BrowserPage: ({ onOpenNetwork }: { onOpenNetwork: () => void }) => <button data-browser-network onClick={onOpenNetwork}>Browser network</button> }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); Reflect.deleteProperty(window, 'worldlinebox'); });

it('exposes global network in the application rail and routes browser errors there without reactivating DSH', async () => {
  const state: ApplicationNetworkState = { settings: { proxyMode: 'direct', proxyUrl: '', proxyProfiles: [], npmRegistry: 'https://registry.npmjs.org', npmDownloadRoute: 'auto', pythonIndex: 'https://pypi.org/simple', githubMirror: 'auto', githubMirrorUrl: '' }, revision: 1, recentFailures: [] };
  const networkRequest = vi.fn(async (): Promise<ApplicationNetworkResponse> => ({ ok: true, state }));
  const launcherRequest = vi.fn().mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'worldlinebox', { configurable: true, value: {
    network: { request: networkRequest, onChanged: () => () => undefined },
    dshLauncher: { request: launcherRequest, onChanged: () => () => undefined },
  } });
  const { App } = await import('../../src/renderer/Application');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<LocaleProvider initialPreference="zh-CN"><App /></LocaleProvider>); });
  const network = container!.querySelector<HTMLButtonElement>('[data-application-module="network"]')!;
  expect(network.textContent).toContain('全局网络');
  expect(networkRequest).not.toHaveBeenCalled();
  await act(() => container!.querySelector<HTMLButtonElement>('[data-application-module="browser"]')!.click());
  launcherRequest.mockClear();
  await act(async () => {
    container!.querySelector<HTMLButtonElement>('[data-browser-network]')!.click();
    await import('../../src/renderer/network/ApplicationNetworkPage');
  });
  expect(network.getAttribute('aria-current')).toBe('page');
  expect(container!.querySelector('[data-application-network]')).not.toBeNull();
  expect(networkRequest).toHaveBeenCalledWith({ type: 'state' });
  expect(launcherRequest).not.toHaveBeenCalled();
  expect(container!.querySelector('[data-application-view="dsh"]')!.hasAttribute('hidden')).toBe(true);
});
