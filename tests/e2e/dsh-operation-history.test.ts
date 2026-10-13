import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DshLauncherRequest, DshLauncherResponse, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function request(page: Page, input: DshLauncherRequest): Promise<DshLauncherResponse> {
  return page.evaluate(value => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(value), input);
}

async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' });
  if (!result.ok || !result.state) throw new Error(!result.ok ? result.error : 'Missing launcher state.');
  return result.state;
}

test('historical failures stay in history, live failures dismiss once, and cleanup leaves managed data intact', async () => {
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'DSH launcher UI requires Windows x64.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-history-e2e-'));
  const userData = path.join(root, 'user-data');
  const manager = path.join(userData, 'dsh-launcher');
  const operations = path.join(manager, 'operations'); await mkdir(operations, { recursive: true });
  await writeFile(path.join(operations, 'operations.json'), JSON.stringify([{ id: 'historical-download', kind: 'runtime.download', label: '历史下载', status: 'failed', phase: 'failed', error: 'Invalid URL', startedAt: '2026-10-12T08:20:34Z', finishedAt: '2026-10-12T08:20:35Z' }]));
  await writeFile(path.join(operations, 'historical-download.log'), 'historical diagnostic log');
  for (const area of ['runtimes', 'cache', 'instances']) { await mkdir(path.join(manager, area), { recursive: true }); await writeFile(path.join(manager, area, 'retained-marker'), area); }
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: userData }) });
  try {
    const page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate(window => window.hide());
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await expect.poll(async () => (await state(page)).operations.length).toBe(1);
    await expect(page.locator('[data-dsh-operation-alert]')).toHaveCount(0);
    await page.locator('.launcher-navigation').getByRole('button', { name: '操作记录' }).click();
    await expect(page.locator('[data-dsh-operation="historical-download"]')).toContainText('Invalid URL');
    const result = await request(page, { type: 'runtime.verify', runtimeId: 'missing-runtime' });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.operationId) throw new Error('Expected asynchronous verification operation.');
    await expect.poll(async () => (await state(page)).operations.find(item => item.id === result.operationId)?.status).toBe('failed');
    const alert = page.locator(`[data-dsh-operation-alert="${result.operationId}"]`);
    await expect(alert).toContainText('not installed');
    await expect(alert).not.toContainText('Invalid URL');
    await alert.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.locator('[data-dsh-operation-alert]')).toHaveCount(0);
    await page.locator('[data-application-module="assets"]').click();
    await page.locator('[data-application-module="dsh"]').click();
    await expect(page.locator('[data-dsh-operation-alert]')).toHaveCount(0);
    await page.getByRole('button', { name: '清理已结束记录', exact: true }).click();
    await expect.poll(async () => (await state(page)).operations.length).toBe(0);
    await expect(page.getByRole('button', { name: '清理已结束记录', exact: true })).toBeDisabled();
    await expect(page.locator('[data-dsh-operation-alert]')).toHaveCount(0);
    await expect.poll(() => readFile(path.join(operations, 'historical-download.log'), 'utf8').then(() => 'exists').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 'removed';
      throw error;
    })).toBe('removed');
    for (const area of ['runtimes', 'cache', 'instances']) expect(await readFile(path.join(manager, area, 'retained-marker'), 'utf8')).toBe(area);
    expect(JSON.parse(await readFile(path.join(operations, 'operations.json'), 'utf8'))).toEqual([]);
  } finally { await application.close(); }
});
