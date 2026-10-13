import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath, resolveSessionLogPath } from './electron-test-helpers';

test('modern Electron console events retain diagnostics without deprecated positional arguments', async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-console-event-'));
  const profile = path.join(root, 'user-data');
  const application = await electron.launch({
    executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }),
  });
  let output = '';
  application.process().stdout?.on('data', chunk => { output += String(chunk); });
  application.process().stderr?.on('data', chunk => { output += String(chunk); });
  try {
    const page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate(window => window.hide());
    await page.evaluate(() => {
      console.debug('console-event-debug-probe');
      console.info('console-event-info-probe');
      console.warn('console-event-warning-probe');
      console.error('console-event-error-probe');
    });
    const readLog = () => readFile(resolveSessionLogPath(path.join(profile, 'logs')), 'utf8');
    await expect.poll(readLog).toContain('console-event-error-probe');
    const entries = (await readLog()).trim().split('\n').map(line => JSON.parse(line) as {
      scope: string; message?: string; error?: { message: string }; context?: { level: number; line: number; sourceId: string };
    }).filter(entry => entry.scope.startsWith('renderer.console.'));
    expect(entries.find(entry => entry.message === 'console-event-warning-probe')).toMatchObject({
      scope: 'renderer.console.warning', context: { level: 2, sourceId: expect.any(String), line: expect.any(Number) },
    });
    expect(entries.find(entry => entry.error?.message === 'console-event-error-probe')).toMatchObject({
      scope: 'renderer.console.error', context: { level: 3, sourceId: expect.any(String), line: expect.any(Number) },
    });
    expect(entries.some(entry => entry.message === 'console-event-info-probe' || entry.message === 'console-event-debug-probe')).toBe(false);
    expect(output).not.toMatch(/console-message.*arguments.*deprecated|Event<WebContentsConsoleMessageEventParams> object instead/);
  } finally {
    await application.close();
    if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-console-event-')) {
      await rm(root, { recursive: true, force: true });
    }
  }
});
