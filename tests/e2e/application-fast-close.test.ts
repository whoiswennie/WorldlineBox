import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function closeWithin(application: ElectronApplication, milliseconds = 10_000): Promise<void> {
  const child = application.process();
  const started = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('The application did not complete its early shutdown within ten seconds.')), milliseconds);
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(milliseconds);
    expect(child.exitCode).toBe(0);
  } catch (error) {
    // Only this test's directly spawned Electron process is owned here. Do not
    // let a blocking native error dialog consume the entire suite timeout.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw error;
  } finally { clearTimeout(timeout); }
}

test('closing immediately after window creation exits promptly and the same profile restarts normally', async () => {
  test.setTimeout(45_000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-fast-close-'));
  const profile = path.join(root, 'user-data');
  const marker = path.join(profile, 'fast-close-marker.txt');
  await mkdir(profile); await writeFile(marker, 'preserve this isolated profile');
  const environment = electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
    WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1' });
  const launch = () => electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: environment });
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    // firstWindow observes BrowserWindow creation. Deliberately perform no
    // renderer, DOMContentLoaded, load-state or settings IPC waits before quit.
    await application.firstWindow({ timeout: 10_000 });
    await closeWithin(application); application = undefined;
    expect(await readFile(marker, 'utf8')).toBe('preserve this isolated profile');

    application = await launch();
    const page = await application.firstWindow({ timeout: 10_000 });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.launcher-titlebar-heading').getByText('DSH 启动器', { exact: true })).toBeVisible();
    await expect(page.locator('.launcher-banner.is-error')).toHaveCount(0);
    expect(await readFile(marker, 'utf8')).toBe('preserve this isolated profile');
    await closeWithin(application); application = undefined;
  } finally {
    try { if (application) await closeWithin(application); }
    finally {
      const resolved = path.resolve(root);
      if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('worldlinebox-fast-close-')) await rm(resolved, { recursive: true, force: true });
    }
  }
});
