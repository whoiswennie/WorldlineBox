import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('a corrupted DSH registry stays in its module and does not prevent asset startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dsh-startup-isolation-'));
  const profile = path.join(root, 'user-data');
  const registry = path.join(profile, 'dsh-launcher', 'runtimes.json');
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, 'not-json-preserve-this-file');
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root,
  }) });
  try {
    const page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate(window => window.hide());
    await page.locator('[data-application-module="assets"]').click();
    await page.getByRole('button', { name: '创建资源库', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('启动器失败时的资产库');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-application-module="assets"]')).toHaveAttribute('aria-current', 'page');
    await page.locator('[data-application-module="dsh"]').click();
    await expect(page.locator('.launcher-banner.is-error')).toBeVisible();
    await page.locator('[data-application-module="assets"]').click();
    await expect(page.getByRole('button', { name: '导入文件', exact: true })).toBeVisible();
    expect(await readFile(registry, 'utf8')).toBe('not-json-preserve-this-file');
  } finally {
    await application.close();
    if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-dsh-startup-isolation-')) await rm(root, { recursive: true, force: true });
  }
});

test('a missing launcher dependency does not abort the isolated application', async () => {
  const appRoot = path.resolve(resolveElectronAppPath());
  test.skip(appRoot !== path.resolve('.tools/e2e-app'), 'Dependency injection is restricted to the disposable test application.');
  const dependency = path.join(appRoot, 'node_modules', '7zip-bin');
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dsh-dependency-isolation-'));
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, 'package.json'), '{"name":"7zip-bin","main":"index.js"}');
  await writeFile(path.join(dependency, 'index.js'), 'throw new Error("DSH test dependency unavailable");');
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [appRoot], env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'user-data') }) });
    const page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate(window => window.hide());
    await page.locator('[data-application-module="assets"]').click();
    await expect(page.getByRole('button', { name: '创建资源库', exact: true })).toBeVisible();
    await page.locator('[data-application-module="dsh"]').click();
    await expect(page.getByRole('alert')).toContainText('DSH launcher initialization failed');
    await page.locator('[data-application-module="assets"]').click();
    await expect(page.getByRole('button', { name: '创建资源库', exact: true })).toBeVisible();
  } finally {
    await application?.close();
    if (path.dirname(dependency) === path.join(path.resolve('.tools/e2e-app'), 'node_modules')) await rm(dependency, { recursive: true, force: true });
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-dsh-dependency-isolation-')) await rm(root, { recursive: true, force: true });
  }
});
