import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshLauncherRequest, DshLauncherResponse, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function request(page: Page, input: DshLauncherRequest): Promise<DshLauncherResponse> {
  return page.evaluate(async value => {
    const bridge = (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher;
    return bridge.request(value);
  }, input);
}
async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' });
  if (!result.ok || !result.state) throw new Error(!result.ok ? result.error : 'Missing launcher state.');
  return result.state;
}
async function complete(page: Page, input: DshLauncherRequest): Promise<DshLauncherState> {
  const result = await request(page, input);
  if (!result.ok) throw new Error(result.error);
  if (result.operationId) {
    await expect.poll(async () => (await state(page)).operations.find(op => op.id === result.operationId)?.status, { timeout: 240_000 }).not.toBe('running');
    const operation = (await state(page)).operations.find(op => op.id === result.operationId);
    if (operation?.status !== 'succeeded') throw new Error(operation?.error ?? `Unexpected operation ${operation?.status}`);
  }
  return state(page);
}
async function nativeRpc(workbench: Page, method: string, args: Record<string, unknown>): Promise<unknown> {
  return workbench.evaluate(async input => {
    const rpcId = crypto.randomUUID();
    const response = await fetch(`/api/${input.method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: input.method, payload: { args: input.args } }) });
    const result = await response.json() as { result: { ok: boolean; value?: unknown; error?: { code?: string } } };
    if (!result.result.ok) throw new Error(result.result.error?.code ?? 'Native RPC rejected');
    return result.result.value;
  }, { method, args });
}

test('official CLI switches private environments without starting a Host and keeps canonical shared cwd', async () => {
  test.setTimeout(180_000);
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'Official adapter is Windows x64.');
  const source = process.env.WORLDLINEBOX_DSH_TEST_RUNTIME ?? path.resolve('.tools/dsh-research/extracted');
  test.skip(!existsSync(path.join(source, 'DeepSeek Harness.exe')), 'A real official runtime is required.');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-dsh-cli-e2e-'));
  // Reproduce a Windows path alias without changing the physical directory name.
  await mkdir(path.join(root, 'user-data'));
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'USER-DATA'), WORLDLINEBOX_E2E_DSH_DIRECTORY: source,
    NPM_CONFIG_CACHE: 'C:\\foreign-cache', PNPM_CONFIG_STORE_DIR: 'C:\\foreign-store', OPENAI_API_KEY: 'fixture-must-not-inherit',
  }) });
  try {
    const page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher] .launcher-titlebar-heading')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(win => win.hide());
    await complete(page, { type: 'runtime.import', sourceKind: 'directory' });
    const runtime = (await state(page)).runtimes[0]!;
    for (const name of ['CLI A', 'CLI B']) await complete(page, { type: 'instance.create', name, runtimeId: runtime.id });
    for (const instance of (await state(page)).instances) {
      await complete(page, { type: 'cli.select', instanceId: instance.id });
      const selected = await state(page);
      expect(selected.cli?.selectedInstanceId).toBe(instance.id);
      expect(selected.instances.every(value => value.status === 'stopped')).toBe(true);
      expect(selected.sharedData!.workspacePath).toBe(await realpath(selected.sharedData!.workspacePath));
      await complete(page, { type: 'terminal.clear' });
      await complete(page, { type: 'terminal.open' });
      await complete(page, { type: 'terminal.input', text: "[Console]::WriteLine('PROBE_HOME='+$env:DSH_HOME); [Console]::WriteLine('PROBE_CWD='+[Environment]::CurrentDirectory); [Console]::WriteLine('PROBE_CACHE='+$env:npm_config_cache); [Console]::WriteLine('PROBE_SECRET_ABSENT='+[string]::IsNullOrEmpty($env:OPENAI_API_KEY)); dsh --version\r" });
      await expect.poll(async () => (await state(page)).cli?.output.split(/\r?\n/).map(line => line.trim()), { timeout: 45_000 }).toContain('0.2.0-rc.2');
      const output = (await state(page)).cli!.output;
      expect(output).toContain(`PROBE_HOME=${instance.homePath}`);
      expect(output).toContain(`PROBE_CWD=${selected.sharedData!.workspacePath}`);
      expect(output).toContain('PROBE_SECRET_ABSENT=True');
      expect(output).toContain(path.join(path.dirname(instance.homePath), 'cache', 'npm'));
      expect(output).not.toMatch(/foreign-cache|foreign-store|fixture-must-not-inherit/);
      expect((await state(page)).instances.every(value => value.status === 'stopped')).toBe(true);
      await complete(page, { type: 'terminal.close' });
    }
  } finally {
    await application.close();
    if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-dsh-cli-e2e-')) await rm(root, { recursive: true, force: true });
  }
});

test('real official DSH instances share saves and accounts while preserving separate plugins, packs and restore state', async () => {
  test.setTimeout(600_000);
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'Official adapter is Windows x64.');
  const source = process.env.WORLDLINEBOX_DSH_TEST_RUNTIME ?? path.resolve('.tools/dsh-research/extracted');
  test.skip(!existsSync(path.join(source, 'DeepSeek Harness.exe')), 'Set WORLDLINEBOX_DSH_TEST_RUNTIME to a real official unpacked runtime.');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-dsh-e2e-'));
  const environment = electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'user-data'), WORLDLINEBOX_E2E_DSH_DIRECTORY: source });
  let application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: environment });
  try {
    let page = await application.firstWindow();
    await page.locator('[data-application-module="dsh"]').click();
    await expect(page.locator('.launcher-titlebar-heading').getByText('DSH 启动器', { exact: true })).toBeVisible();
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate(win => { win.unmaximize(); win.setSize(1440, 940); win.hide(); });
    await complete(page, { type: 'runtime.import', sourceKind: 'directory' });
    const runtime = (await state(page)).runtimes[0]!;
    expect(runtime.version).toBe('0.2.0-rc.2');
    for (const name of ['工作实例 A', '工作实例 B']) await complete(page, { type: 'instance.create', name, runtimeId: runtime.id });
    const [a, b] = (await state(page)).instances;
    expect(a).toBeDefined(); expect(b).toBeDefined();
    expect(a!.homePath).not.toBe(b!.homePath); expect(a!.agentsPath).not.toBe(b!.agentsPath);
    expect(a!.workspacePath).not.toBe(b!.workspacePath); expect(a!.browserPartition).not.toBe(b!.browserPartition);
    await writeFile(path.join(a!.homePath, 'test-state.json'), '{"owner":"A"}');
    await writeFile(path.join(b!.homePath, 'test-state.json'), '{"owner":"B"}');
    await writeFile(path.join(a!.homePath, '.credentials.yaml'), 'version: 1\nrefs:\n  WORLDLINE_FIXTURE_API_KEY: fixture-placeholder\nrecords: {}\n');
    await mkdir(path.join(a!.agentsPath, 'skills', 'isolated-probe'), { recursive: true });
    await writeFile(path.join(a!.agentsPath, 'skills', 'isolated-probe', 'SKILL.md'), '# A skill\nOnly this instance owns the skill.');
    await complete(page, { type: 'cli.select', instanceId: a!.id });
    expect((await state(page)).instances.every(instance => instance.status === 'stopped')).toBe(true);
    await complete(page, { type: 'terminal.open' });
    await complete(page, { type: 'terminal.input', text: "[Console]::WriteLine('CLI_HOME='+$env:DSH_HOME); dsh --version\r" });
    await expect.poll(async () => (await state(page)).cli?.output, { timeout: 45_000 }).toContain(`CLI_HOME=${a!.homePath}`);
    await expect.poll(async () => (await state(page)).cli?.output.split(/\r?\n/).map(line => line.trim()), { timeout: 45_000 }).toContain('0.2.0-rc.2');
    await complete(page, { type: 'terminal.input', text: 'dsh\r' });
    await expect.poll(async () => (await state(page)).cli?.output, { timeout: 15_000 }).toContain('DSH>');
    await complete(page, { type: 'terminal.input', text: '/new\r' });
    await expect.poll(async () => (await state(page)).cli?.output, { timeout: 15_000 }).toContain('[New session]');
    await complete(page, { type: 'terminal.input', text: '/exit\r' });
    await complete(page, { type: 'terminal.close' });
    await complete(page, { type: 'cli.select', instanceId: b!.id });
    await complete(page, { type: 'terminal.clear' });
    await complete(page, { type: 'terminal.open' });
    await complete(page, { type: 'terminal.input', text: "[Console]::WriteLine('CLI_HOME='+$env:DSH_HOME); dsh --help\r" });
    await expect.poll(async () => (await state(page)).cli?.output, { timeout: 45_000 }).toContain('--session-id');
    expect((await state(page)).cli?.output).toContain(b!.homePath);
    expect((await state(page)).instances.every(instance => instance.status === 'stopped')).toBe(true);
    await complete(page, { type: 'terminal.close' });
    await complete(page, { type: 'instance.start', instanceId: a!.id });
    const running = (await state(page)).instances;
    expect(running.filter(instance => instance.status === 'running')).toHaveLength(1);
    const workbenches = application.windows().filter(window => window !== page);
    expect(workbenches).toHaveLength(1);
    for (const workbench of workbenches) expect(await workbench.evaluate(() => 'worldlinebox' in window)).toBe(false);
    for (const workbench of workbenches) {
      await workbench.getByRole('button', { name: '继续', exact: true }).click();
      await expect(workbench.getByText('预览版说明', { exact: true })).toHaveCount(0);
      await expect(workbench.getByText('暂时无法保存确认状态，请重试。', { exact: true })).toHaveCount(0);
    }
    const common = (await state(page)).sharedData!;
    expect(common.workspacePath).not.toBe(a!.workspacePath);
    expect(await readFile(common.credentialsPath, 'utf8')).toContain('fixture-placeholder');
    await writeFile(path.join(common.workspacePath, 'shared-save.txt'), 'current public save');
    const workspaceA = await nativeRpc(workbenches[0]!, 'workspace/create', { request: { path: common.workspacePath } }) as { workspace: { workspaceId: string } };
    const sharedConversation = await nativeRpc(workbenches[0]!, 'session/create', { request: { workspaceId: workspaceA.workspace.workspaceId } }) as { sessionId: string };
    // Official UI hides other clients' provisional blank rows. Admit a real
    // text task; this fixture has no DeepSeek credential, so auth fails locally
    // before any remote model request and leaves a durable nonblank history.
    await nativeRpc(workbenches[0]!, 'session/prompt', { request: { sessionId: sharedConversation.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: '离线验证共享会话。' }] } });
    await expect.poll(async () => {
      const sessions = await nativeRpc(workbenches[0]!, 'session/list', { _request: {} }) as { items: Array<{ sessionId: string; blank: boolean }> };
      return sessions.items.find(item => item.sessionId === sharedConversation.sessionId)?.blank;
    }, { timeout: 15_000 }).toBe(false);
    await nativeRpc(workbenches[0]!, 'session/rename', { request: { sessionId: sharedConversation.sessionId, title: '跨实例共享会话测试' } });
    const firstSettings = await nativeRpc(workbenches[0]!, 'settings/describe', {}) as { namespaces: Array<{ ns: string; revision: number; user?: Record<string, unknown> }> };
    const providerSettings = firstSettings.namespaces.find(view => view.ns === 'llm-pi-ai')!;
    await nativeRpc(workbenches[0]!, 'settings/mutate', { ns: 'llm-pi-ai', expectedRevision: providerSettings.revision,
      ops: [{ op: 'set', path: ['providers', 'worldline-fixture'], value: { api: 'openai-completions', baseURL: 'https://model-fixture.invalid/v1', apiKeyEnv: 'WORLDLINE_FIXTURE_API_KEY', models: [{ id: 'fixture-model' }] } }] });
    const oldPid = (await state(page)).instances.find(instance => instance.id === a!.id)!.pid;
    await complete(page, { type: 'instance.switch-start', instanceId: b!.id });
    expect((await state(page)).instances.filter(instance => instance.status === 'running')).toHaveLength(1);
    expect((await state(page)).instances.find(instance => instance.id === a!.id)?.status).toBe('stopped');
    expect((await state(page)).cli?.selectedInstanceId).toBe(b!.id);
    const switchedWorkbench = application.windows().find(window => window !== page)!;
    await switchedWorkbench.getByRole('button', { name: '继续', exact: true }).click();
    await expect(switchedWorkbench.getByText('跨实例共享会话测试', { exact: true })).toBeVisible({ timeout: 25_000 });
    expect((await state(page)).instances.find(instance => instance.id === b!.id)?.pid).not.toBe(oldPid);
    const sharedSessions = await nativeRpc(switchedWorkbench, 'session/list', { _request: {} }) as { items: Array<{ sessionId: string; agentAvailable: boolean }> };
    expect(sharedSessions.items.find(item => item.sessionId === sharedConversation.sessionId)?.agentAvailable).toBe(false);
    await expect.poll(async () => {
      const settings = await nativeRpc(switchedWorkbench, 'settings/describe', {}) as typeof firstSettings;
      return Boolean((settings.namespaces.find(view => view.ns === 'llm-pi-ai')?.user?.providers as Record<string, unknown> | undefined)?.['worldline-fixture']);
    }, { timeout: 20_000 }).toBe(true);
    expect((await state(page)).instances.find(instance => instance.id === b!.id)?.status).toBe('running');
    await complete(page, { type: 'instance.stop', instanceId: b!.id });
    await complete(page, { type: 'instance.start', instanceId: b!.id });
    const restartedWorkbench = application.windows().find(window => window !== page)!;
    await expect(restartedWorkbench.getByText('跨实例共享会话测试', { exact: true })).toBeVisible({ timeout: 25_000 });
    await complete(page, { type: 'instance.stop', instanceId: b!.id });
    // An installed plugin tree is data owned by a single profile, just like an instance's mods directory.
    const plugin = path.join(a!.homePath, 'profiles', 'web', 'node_modules', 'worldlinebox-isolation-fixture');
    await mkdir(plugin, { recursive: true });
    await writeFile(path.join(plugin, 'package.json'), '{"name":"worldlinebox-isolation-fixture","version":"1.0.0"}');
    expect(existsSync(path.join(b!.homePath, 'profiles', 'web', 'node_modules', 'worldlinebox-isolation-fixture'))).toBe(false);
    await complete(page, { type: 'instance.plugin', instanceId: a!.id, action: 'list' });
    await complete(page, { type: 'snapshot.create', instanceId: a!.id, name: 'A 原始状态' });
    await writeFile(path.join(a!.homePath, 'test-state.json'), '{"owner":"A-after"}');
    const snapshot = (await state(page)).snapshots[0]!;
    await complete(page, { type: 'snapshot.restore', snapshotId: snapshot.id, name: 'A 恢复副本' });
    expect(await readFile(path.join(common.workspacePath, 'shared-save.txt'), 'utf8')).toBe('current public save');
    const restored = (await state(page)).instances.find(instance => instance.name === 'A 恢复副本')!;
    expect(await readFile(path.join(restored.homePath, 'test-state.json'), 'utf8')).toBe('{"owner":"A"}');
    expect(await readFile(path.join(a!.homePath, 'test-state.json'), 'utf8')).toBe('{"owner":"A-after"}');
    await complete(page, { type: 'instance.clone', instanceId: a!.id, name: 'A 升级候选', runtimeId: runtime.id });
    await complete(page, { type: 'pack.create', instanceId: a!.id, name: '创作整合包', version: '1.0.0' });
    const pack = (await state(page)).packs[0]!;
    await complete(page, { type: 'pack.install', packId: pack.id, name: '创作包副本 1' });
    await complete(page, { type: 'pack.install', packId: pack.id, name: '创作包副本 2' });
    const copies = (await state(page)).instances.filter(instance => instance.name.startsWith('创作包副本'));
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(existsSync(path.join(copy.homePath, 'profiles', 'web', 'node_modules', 'worldlinebox-isolation-fixture', 'package.json'))).toBe(true);
      expect(existsSync(path.join(copy.homePath, 'test-state.json'))).toBe(false);
      expect(existsSync(path.join(copy.homePath, '.credentials.yaml'))).toBe(false);
    }
    await complete(page, { type: 'instance.start', instanceId: copies[0]!.id });
    await complete(page, { type: 'instance.stop', instanceId: copies[0]!.id });
    const packPath = path.join(root, 'creation.dshpack');
    const backupPath = path.join(root, 'instance.dshbackup');
    await application.evaluate((_electron, values) => {
      process.env.WORLDLINEBOX_E2E_DSH_SAVE_DSHPACK = values.packPath;
      process.env.WORLDLINEBOX_E2E_DSH_SAVE_DSHBACKUP = values.backupPath;
      process.env.WORLDLINEBOX_E2E_DSH_ARCHIVE = values.packPath;
    }, { packPath, backupPath });
    await complete(page, { type: 'pack.export', packId: pack.id });
    await complete(page, { type: 'pack.import' });
    await complete(page, { type: 'backup.export', instanceId: a!.id });
    await application.evaluate((_electron, value) => { process.env.WORLDLINEBOX_E2E_DSH_ARCHIVE = value; }, backupPath);
    await complete(page, { type: 'backup.import', name: '完整备份恢复副本' });
    const backupCopy = (await state(page)).instances.find(instance => instance.name === '完整备份恢复副本')!;
    expect(await readFile(path.join(backupCopy.homePath, 'test-state.json'), 'utf8')).toBe('{"owner":"A-after"}');
    await page.getByRole('button', { name: '整合包', exact: true }).click();
    const persisted = await state(page);
    const logs = await request(page, { type: 'instance.logs', instanceId: a!.id });
    expect(logs.ok && logs.text).not.toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?[^[]/);
    await application.close();
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: environment });
    page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher] .launcher-titlebar-heading')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(win => win.hide());
    const reloaded = await state(page);
    expect(reloaded.instances.map(instance => instance.id)).toEqual(persisted.instances.map(instance => instance.id));
    expect(reloaded.packs).toEqual(persisted.packs); expect(reloaded.snapshots).toEqual(persisted.snapshots);
    expect(reloaded.instances.every(instance => instance.status === 'stopped')).toBe(true);
    expect(readFileSync(path.join(b!.homePath, 'test-state.json'), 'utf8')).toBe('{"owner":"B"}');
    await application.close();
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: {
      ...environment, WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'offline-user-data'), WORLDLINEBOX_E2E_DSH_ARCHIVE: backupPath,
    } });
    page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate(win => win.hide());
    await page.locator('[data-application-module="dsh"]').click();
    expect((await state(page)).runtimes).toHaveLength(0);
    const offline = await complete(page, { type: 'backup.import', name: '离线完整恢复' });
    expect(offline.runtimes).toHaveLength(1);
    expect(offline.runtimes[0]!.contentSha256).toBe(runtime.contentSha256);
    expect(offline.instances).toHaveLength(1);
    const offlineInstance = offline.instances[0]!;
    expect(await readFile(path.join(offline.sharedData!.workspacePath, 'shared-save.txt'), 'utf8')).toBe('current public save');
    expect(await readFile(offline.sharedData!.credentialsPath, 'utf8')).toContain('fixture-placeholder');
    expect(await readFile(path.join(offlineInstance.homePath, 'test-state.json'), 'utf8')).toBe('{"owner":"A-after"}');
    await complete(page, { type: 'instance.start', instanceId: offlineInstance.id });
    await complete(page, { type: 'instance.stop', instanceId: offlineInstance.id });
  } finally {
    await application.close();
    if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-dsh-e2e-')) await rm(root, { recursive: true, force: true });
  }
});
