import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshLauncherRequest, DshLauncherState, DshRuntime, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function request(page: Page, input: DshLauncherRequest) {
  return page.evaluate(value => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(value), input);
}
async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' }); if (!result.ok || !result.state) throw Error(result.ok ? 'Missing launcher state' : result.error); return result.state;
}
async function complete(page: Page, input: DshLauncherRequest) {
  const response = await request(page, input); if (!response.ok) throw Error(response.error);
  if (response.operationId) {
    try { await expect.poll(async () => (await state(page)).operations.find(value => value.id === response.operationId)?.status, { timeout: 600000 }).not.toBe('running'); }
    catch { const operation = (await state(page)).operations.find(value => value.id === response.operationId); throw Error(`Native operation did not finish: ${JSON.stringify(operation)}`); }
    const operation = (await state(page)).operations.find(value => value.id === response.operationId)!; expect(operation.status, operation.error).toBe('succeeded');
  }
}
async function rpc(page: Page, method: string, args: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async input => {
    const response = await fetch(`/api/${input.method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: input.method, payload: { args: input.args } }) });
    const result = await response.json(); if (!result.result.ok) throw Error(result.result.error?.code ?? 'Native RPC failed'); return result.result.value;
  }, { method, args });
}

test('official native workbench reopens without restarting its Host, saves keys and uses the replacement key after restart', async () => {
  test.setTimeout(900000); test.skip(process.platform !== 'win32');
  const manager = process.env.WORLDLINEBOX_DSH_AUTH_MANAGER ?? path.resolve('.tools/dsh-native-node/manager'); test.skip(!existsSync(path.join(manager, 'runtimes.json')));
  const version = process.env.WORLDLINEBOX_DSH_AUTH_VERSION ?? '0.2.1-alpha.3';
  const source = (JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as DshRuntime[]).find(runtime => runtime.version === version);
  test.skip(!source, 'Install the selected official fixture before native authentication acceptance.');
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-native-auth-'));
  const key = 'worldlinebox-synthetic-api-key'; const replacement = 'worldlinebox-replaced-synthetic-api-key'; let requests = 0; let credentialMatched = false;
  const credentialsSeen: unknown[] = [];
  const server = createServer((incoming, response) => {
    requests++; credentialMatched ||= incoming.headers['x-api-key'] === replacement; credentialsSeen.push(incoming.headers['x-api-key']);
    incoming.resume(); response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'WorldlineBox synthetic local endpoint; no real account or inference.' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  const packaged = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;
  const application = await electron.launch({ executablePath: packaged ?? resolveElectronExecutablePath(), args: packaged ? [] : [resolveElectronAppPath()], env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile'), WORLDLINEBOX_E2E_DSH_DIRECTORY: path.join(manager, 'runtimes', source!.id, 'program') }) });
  try {
    const page = await application.firstWindow(); await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await complete(page, { type: 'runtime.import', sourceKind: 'directory' });
    const runtime = (await state(page)).runtimes[0]!; expect(runtime.compatibility?.status).toBe('passed');
    await complete(page, { type: 'instance.create', runtimeId: runtime.id, name: 'Native authentication acceptance', dataScope: 'shared' });
    const instance = (await state(page)).instances[0]!; await complete(page, { type: 'instance.start', instanceId: instance.id });
    let workbench = application.windows().find(window => window !== page)!;
    const running = (await state(page)).instances.find(value => value.id === instance.id)!;
    await workbench.close(); await expect.poll(() => application.windows().length).toBe(1);
    expect((await state(page)).instances.find(value => value.id === instance.id)).toMatchObject({ status: 'running', pid: running.pid, port: running.port });
    await page.locator(`[data-dsh-instance="${instance.id}"]`).click();
    await expect(page.locator('[data-dsh-open-workbench]')).toHaveText('打开 / 返回工作台');
    await page.locator('[data-dsh-open-workbench]').dblclick();
    await expect.poll(() => application.windows().length).toBe(2);
    workbench = application.windows().find(window => window !== page)!;
    expect((await state(page)).instances.find(value => value.id === instance.id)).toMatchObject({ status: 'running', pid: running.pid, port: running.port });
    await page.screenshot({ path: path.resolve('.tools/test-output/verified-reopen-native-workbench.png') });
    await workbench.getByRole('button', { name: '继续', exact: true }).click();
    await workbench.getByRole('button', { name: '添加 API Key', exact: true }).click();
    const save = workbench.getByRole('button', { name: '保存并继续', exact: true }); await expect(save).toBeDisabled();
    await workbench.getByPlaceholder('输入 API 密钥', { exact: true }).fill(key); await expect(save).toBeEnabled(); await save.click(); await expect(save).toHaveCount(0);
    await expect(workbench.getByRole('button', { name: /DeepSeek-V4.1-Flash/ })).toBeVisible();
    const common = (await state(page)).sharedData!; expect(await readFile(common.credentialsPath, 'utf8')).toContain(key);
    // Only fail the account-login attempt; credential saves use the actual Host.
    await workbench.route('**/api/account/startSignIn', async route => {
      const input = route.request().postDataJSON(); await route.fulfill({ json: { type: 'server-response', rpcId: input.rpcId, result: { ok: false, error: { code: 'synthetic-login-failure', message: 'Synthetic offline account flow.' } } } });
    });
    await workbench.getByRole('button', { name: '账号菜单', exact: true }).click(); await workbench.getByRole('menuitem', { name: '登录', exact: true }).click();
    await workbench.getByRole('button', { name: '添加 API Key', exact: true }).click();
    await workbench.getByPlaceholder('输入 API 密钥', { exact: true }).fill(replacement); await save.click(); await expect(save).toHaveCount(0);
    await expect.poll(async () => (await readFile(common.credentialsPath, 'utf8')).includes(replacement), { timeout: 10000 }).toBe(true);
    const settings = await rpc(workbench, 'settings/describe', {}) as { namespaces: Array<{ ns: string; revision: number }> };
    const namespace = settings.namespaces.find(value => value.ns === 'llm-deepseek')!;
    await rpc(workbench, 'settings/mutate', { ns: namespace.ns, expectedRevision: namespace.revision, ops: [{ op: 'set', path: ['baseURL'], value: `http://127.0.0.1:${port}/v1` }] });
    await complete(page, { type: 'instance.stop', instanceId: instance.id });
    await complete(page, { type: 'instance.start', instanceId: instance.id }); workbench = application.windows().find(window => window !== page)!;
    await expect(workbench.getByRole('button', { name: /DeepSeek-V4.1-Flash/ })).toBeVisible(); await expect(workbench.getByRole('button', { name: '添加 API Key', exact: true })).toHaveCount(0);
    const workspace = await rpc(workbench, 'workspace/create', { request: { path: common.workspacePath } }) as { workspace: { workspaceId: string } };
    const conversation = await rpc(workbench, 'session/create', { request: { workspaceId: workspace.workspace.workspaceId } }) as { sessionId: string };
    await rpc(workbench, 'session/prompt', { request: { sessionId: conversation.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Synthetic authentication acceptance; use only the local fixture endpoint.' }] } });
    await expect.poll(() => requests, { timeout: 30000 }).toBeGreaterThan(0); expect(credentialMatched).toBe(true);
    await complete(page, { type: 'instance.stop', instanceId: instance.id });
    const beforeCli = requests;
    const task = await request(page, { type: 'task.run', prompt: 'Use the selected native profile with the local synthetic endpoint.', title: 'Native saved configuration acceptance', timeoutMs: 60000 });
    expect(task.ok && task.operationId).toBeTruthy();
    if (!task.ok || !task.operationId) throw Error('CLI task was not admitted');
    await expect.poll(() => requests, { timeout: 45000 }).toBeGreaterThan(beforeCli);
    expect(credentialsSeen.slice(beforeCli).every(value => value === replacement)).toBe(true);
    expect((await state(page)).tasks?.find(value => value.id === task.operationId)?.instanceId).toBe(instance.id);
    expect((await state(page)).instances.every(value => value.status === 'stopped')).toBe(true);
    expect(application.windows()).toHaveLength(1);
    await expect.poll(async () => (await state(page)).operations.find(value => value.id === task.operationId)?.status, { timeout: 30000 }).not.toBe('running');
  } finally {
    await application.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-native-auth-')) await rm(root, { recursive: true, force: true });
  }
});
