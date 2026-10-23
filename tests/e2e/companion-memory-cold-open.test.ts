import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi } };

// Real Main/preload/SQLite/renderer and real local files. No chat or embedding
// response is substituted; opening files does not require model inference.
// eslint-disable-next-line no-empty-pattern
test('opens a cold notebook with hundreds of local files before background reconciliation finishes', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-cold-open-'));
  const profile = path.join(root, 'profile'), companionId = 'deepseek-sister';
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root }) });
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setContentSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await ensureCompanionTestWorkspace(page);
    // As in a user's companion page, initialize the service before measuring a
    // notebook's first open; database creation is a separate startup operation.
    expect((await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' }))).ok).toBe(true);
    const selected = (await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.workspace!({ type: 'status' }))).selected!;
    const directory = path.join(selected.memoryRoot, companionId, '资料');
    mkdirSync(directory, { recursive: true });
    for (let n = 0; n < 400; n++) writeFileSync(path.join(directory, `冷打开资料-${String(n).padStart(4, '0')}.md`), `# 真实本地资料 ${n}\n\n资料检验标记 cold-open-${n}。`);
    const cold = await page.evaluate(async companionId => {
      const started = performance.now();
      const response = await (window as unknown as Bridge).worldlinebox.companions.workspace!({ type: 'memory.documents.list', companionId, directory: '', limit: 64 });
      return { elapsedMs: performance.now() - started, ok: response.ok, error: response.error, items: response.documents?.items.length, index: response.documents?.index };
    }, companionId);
    await testInfo.attach('cold-api', { body: JSON.stringify(cold), contentType: 'application/json' });
    expect(cold.ok, cold.error).toBe(true);
    expect(cold.index?.state).toBe('building');
    expect(cold.elapsedMs).toBeLessThan(2500);

    await page.locator('[data-application-module="companions"]').click();
    await expect(page.getByRole('button', { name: '打开伙伴记忆库', exact: true })).toBeVisible();
    const uiStarted = performance.now();
    await page.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    const manager = page.getByRole('region', { name: '共同记忆管理', exact: true });
    await manager.getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(companionId);
    await expect(manager.locator('[data-memory-document]').first()).toBeVisible({ timeout: 15000 });
    const firstVisibleMs = performance.now() - uiStarted;
    await expect(manager.getByText('正在打开日记本…', { exact: true })).toHaveCount(0);
    const file = manager.locator('[data-memory-document^="资料/"]').first();
    await file.click();
    await expect(manager.locator('[data-reading-characters]')).toContainText('资料检验标记 cold-open-');
    expect(await manager.locator('[data-memory-document]').count()).toBeLessThanOrEqual(64);

    const report = { status: firstVisibleMs < 2500 ? 'passed' : 'failed', localFiles: 400, servicesPreactivated: true, coldApi: cold, firstVisibleMs, actualFileRead: true, modelTransportSubstituted: false };
    const reportPath = path.resolve('.tools/test-output/companion-memory-cold-open-electron.json');
    mkdirSync(path.dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('memory-cold-open', { body: JSON.stringify(report), contentType: 'application/json' });
    expect(firstVisibleMs).toBeLessThan(2500);
  } finally {
    await application?.close().catch(() => undefined);
    cleanup(root);
  }
});

function cleanup(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-memory-cold-open-')) throw new Error('Unexpected cold-open fixture path.');
  removeCompanionTestDirectory(root);
}
