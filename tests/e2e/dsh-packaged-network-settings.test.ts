import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronLaunchEnv } from './electron-test-helpers';

test('packaged network settings expose archive routing and persist it across restart', async () => {
  test.setTimeout(90_000);
  const parent = await realpath(tmpdir()); const root = await mkdtemp(path.join(parent,'worldlinebox-packaged-network-'));
  let application: ElectronApplication | undefined;
  const open = () => electron.launch({ executablePath:path.resolve('out/WorldlineBox-win32-x64/WorldlineBox.exe'),args:[],env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:path.join(root,'user-data')}) });
  try {
    application = await open();
    let page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(win=>win.hide());
    await page.locator('.launcher-navigation').getByRole('button',{name:'网络设置',exact:true}).click();
    await expect(page.getByLabel('依赖解析与下载线路')).toHaveValue('auto');
    await page.getByLabel('依赖解析与下载线路').selectOption('registry');
    await page.getByRole('button',{name:'保存网络设置',exact:true}).click();
    await expect(page.getByRole('button',{name:'保存网络设置',exact:true})).toBeDisabled();
    await page.screenshot({path:'.tools/test-output/dsh-network-settings.png',fullPage:true});
    await application.close(); application = await open(); page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(win=>win.hide());
    await page.locator('.launcher-navigation').getByRole('button',{name:'网络设置',exact:true}).click();
    await expect(page.getByLabel('依赖解析与下载线路')).toHaveValue('registry');
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
