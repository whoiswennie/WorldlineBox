import { expect, it, vi } from 'vitest';
import { BrowserService } from '../../src/main/browser/service';

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('../../src/main/application-network', () => ({ getApplicationNetwork: vi.fn() }));

it('reads the ready browser snapshot without rewriting its session or broadcasting a mutation', async () => {
  const send = vi.fn();
  const owner = { isDestroyed: () => false, webContents: { send } };
  const service = new BrowserService(() => owner as never, 'unused-readonly-browser-root');
  Reflect.set(service, 'initialization', Promise.resolve());
  Reflect.set(service, 'error', 'A real browser failure remains visible until another action.');
  const persist = vi.spyOn(service.store, 'changed');
  const first = await service.handle({ type: 'state' });
  const next = await service.handle({ type: 'state' });
  expect(first.ok && first.state?.revision).toBe(0);
  expect(next).toEqual(first);
  expect(first.ok && first.state?.error).toBe('A real browser failure remains visible until another action.');
  expect(persist).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
