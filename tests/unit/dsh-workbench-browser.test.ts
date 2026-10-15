import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
import { isExternalWorkbenchUrl, mayWriteWorkbenchClipboard } from '../../src/main/dsh/workbench-browser';

it('grants only clipboard writes from the owned loopback top-level document', () => {
  const origin = 'http://127.0.0.1:45678';
  expect(mayWriteWorkbenchClipboard('clipboard-sanitized-write', origin, `${origin}/settings`, origin, true)).toBe(true);
  for (const permission of ['clipboard-read', 'media', 'fileSystem']) expect(mayWriteWorkbenchClipboard(permission, origin, origin, origin, true)).toBe(false);
  expect(mayWriteWorkbenchClipboard('clipboard-sanitized-write', origin, origin, origin, false)).toBe(false);
  expect(mayWriteWorkbenchClipboard('clipboard-sanitized-write', origin, 'https://example.org', origin, true)).toBe(false);
  expect(mayWriteWorkbenchClipboard('clipboard-sanitized-write', 'http://127.0.0.1:45679', origin, origin, true)).toBe(false);
  expect(isExternalWorkbenchUrl('https://platform.deepseek.com/dsh/authorize?synthetic=1')).toBe(true);
  for (const value of ['file:///C:/secret', 'javascript:alert(1)', 'http://example.org', 'https://user:password@example.org']) expect(isExternalWorkbenchUrl(value)).toBe(false);
});
