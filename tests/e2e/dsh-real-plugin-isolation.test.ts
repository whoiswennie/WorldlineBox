import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DshLauncherRequest, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { parsePluginCatalog } from '../../src/main/dsh/marketplace';
import { inventoryTree } from '../../src/main/dsh/files';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function request(page: Page, input: DshLauncherRequest) {
  return page.evaluate(value => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(value), input);
}
async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' });
  if (!result.ok || !result.state) throw new Error(result.ok ? 'Missing state' : result.error);
  return result.state;
}
async function complete(page: Page, input: DshLauncherRequest) {
  const result = await request(page, input); if (!result.ok) throw new Error(result.error);
  if (result.operationId) {
    await expect.poll(async () => (await state(page)).operations.find(item => item.id === result.operationId)?.status ?? 'running', { timeout: 600_000 }).not.toBe('running');
    const operation = (await state(page)).operations.find(item => item.id === result.operationId)!;
    expect(operation.status, operation.error).toBe('succeeded');
  }
  return result;
}
async function removeProfile(root: string, parent: string) {
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('worldlinebox-real-plugin-')) throw new Error('Unexpected audit profile');
  await rm(resolved, { recursive: true, force: true });
}

test('installs a real pinned community plugin, verifies private copies and native loading, then disables and removes it', async () => {
  test.setTimeout(1_200_000);
  const fixture = JSON.parse(await readFile('.tools/dsh-native-node/result.json', 'utf8')) as { root: string; runtimes: Array<{ id: string; version: string }> };
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'worldlinebox-real-plugin-'));
  const userData = path.join(root, 'user-data');
  const manager = path.join(userData, 'dsh-launcher');
  const catalogDir = path.join(manager, 'marketplace/catalogs'); await mkdir(catalogDir, { recursive: true });
  const catalog = parsePluginCatalog(JSON.parse(await readFile('.tools/dsh-research/catalog-live.json', 'utf8')));
  await writeFile(path.join(catalogDir, 'plugin.json'), JSON.stringify({ version: 1, kind: 'plugin', query: '', fetchedAt: new Date().toISOString(), entries: catalog }));
  const pluginName = 'dsh-favicon-status'; const version = '0.1.0-rc.8';
  const pluginEntry = catalog.find(item => item.npmName === pluginName)!;
  expect(pluginEntry.version).toBe(version);
  const receipt: Record<string, unknown> = { plugin: `${pluginName}@${version}`, source: pluginEntry.sourceUrl, root, nativeBackend: true, mockRoutes: false };
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: userData }) });
  try {
    const page = await application.firstWindow();
    const native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.hide(); });
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    for (const item of fixture.runtimes) {
      console.info(`REAL_PLUGIN_AUDIT importing DSH ${item.version}`);
      await application.evaluate((_electron, directory) => { process.env.WORLDLINEBOX_E2E_DSH_DIRECTORY = directory; }, path.join(fixture.root, 'manager/runtimes', item.id, 'program'));
      await complete(page, { type: 'runtime.import', sourceKind: 'directory' });
    }
    await complete(page, { type: 'network.save', settings: { proxyMode: 'direct', proxyUrl: '', proxyProfiles: [], npmRegistry: 'https://registry.npmjs.org', npmDownloadRoute:'registry', pythonIndex: 'https://pypi.org/simple', githubMirror: 'direct', githubMirrorUrl: '' } });
    const runtimes = (await state(page)).runtimes;
    const rc = runtimes.find(item => item.version === '0.2.0-rc.2')!;
    const alpha = runtimes.find(item => item.version === '0.2.1-alpha.2')!;
    for (const [name, runtimeId] of [['插件验收 A', rc.id], ['插件验收 B', rc.id], ['新版验收 C', alpha.id]]) await complete(page, { type: 'instance.create', name: name!, runtimeId: runtimeId! });
    const instances = (await state(page)).instances;
    const a = instances.find(item => item.name === '插件验收 A')!;
    const b = instances.find(item => item.name === '插件验收 B')!;
    const c = instances.find(item => item.name === '新版验收 C')!;
    await complete(page, { type: 'cli.select', instanceId: a.id });
    const bBefore = await inventoryTree(b.homePath); const cBefore = await inventoryTree(c.homePath);
    receipt.instances = [a, b, c].map(item => ({ id: item.id, name: item.name, runtimeId: item.runtimeId, homePath: item.homePath, agentsPath: item.agentsPath }));
    await page.locator('.launcher-navigation').getByRole('button', { name: '插件市场', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索目录', exact: true }).fill(pluginName);
    const entry = page.locator(`[data-market-entry="${pluginEntry.id}"]`); await expect(entry).toBeVisible();
    console.info(`REAL_PLUGIN_AUDIT installing ${pluginName}@${version} via the actual market button`);
    await entry.getByRole('button', { name: '安装到实例', exact: true }).click();
    await expect.poll(async () => {
      const operations = (await state(page)).operations.filter(item => ['market.plugin.install', 'instance.plugin'].includes(item.kind) && item.instanceId === a.id);
      if (operations[0]?.status === 'failed') throw new Error(operations[0].error);
      return operations[0]?.status;
    }, { timeout: 600_000 }).toBe('succeeded');
    const profile = path.join(a.homePath, 'profiles/web');
    const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies[pluginName]).toBe(version);
    const modulePath = await realpath(path.join(profile, 'node_modules', pluginName));
    expect(path.relative(profile, modulePath).startsWith('..')).toBe(false);
    expect((await inventoryTree(b.homePath)).contentSha256).toBe(bBefore.contentSha256);
    expect((await inventoryTree(c.homePath)).contentSha256).toBe(cBefore.contentSha256);
    const lists = await Promise.all([a, b, c].map(item => request(page, { type: 'instance.plugins', instanceId: item.id })));
    expect(lists[0]).toMatchObject({ ok: true, installedPlugins: expect.arrayContaining([expect.objectContaining({ name: pluginName, version, enabled: true })]) });
    for (const neighbour of lists.slice(1)) expect(neighbour.ok && neighbour.installedPlugins?.some(item => item.name === pluginName)).toBe(false);
    receipt.privateDependency = { modulePath, lockfile: path.join(profile, 'pnpm-lock.yaml'), manifestSha256: createHash('sha256').update(await readFile(path.join(profile, 'package.json'))).digest('hex') };
    receipt.neighbourHashesUnchanged = true;
    await page.getByRole('button', { name: '本实例插件', exact: true }).click();
    const installed = page.getByRole('dialog', { name: '本实例插件', exact: true });
    await expect(installed.locator(`[data-installed-plugin="${pluginName}"]`)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('real-installed-plugin.png') });
    await page.keyboard.press('Escape');

    // Native DSH windows must request the community client's actual module only
    // for A. No fake launcher response or fake WebUI is used in this test.
    await complete(page, { type: 'instance.start', instanceId: a.id });
    let workbench = application.windows().find(window => window !== page)!;
    await expect(workbench.locator('body')).toContainText(/DeepSeek|deepseek|HARNESS/);
    receipt.nativeResourceUrls = await workbench.evaluate(() => performance.getEntriesByType('resource').map(item => item.name));
    const loadedA = await workbench.evaluate(() => performance.getEntriesByType('resource').map(item => item.name).filter(name => name.includes('dsh-favicon-status')));
    expect(loadedA.length).toBeGreaterThan(0); receipt.nativeClientResources = loadedA;
    await complete(page, { type: 'instance.stop', instanceId: a.id });
    await complete(page, { type: 'instance.start', instanceId: b.id });
    workbench = application.windows().find(window => window !== page)!;
    await expect(workbench.locator('body')).toContainText(/DeepSeek|deepseek|HARNESS/);
    expect(await workbench.evaluate(() => performance.getEntriesByType('resource').some(item => item.name.includes('dsh-favicon-status')))).toBe(false);
    await complete(page, { type: 'instance.stop', instanceId: b.id });
    await complete(page, { type: 'instance.plugin-toggle', instanceId: a.id, name: pluginName, enabled: false });
    expect(await request(page, { type: 'instance.plugins', instanceId: a.id })).toMatchObject({ ok: true, installedPlugins: expect.arrayContaining([expect.objectContaining({ name: pluginName, enabled: false })]) });
    await complete(page, { type: 'instance.plugin-toggle', instanceId: a.id, name: pluginName, enabled: true });
    await complete(page, { type: 'instance.plugin', instanceId: a.id, action: 'remove', spec: pluginName });
    const afterRemoval = await request(page, { type: 'instance.plugins', instanceId: a.id });
    expect(afterRemoval.ok && afterRemoval.installedPlugins?.some(item => item.name === pluginName)).toBe(false);
    for (const runtime of runtimes) await complete(page, { type: 'runtime.verify', runtimeId: runtime.id });
    receipt.runtimeSealsStillValid = true; receipt.toggleAndRemove = true;
    await complete(page, { type: 'cli.select', instanceId: c.id }); await complete(page, { type: 'terminal.open', instanceId: c.id });
    const terminalId = (await state(page)).cli!.activeTerminalId!;
    await complete(page, { type: 'terminal.input', terminalId, text: 'dsh --version\r' });
    await expect.poll(async () => (await state(page)).cli!.output, { timeout: 60_000 }).toContain('0.2.1-alpha.2');
    await complete(page, { type: 'terminal.close', terminalId });
    await complete(page, { type: 'terminal.remove', terminalId });
    await expect.poll(async () => (await state(page)).cli!.terminals?.length).toBe(0);
    receipt.realCliVersionAndClose = true; receipt.status = 'passed';
    console.info('REAL_PLUGIN_AUDIT installation, native loading, neighbour isolation, enable/disable/remove, immutable runtimes and real terminal close passed');
  } catch (cause) {
    receipt.status = 'failed'; receipt.error = cause instanceof Error ? cause.message : String(cause); throw cause;
  } finally {
    await application.close(); await removeProfile(root, parent); receipt.temporaryProfileRemoved = true;
    await writeFile('.tools/dsh-research/plugin-real-audit.json', JSON.stringify(receipt, null, 2));
  }
});
