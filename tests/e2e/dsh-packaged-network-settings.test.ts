import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronLaunchEnv } from './electron-test-helpers';
import type { WorldlineBoxApplicationNetworkApi } from '../../src/shared/application-network';

async function settings(page: Page) {
  return page.evaluate(async () => {
    const response = await (globalThis as unknown as { worldlinebox: { network: WorldlineBoxApplicationNetworkApi } }).worldlinebox.network.request({ type: 'state' });
    if (!response.ok || !response.state) throw Error('No applied network settings');
    return response.state.settings;
  });
}

async function verifyNetworkFailureDiagnostics(application: ElectronApplication, page: Page) {
  const sockets = new Set<Socket>();
  // A real TLS connection reaches this TCP fixture, then its peer closes it
  // during the ClientHello. No certificate or TLS verification is bypassed.
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => socket.end());
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No diagnostics fixture port');
  const origin = `https://127.0.0.1:${address.port}`;
  const diagnostics = () => page.evaluate(async () => {
    const response = await (globalThis as unknown as { worldlinebox: { network: WorldlineBoxApplicationNetworkApi } }).worldlinebox.network.request({ type: 'state' });
    if (!response.ok || !response.state) throw Error('No network diagnostic state');
    return response.state.recentFailures;
  });
  const clear = () => page.evaluate(async () => {
    const response = await (globalThis as unknown as { worldlinebox: { network: WorldlineBoxApplicationNetworkApi } }).worldlinebox.network.request({ type: 'network.diagnostics.clear' });
    if (!response.ok) throw Error(response.error);
  });
  try {
    await clear();
    for (const token of ['private-token-first', 'private-token-second']) {
      const result = await application.evaluate(async ({ net }, url) => {
        try { await net.fetch(url, { signal: AbortSignal.timeout(10_000) }); return { ok: true, error: '' }; }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }, `${origin}/private-path?token=${token}#private-fragment`);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('ERR_CONNECTION_CLOSED');
    }
    await expect.poll(async () => (await diagnostics()).filter(failure => failure.origin === origin).map(failure => failure.count)).toEqual([2]);
    const failures = await diagnostics();
    const failure = failures.find(value => value.origin === origin)!;
    expect(failure).toMatchObject({ origin, error: 'net::ERR_CONNECTION_CLOSED', count: 2, module: 'application' });
    const serialized = JSON.stringify(failure);
    for (const secret of ['private-path', 'private-token-first', 'private-token-second', 'private-fragment']) expect(serialized).not.toContain(secret);
    const panel = page.locator('[data-network-failures]');
    const search = panel.getByRole('searchbox', { name: '搜索站点或错误', exact: true });
    await search.fill(origin);
    const row = panel.locator('li');
    await expect(row).toHaveCount(1);
    await expect(row.locator('code').first()).toHaveText(origin);
    await expect(row).toContainText('共 2 次');
    await expect(row).toContainText(failure.resourceType === 'mainFrame' ? '页面加载' : '子资源');
    await search.fill('private-token-first');
    await expect(row).toHaveCount(0);
    await expect(panel).toContainText('没有匹配的网络失败记录');
    await search.fill('ERR_CONNECTION_CLOSED');
    await expect(row).toHaveCount(1);
    await panel.getByRole('button', { name: '清空记录', exact: true }).click();
    await expect.poll(async () => (await diagnostics()).filter(value => value.origin === origin)).toEqual([]);
    await expect(panel.locator('li')).toHaveCount(0);
    await expect(panel).toContainText('暂无网络失败记录');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
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
    await expect(page.locator('.launcher-navigation').getByRole('button',{name:'网络设置',exact:true})).toHaveCount(0);
    await page.locator('[data-application-module="network"]').click();
    await expect(page.locator('[data-application-network]')).toBeVisible();
    await expect(page.locator('[data-application-module="network"]')).toHaveAttribute('aria-current', 'page');
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
    await page.screenshot({path:'.tools/test-output/application-network-settings.png',fullPage:true});
    await application.close(); application = await open(); page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(win=>{win.setOpacity(0);win.setFocusable(false);win.showInactive();});
    await expect(page.locator('.launcher-navigation').getByRole('button',{name:'网络设置',exact:true})).toHaveCount(0);
    await page.locator('[data-application-module="network"]').click();
    await expect(page.locator('[data-application-network]')).toBeVisible();
    await expect(page.locator('[data-application-module="network"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('依赖解析与下载线路')).toHaveValue('registry');
    await expect(page.getByRole('switch', { name: '启用代理' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByLabel('npm 来源方案', { exact: true })).toHaveValue('https://registry.npmmirror.com');
    await expect(page.getByLabel('Python 来源方案', { exact: true })).toHaveValue('https://pypi.tuna.tsinghua.edu.cn/simple');
    await verifyNetworkFailureDiagnostics(application, page);
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
