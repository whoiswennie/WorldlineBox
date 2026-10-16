// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { retryStartup, startupRetryCount } from '../../src/renderer/startup-retry';
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });
it('allows two explicit retries and stops without reloading at the limit', () => {
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
  expect(startupRetryCount()).toBe(0); retryStartup(); expect(startupRetryCount()).toBe(1); retryStartup(); expect(startupRetryCount()).toBe(2); retryStartup();
  expect(reload).toHaveBeenCalledTimes(2);
});
it('rejects corrupt or excessive stored retry counts', () => {
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
  for (const value of ['NaN', '-1', '1.5', '999']) { sessionStorage.setItem('worldlinebox.startup-retries', value); expect(startupRetryCount()).toBe(2); retryStartup(); }
  expect(reload).not.toHaveBeenCalled();
});
