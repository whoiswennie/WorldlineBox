// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { StartupScreen } from '../../src/renderer/StartupScreen';
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
