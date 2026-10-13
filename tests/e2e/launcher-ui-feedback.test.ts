import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshLauncherRequest, DshLauncherState } from '../../src/shared/dsh-launcher';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function removeProfile(root: string, parent: string) {
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('worldlinebox-feedback-ui-')) throw new Error('Unexpected test profile');
  await rm(resolved, { recursive: true, force: true });
}

test('terminal close is visible, background selection stays responsive, workflows do not reflow, and the LLM store is global', async () => {
  test.setTimeout(120_000);
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'worldlinebox-feedback-ui-'));
  const userData = path.join(root, 'user-data'); await mkdir(userData);
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: userData }) });
  try {
    const page = await application.firstWindow();
    const native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.hide(); });
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    // Only launcher requests use a UI fixture. LLM configuration and encryption
    // below go through the real Main handlers, with no open asset library.
    const fixture: DshLauncherState = { supported: true, rootPath: path.join(userData, 'dsh-launcher'), runtimes: [{ id: 'runtime-a', version: '0.2.1-alpha.2', adapter: 'node-cli-web-v1', nodeVersion: '24.15.0', platform: 'win32-x64', source: 'official', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), fileCount: 1, byteLength: 1, installedAt: '' }],
      instances: ['a', 'b'].map(id => ({ id: `instance-${id}`, name: `环境 ${id.toUpperCase()}`, runtimeId: 'runtime-a', profile: 'web', status: 'stopped', createdAt: '', updatedAt: '', isDefault: id === 'a', homePath: '', agentsPath: '', workspacePath: '', browserPartition: `persist:fixture-${id}` })), snapshots: [], packs: [], operations: [],
      cli: { selectedInstanceId: 'instance-a', activeTerminalId: 'terminal-a', commandPath: '', binPath: '', pathEnabled: false, output: '', terminals: ['a', 'b'].map(id => ({ id: `terminal-${id}`, instanceId: `instance-${id}`, runtimeVersion: '0.2.1-alpha.2', status: 'running', transport: 'conpty', cwd: 'C:\\fixture', cols: 80, rows: 24, output: 'PS> ', outputOffset: 0, outputRevision: 0 })) },
      marketplace: { skills: { kind: 'skill', query: '', page: 1, pageSize: 24, total: 2, fetchedAt: new Date().toISOString(), stale: false,
        entries: ['find-skills', 'pdf'].map(id => ({ kind: 'skill', id, name: id, repository: 'fixture-owner/skills', sourceUrl: 'https://github.com/fixture-owner/skills', description: 'UI acceptance fixture', category: 'skill', stars: 0, downloads: 1, riskLabels: [] })) } } };
    await application.evaluate(({ ipcMain, BrowserWindow }, value) => {
      const runtime = { state: value, calls: [] as DshLauncherRequest[] };
      (globalThis as typeof globalThis & { feedbackFixture?: typeof runtime }).feedbackFixture = runtime;
      const emit = () => BrowserWindow.getAllWindows()[0]?.webContents.send('worldlinebox:dsh-launcher:changed', runtime.state);
      ipcMain.removeHandler('worldlinebox:dsh-launcher');
      ipcMain.handle('worldlinebox:dsh-launcher', async (_event, input: DshLauncherRequest) => {
        runtime.calls.push(input);
        if (input.type === 'cli.select') { await new Promise(resolve => setTimeout(resolve, 900)); runtime.state.cli!.selectedInstanceId = input.instanceId; emit(); }
        if (input.type === 'market.search') return { ok: true, marketPage: runtime.state.marketplace!.skills };
        if (input.type === 'skill.list') return { ok: true, installedSkills: [] };
        if (input.type === 'skill.inspect') { await new Promise(resolve => setTimeout(resolve, 700)); return { ok: true, skillInspection: { repository: 'fixture-owner/skills', commit: 'a'.repeat(40), archiveUrl: 'https://example.com/archive.zip', archiveSha256: 'b'.repeat(64), targets: [{ name: 'pdf', description: 'Read PDFs', repository: 'fixture-owner/skills', commit: 'a'.repeat(40), archiveUrl: 'https://example.com/archive.zip', archiveSha256: 'b'.repeat(64), sourcePath: 'skills/pdf' }] } }; }
        if (input.type === 'terminal.close') { const terminal = runtime.state.cli!.terminals!.find(item => item.id === input.terminalId)!; terminal.status = 'stopped'; emit(); }
        if (input.type === 'terminal.remove') { runtime.state.cli!.terminals = runtime.state.cli!.terminals!.filter(item => item.id !== input.terminalId); runtime.state.cli!.activeTerminalId = runtime.state.cli!.terminals[0]?.id; emit(); }
        return { ok: true, state: runtime.state };
      });
      emit();
    }, fixture);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.locator('[data-dsh-instance="instance-b"]')).toBeVisible();
    await page.locator('[data-dsh-instance="instance-b"]').click();
    await expect(page.locator('.launcher-instance-details h1')).toHaveText('环境 B');
    await expect(page.getByRole('button', { name: '启动实例', exact: true })).toBeEnabled();
    await page.locator('.launcher-navigation').getByRole('button', { name: '实时终端', exact: true }).click();
    await expect(page.getByRole('button', { name: '关闭终端：环境 A', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: '关闭终端：环境 A', exact: true }).click();
    await expect(page.getByRole('tab', { name: '环境 A', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '环境 B', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('terminal-close-tabs.png') });

    await page.locator('.launcher-navigation').getByRole('button', { name: '技能市场', exact: true }).click();
    const grid = page.locator('.launcher-market-grid'); await expect(grid).toBeVisible();
    const before = await grid.boundingBox();
    await page.getByRole('button', { name: '查看技能', exact: true }).first().click();
    const drawer = page.getByRole('dialog', { name: '选择仓库内的技能', exact: true });
    await expect(drawer).toBeVisible();
    expect(await grid.boundingBox()).toEqual(before);
    await expect(drawer.getByRole('button', { name: '安装技能', exact: true })).toBeVisible();
    expect(await grid.boundingBox()).toEqual(before);
    await page.screenshot({ path: test.info().outputPath('skill-drawer.png') });
    await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0);
    expect(await grid.boundingBox()).toEqual(before);

    const defaults = await page.evaluate(() => (window as unknown as { worldlinebox: { llm: WorldlineBoxLlmApi } }).worldlinebox.llm.getConfig());
    expect(defaults).toMatchObject({ ok: true, value: { apiFormat: 'openai_chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', hasKey: false } });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
    await settings.getByRole('tab', { name: '全局模型', exact: true }).click();
    await expect(settings.locator('#ai-config-api-format')).toHaveValue('openai_chat');
    await expect(settings.locator('#ai-config-base-url')).toHaveValue('https://api.deepseek.com');
    await expect(settings.locator('#ai-config-model')).toHaveValue('deepseek-flash');
    await settings.getByRole('button', { name: '选择模型', exact: true }).click();
    await expect(page.getByRole('option', { name: 'deepseek-v4-pro', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.screenshot({ path: test.info().outputPath('global-model-settings.png') });
    await page.keyboard.press('Escape');
    // Test key is deliberately invalid and is never sent to an upstream model.
    const saved = await page.evaluate(() => (window as unknown as { worldlinebox: { llm: WorldlineBoxLlmApi } }).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'local-ui-fixture-key-never-send' }));
    expect(saved.ok).toBe(true);
    const json = await readFile(path.join(userData, 'ai-config.json'), 'utf8');
    expect(JSON.parse(json)).toMatchObject({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
    expect(json).not.toContain('local-ui-fixture-key-never-send');
    const cipher = await readFile(path.join(userData, 'ai-key.enc'));
    expect(cipher.includes(Buffer.from('local-ui-fixture-key-never-send'))).toBe(false);
  } finally { await application.close(); await removeProfile(root, parent); }
});
