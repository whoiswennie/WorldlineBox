import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { DshLauncherRequest, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function request(page: Page, input: DshLauncherRequest) {
  return page.evaluate(value => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(value), input);
}
async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' }); if (!result.ok || !result.state) throw Error(result.ok ? 'No launcher state' : result.error); return result.state;
}
async function complete(page: Page, input: DshLauncherRequest, expected = 'succeeded') {
  const result = await request(page, input); if (!result.ok) throw Error(result.error);
  if (result.operationId) {
    await expect.poll(async () => (await state(page)).operations.find(value => value.id === result.operationId)?.status, { timeout: 600_000 }).not.toBe('running');
    const operation = (await state(page)).operations.find(value => value.id === result.operationId)!;
    expect(operation.status, operation.error).toBe(expected); return operation;
  }
}
async function nativeRpc(page: Page, method: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async input => {
    const response = await fetch(`/api/${input.method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: input.method, payload: { args: input.args } }) });
    const result = await response.json(); if (!result.result.ok) throw Error(result.result.error?.code ?? 'Native RPC failed'); return result.result.value;
  }, { method, args });
}
test('real npm WebUI versions, one Host, live CLI selection, private packs and an offline full restore work through the application', async () => {
  test.setTimeout(900_000);
  test.skip(process.platform !== 'win32', 'Windows native acceptance.');
  const fixtureFile = process.env.WORLDLINEBOX_DSH_NODE_FIXTURE ?? path.resolve('.tools/dsh-native-node/result.json');
  test.skip(!existsSync(fixtureFile), 'Run the official two-release installer probe first.');
  const sources = JSON.parse(readFileSync(fixtureFile, 'utf8')) as { root: string; runtimes: Array<{ id: string; version: string }> };
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-dsh-webui-e2e-'));
  const userData = path.join(root, 'profile'); const backup = path.join(root, 'complete.dshbackup'); const packFile = path.join(root, 'public.dshpack');
  const minimalPath = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`;
  const env = electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: userData, PATH: minimalPath });
  let application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env });
  try {
    let page = await application.firstWindow(); await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await (await application.browserWindow(page)).evaluate(window => window.hide());
    for (const source of sources.runtimes) {
      const directory = path.join(sources.root, 'manager', 'runtimes', source.id, 'program');
      await application.evaluate((_electron, value) => { process.env.WORLDLINEBOX_E2E_DSH_DIRECTORY = value; }, directory);
      await complete(page, { type: 'runtime.import', sourceKind: 'directory' });
    }
    const runtimes = (await state(page)).runtimes;
    expect(runtimes.map(value => value.version).sort()).toEqual(['0.2.0-rc.2', '0.2.1-alpha.2']);
    expect(runtimes.every(value => value.adapter === 'node-cli-web-v1' && value.npmIntegrity && value.dependencyLockSha256)).toBe(true);
    for (const runtime of runtimes) await complete(page, { type: 'instance.create', runtimeId: runtime.id, name: `Web ${runtime.version}` });
    const a = (await state(page)).instances.find(value => value.name === 'Web 0.2.0-rc.2')!;
    const b = (await state(page)).instances.find(value => value.name === 'Web 0.2.1-alpha.2')!;
    expect(a).not.toHaveProperty('dataScope'); expect(b).not.toHaveProperty('dataScope');
    await writeFile(path.join(a.homePath, '.credentials.yaml'), 'version: 1\nrefs: {WORLDLINE_FIXTURE_KEY: fixture-placeholder}\nrecords: {}\n');
    await complete(page, { type: 'cli.select', instanceId: a.id });
    await complete(page, { type: 'terminal.open' });
    const firstTerminal = (await state(page)).cli!.activeTerminalId!;
    await complete(page, { type: 'terminal.input', terminalId: firstTerminal, text: "Write-Output ('NATIVE_VERSION='+(dsh --version)); python -B --version; git --version; ffmpeg -version\r" });
    await expect.poll(async () => (await state(page)).cli!.output, { timeout: 60_000 }).toContain('NATIVE_VERSION=0.2.0-rc.2');
    await expect.poll(async () => (await state(page)).cli!.output, { timeout: 60_000 }).toContain('Python 3.13.12');
    await expect.poll(async () => (await state(page)).cli!.output, { timeout: 60_000 }).toContain('git version 2.48.1');
    await expect.poll(async () => (await state(page)).cli!.output, { timeout: 60_000 }).toContain('ffmpeg version 8.0.1');
    await complete(page, { type: 'cli.select', instanceId: b.id });
    expect((await state(page)).instances.every(value => value.status === 'stopped')).toBe(true);
    expect((await state(page)).cli!.terminals!.find(value => value.id === firstTerminal)?.instanceId).toBe(a.id);
    await complete(page, { type: 'terminal.open' }); const secondTerminal = (await state(page)).cli!.activeTerminalId!;
    await complete(page, { type: 'terminal.input', terminalId: secondTerminal, text: "Write-Output ('NATIVE_VERSION='+(dsh --version))\r" });
    await expect.poll(async () => (await state(page)).cli!.output, { timeout: 60_000 }).toContain('NATIVE_VERSION=0.2.1-alpha.2');
    for (const id of [firstTerminal, secondTerminal]) await complete(page, { type: 'terminal.close', terminalId: id });
    await complete(page, { type: 'instance.start', instanceId: a.id });
    let workbench = application.windows().find(window => window !== page)!;
    expect(await workbench.evaluate(() => 'worldlinebox' in window)).toBe(false);
    await workbench.getByRole('button', { name: '继续', exact: true }).click();
    await expect(workbench.getByText('预览版说明', { exact: true })).toHaveCount(0);
    const common = (await state(page)).sharedData!;
    const workspace = await nativeRpc(workbench, 'workspace/create', { request: { path: common.workspacePath } }) as { workspace: { workspaceId: string } };
    const conversation = await nativeRpc(workbench, 'session/create', { request: { workspaceId: workspace.workspace.workspaceId } }) as { sessionId: string };
    await nativeRpc(workbench, 'session/prompt', { request: { sessionId: conversation.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: '离线测试，不存在模型账号。' }] } });
    await expect.poll(async () => ((await nativeRpc(workbench, 'session/list', { _request: {} })) as { items: Array<{ sessionId: string; blank: boolean }> }).items.find(value => value.sessionId === conversation.sessionId)?.blank).toBe(false);
    await nativeRpc(workbench, 'session/rename', { request: { sessionId: conversation.sessionId, title: '跨官方版本共享存档' } });
    const blocked = await complete(page, { type: 'instance.start', instanceId: b.id }, 'failed'); expect(blocked?.error).toContain('Only one DSH WebUI');
    await complete(page, { type: 'instance.switch-start', instanceId: b.id });
    expect((await state(page)).instances.filter(value => value.status === 'running')).toHaveLength(1);
    expect((await state(page)).cli?.selectedInstanceId).toBe(b.id);
    workbench = application.windows().find(window => window !== page)!;
    await workbench.getByRole('button', { name: '继续', exact: true }).click();
    await expect(workbench.getByText('跨官方版本共享存档', { exact: true })).toBeVisible({ timeout: 25_000 });
    expect(await readFile(common.credentialsPath, 'utf8')).toContain('fixture-placeholder');
    await complete(page, { type: 'instance.stop', instanceId: b.id });
    const task = await complete(page, { type: 'task.run', prompt: '离线验证任务绑定，当前不存在模型账号。', title: 'Native task binding probe', timeoutMs: 20_000 }, 'failed');
    const taskRecord = (await state(page)).tasks!.find(value => value.id === task!.id)!;
    expect(taskRecord.instanceId).toBe(b.id); expect(taskRecord.runtimeVersion).toBe('0.2.1-alpha.2');
    const taskResult = await request(page, { type: 'task.result', taskId: task!.id });
    expect(taskResult.ok && taskResult.taskResult?.instanceId).toBe(b.id);
    await writeFile(path.join(common.workspacePath, 'save.txt'), 'common save');
    await mkdir(path.join(a.agentsPath, 'skills', 'fixture-skill'), { recursive: true });
    await writeFile(path.join(a.agentsPath, 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: private fixture\n---\nPrivate pack skill.');
    await complete(page, { type: 'pack.create', instanceId: a.id, name: '官方 RC 创作包', version: '1.0.0' });
    const pack = (await state(page)).packs[0]!;
    for (const name of ['Pack copy 1', 'Pack copy 2']) await complete(page, { type: 'pack.install', packId: pack.id, name });
    const copies = (await state(page)).instances.filter(value => value.name.startsWith('Pack copy'));
    expect(copies).toHaveLength(2); expect(copies[0]!.homePath).not.toBe(copies[1]!.homePath);
    for (const copy of copies) expect(existsSync(path.join(copy.agentsPath, 'skills', 'fixture-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(b.agentsPath, 'skills', 'fixture-skill', 'SKILL.md'))).toBe(false);
    await application.evaluate((_electron, values) => { process.env.WORLDLINEBOX_E2E_DSH_SAVE_DSHPACK = values.packFile; process.env.WORLDLINEBOX_E2E_DSH_SAVE_DSHBACKUP = values.backup; }, { packFile, backup });
    await complete(page, { type: 'pack.distribute', packId: pack.id, downloadUrl: 'https://example.invalid/public.dshpack' });
    const manifest = JSON.parse(await readFile(`${packFile}.manifest.json`, 'utf8'));
    expect(manifest.format).toBe('worldlinebox-dshpack-distribution-v2'); expect(manifest.runtime.dependencyLockSha256).toBe(runtimes.find(value => value.id === a.runtimeId)!.dependencyLockSha256);
    expect(manifest.lock.files.every((file: { path: string }) => !/credentials|sessions|model-settings/.test(file.path))).toBe(true);
    await complete(page, { type: 'backup.export', instanceId: a.id });
    await application.close();
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: { ...env, WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'offline'), WORLDLINEBOX_E2E_DSH_ARCHIVE: backup } });
    page = await application.firstWindow(); await (await application.browserWindow(page)).evaluate(window => window.hide());
    await complete(page, { type: 'backup.import', name: 'Offline restored WebUI' });
    const restored = await state(page); expect(restored.runtimes).toHaveLength(1); expect(restored.runtimes[0]!.adapter).toBe('node-cli-web-v1');
    expect(await readFile(path.join(restored.sharedData!.workspacePath, 'save.txt'), 'utf8')).toBe('common save');
    expect(await readFile(restored.sharedData!.credentialsPath, 'utf8')).toContain('fixture-placeholder');
    await complete(page, { type: 'instance.start', instanceId: restored.instances[0]!.id });
    await complete(page, { type: 'instance.stop', instanceId: restored.instances[0]!.id });
  } finally {
    await application.close();
    if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-dsh-webui-e2e-')) await rm(root, { recursive: true, force: true });
  }
});
