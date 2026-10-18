// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserLoadFailure } from '../../src/renderer/browser/BrowserLoadFailure';
import { LocaleProvider } from '../../src/renderer/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });

async function mount(error: string, locale: 'zh-CN' | 'en' = 'zh-CN') {
  const reload = vi.fn(); const network = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<LocaleProvider initialPreference={locale}><BrowserLoadFailure error={error} onReload={reload} onOpenNetwork={network} /></LocaleProvider>));
  return { reload, network };
}

it('offers explicit retry and existing network settings while retaining the real DNS error', async () => {
  const { reload, network } = await mount('ERR_NAME_NOT_RESOLVED (-105)');
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).toContain('无法解析网站地址');
  expect(host.querySelector('code')?.textContent).toBe('ERR_NAME_NOT_RESOLVED (-105)');
  expect(host.querySelector('details')?.open).toBe(false);
  expect(reload).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  await act(() => host.querySelectorAll('button')[0]!.click()); expect(reload).toHaveBeenCalledOnce();
  await act(() => host.querySelectorAll('button')[1]!.click()); expect(network).toHaveBeenCalledOnce();
});

it('explains a TLS failure without offering a certificate bypass', async () => {
  await mount('ERR_CERT_DATE_INVALID (-201)', 'en');
  expect(host.textContent).toContain('A secure connection could not be established');
  expect(host.textContent).toContain('system clock');
  expect(host.querySelectorAll('button')).toHaveLength(2);
  expect(host.querySelector('summary')?.textContent).toBe('Technical details');
});
