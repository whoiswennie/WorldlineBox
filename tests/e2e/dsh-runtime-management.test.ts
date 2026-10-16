import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshLauncherRequest, DshLauncherState, DshRuntime, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function request(page: Page, input: DshLauncherRequest) {
  return page.evaluate(value => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(value), input);
}
async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' }); if (!result.ok || !result.state) throw new Error(result.ok ? 'Missing state' : result.error); return result.state;
}
async function settled(page: Page) {
  await expect.poll(async () => (await state(page)).operations.some(operation => operation.status === 'running'), { timeout: 60000 }).toBe(false);
}

test('isolated compatibility evidence, failure reasons, reference protection and runtime/cache deletion work in the real launcher', async () => {
  test.setTimeout(150000); test.skip(process.platform !== 'win32');
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-runtime-management-'));
  const profile = path.join(root, 'profile'); const launcher = path.join(profile, 'dsh-launcher');
  const bytes = Buffer.from('Synthetic non-executable: native boot must fail safely.');
  const files = [{ path: 'DeepSeek Harness.exe', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }];
  const contentSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const runtime: DshRuntime = { id: `runtime-${contentSha256.slice(0, 24)}`, version: '99.0.0-ui-fixture', nodeVersion: '24.15.0', platform: 'win32-x64', adapter: 'desktop-cli-web-v1',
    source: 'Synthetic UI failure fixture', sourceSha256: 'a'.repeat(64), contentSha256, installedAt: new Date().toISOString(), fileCount: 1, byteLength: bytes.length };
  const artifact = path.join(launcher, 'runtimes', runtime.id); await mkdir(path.join(artifact, 'program'), { recursive: true });
  await writeFile(path.join(artifact, 'program', 'DeepSeek Harness.exe'), bytes);
  await writeFile(path.join(artifact, 'seal.json'), JSON.stringify({ files, contentSha256, fileCount: 1, byteLength: bytes.length }));
  await writeFile(path.join(artifact, 'artifact.json'), JSON.stringify(runtime));
  await writeFile(path.join(launcher, 'runtimes.json'), JSON.stringify([runtime]));
  await mkdir(path.join(launcher, 'shared'), { recursive: true }); await writeFile(path.join(launcher, 'shared', 'user-save'), 'untouched');
  await mkdir(path.join(launcher, 'cache'), { recursive: true }); const cache = path.join(launcher, 'cache', `${'a'.repeat(64)}.exe`); await writeFile(cache, 'synthetic installer');
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
  try {
    const page = await application.firstWindow(); const native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 1000); });
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible(); await settled(page);
    await page.locator('.launcher-navigation').getByRole('button', { name: '运行版本', exact: true }).click();
    await expect(page.getByRole('tab', { name: '已安装版本 · 1', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: '清理下载缓存', exact: true })).toHaveCount(0);
    await expect(page.locator('[data-dsh-official-versions]')).toHaveCount(0);
    const card = page.locator(`[data-dsh-runtime="${runtime.id}"]`); const panel = card.locator('[data-dsh-compatibility]');
    await expect(panel).toHaveAttribute('data-dsh-compatibility', 'failed');
    await expect(panel).toContainText('运行文件完整性'); await expect(panel).toContainText('原生接口与隔离启动'); await expect(panel).toContainText('失败');
    await expect(panel).toContainText('临时数据已清理');
    const report = (await state(page)).runtimes[0]!.compatibility!;
    expect(report.checks.find(item => item.id === 'integrity')?.status).toBe('passed');
    expect(report.checks.find(item => item.status === 'failed')?.detail).toBeTruthy();
    await page.locator('.launcher-sidebar-section').getByRole('button').click();
    const dialog = page.getByRole('dialog', { name: '创建实例', exact: true });
    await expect(dialog.getByRole('combobox', { name: '存档模式' }).locator('option[value="shared"]')).toBeDisabled(); await page.keyboard.press('Escape');
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '通用设置', exact: true }); await settings.getByRole('tab', { name: '外观', exact: true }).click();
      await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
      await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click(); await page.keyboard.press('Escape');
      await panel.screenshot({ path: path.resolve(`.tools/test-output/verified-runtime-compatibility-${theme}.png`) });
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    const created = await request(page, { type: 'instance.create', name: '引用保护实例', runtimeId: runtime.id }); expect(created.ok).toBe(true); await settled(page);
    await expect(card).toContainText('引用保护实例'); await expect(card.getByRole('button', { name: '删除运行版本', exact: true })).toBeDisabled();
    expect((await request(page, { type: 'runtime.delete', runtimeId: runtime.id })).ok).toBe(false);
    const selectionBefore = (await state(page)).cli?.selectedInstanceId;
    const other = await request(page, { type: 'instance.create', name: '另一实例', runtimeId: runtime.id }); expect(other.ok).toBe(true); await settled(page);
    for (const item of (await state(page)).instances) {
      await page.locator(`[data-dsh-instance="${item.id}"]`).click();
      expect((await state(page)).cli?.selectedInstanceId).toBe(selectionBefore);
      await expect(page.getByText('正在准备 CLI 环境…', { exact: true })).toHaveCount(0);
    }
    const extra = (await state(page)).instances.find(item => item.name === '另一实例')!;
    expect((await request(page, { type: 'instance.delete', instanceId: extra.id })).ok).toBe(true); await settled(page);
    await page.locator('.launcher-navigation').getByRole('button', { name: '运行版本', exact: true }).click();
    const instance = (await state(page)).instances[0]!; expect((await request(page, { type: 'instance.delete', instanceId: instance.id })).ok).toBe(true); await settled(page);
    await card.getByRole('button', { name: '删除运行版本', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click(); await settled(page);
    await expect.poll(async () => readFile(cache).then(() => true, () => false)).toBe(false);
    await expect(card).toHaveCount(0); expect((await state(page)).runtimes).toEqual([]);
    expect(await readFile(path.join(launcher, 'shared', 'user-save'), 'utf8')).toBe('untouched');
  } finally { await application.close(); if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-runtime-management-')) await rm(root, { recursive: true, force: true }); }
});
