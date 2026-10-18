import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronLaunchEnv } from './electron-test-helpers';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';

async function settings(page: Page) {
  return page.evaluate(async () => {
    const response = await (globalThis as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request({ type: 'state' });
    if (!response.ok || !response.state?.network) throw Error('No applied network settings');
    return response.state.network.settings;
  });
}

test('packaged proxy switch and mirror selectors apply immediately and preserve settings across restart', async () => {
  test.setTimeout(90_000);
  const parent = await realpath(tmpdir()); const root = await mkdtemp(path.join(parent,'worldlinebox-packaged-network-'));
  let application: ElectronApplication | undefined;
  const open = () => electron.launch({ executablePath:path.resolve('out/WorldlineBox-win32-x64/WorldlineBox.exe'),args:[],env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:path.join(root,'user-data')}) });
  try {
    application = await open();
    expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    let page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(win=>{win.setOpacity(0);win.setFocusable(false);win.showInactive();});
    await page.locator('.launcher-navigation').getByRole('button',{name:'网络设置',exact:true}).click();
    await expect(page.getByLabel('依赖解析与下载线路')).toHaveValue('auto');
    await page.getByLabel('依赖解析与下载线路').selectOption('registry');
    // The editable dependency policy is saved explicitly. Proxy switches and
    // concrete source presets below apply immediately without saving drafts.
    await page.getByRole('button', { name: '保存网络设置', exact: true }).click();
    await expect.poll(async () => (await settings(page)).npmDownloadRoute).toBe('registry');
    await page.getByLabel('快速启用本机代理端口').selectOption('http://127.0.0.1:7896');
    await expect.poll(async () => (await settings(page)).proxyUrl).toBe('http://127.0.0.1:7896');
    await expect(page.getByRole('switch', { name: '启用代理' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('switch', { name: '启用代理' }).click();
    await expect.poll(async () => (await settings(page)).proxyMode).toBe('direct');
    await expect(page.getByRole('switch', { name: '启用代理' })).toHaveAttribute('aria-checked', 'false');
    await page.getByLabel('npm 来源方案', { exact: true }).selectOption('https://registry.npmmirror.com');
    await expect.poll(async () => (await settings(page)).npmRegistry).toBe('https://registry.npmmirror.com');
    await page.getByLabel('Python 来源方案', { exact: true }).selectOption('https://pypi.tuna.tsinghua.edu.cn/simple');
    await expect.poll(async () => (await settings(page)).pythonIndex).toBe('https://pypi.tuna.tsinghua.edu.cn/simple');
    await expect(page.getByRole('button',{name:'保存网络设置',exact:true})).toBeDisabled();
    await page.screenshot({path:'.tools/test-output/dsh-network-settings.png',fullPage:true});
    await application.close(); application = await open(); page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(win=>{win.setOpacity(0);win.setFocusable(false);win.showInactive();});
    await page.locator('.launcher-navigation').getByRole('button',{name:'网络设置',exact:true}).click();
    await expect(page.getByLabel('依赖解析与下载线路')).toHaveValue('registry');
    await expect(page.getByRole('switch', { name: '启用代理' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByLabel('npm 来源方案', { exact: true })).toHaveValue('https://registry.npmmirror.com');
    await expect(page.getByLabel('Python 来源方案', { exact: true })).toHaveValue('https://pypi.tuna.tsinghua.edu.cn/simple');
    await page.getByRole('switch', { name: '启用代理' }).click();
    await expect.poll(async () => (await settings(page)).proxyMode).toBe('custom');
    expect((await settings(page)).proxyUrl).toBe('http://127.0.0.1:7896');
  } finally {
    await application?.close();
    await cleanup(root,parent);
  }
});
async function cleanup(root:string,parent:string) {
  const resolved=await realpath(root);
  if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('worldlinebox-packaged-network-'))throw Error('Unexpected network test profile');
  await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:150});
}
