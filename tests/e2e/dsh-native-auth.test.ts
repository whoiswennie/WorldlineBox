import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DshLauncherRequest, DshLauncherState, DshRuntime, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';

async function request(page: Page, input: DshLauncherRequest) {
  return page.evaluate(value => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(value), input);
}
async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' }); if (!result.ok || !result.state) throw Error(result.ok ? 'Missing launcher state' : result.error); return result.state;
}
async function companionRequest(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(value => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true); return result;
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

test('native workbench, migrated companion CLI and a second instance use the same saved configuration and sessions', async () => {
  test.setTimeout(900000); test.skip(process.platform !== 'win32');
  const manager = process.env.WORLDLINEBOX_DSH_AUTH_MANAGER ?? path.resolve('.tools/dsh-native-node/manager'); test.skip(!existsSync(path.join(manager, 'runtimes.json')));
  const version = process.env.WORLDLINEBOX_DSH_AUTH_VERSION ?? '0.2.1-alpha.3';
  const source = (JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as DshRuntime[]).find(runtime => runtime.version === version);
  test.skip(!source, 'Install the selected official fixture before native authentication acceptance.');
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-native-auth-'));
  await seedNativeRuntime(manager, source!, path.join(root, 'profile'));
  const key = 'worldlinebox-synthetic-api-key'; const replacement = 'worldlinebox-replaced-synthetic-api-key'; let requests = 0; let credentialMatched = false;
  const credentialsSeen: unknown[] = []; let serveSuccess = false;
  const finalText = 'NATIVE_INSTANCE_CONFIGURATION_CONFIRMED';
  const server = createServer(async (incoming, response) => {
    requests++; credentialMatched ||= incoming.headers['x-api-key'] === replacement; credentialsSeen.push(incoming.headers['x-api-key']);
    if (!serveSuccess) {
      incoming.resume(); response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'WorldlineBox synthetic local endpoint; no real account or inference.' } })); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; stream?: boolean };
    if (incoming.url?.endsWith('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 5 })); return; }
    const message = { id: 'synthetic-message', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
    if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: finalText } }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  const packaged = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;
  const launch = () => electron.launch({ executablePath: packaged ?? resolveElectronExecutablePath(), args: packaged ? [] : [resolveElectronAppPath()], env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile'), WORLDLINEBOX_E2E_DSH_DIRECTORY: path.join(manager, 'runtimes', source!.id, 'program') }) });
  let application = await launch();
  try {
    let page = await application.firstWindow(); await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await expect.poll(async () => (await state(page)).runtimes[0]?.compatibility?.status, { timeout: 360000 }).toBe('passed');
    const runtime = (await state(page)).runtimes[0]!;
    await complete(page, { type: 'instance.create', runtimeId: runtime.id, name: 'Native authentication acceptance' });
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
    const common = (await state(page)).sharedData!;
    const credentialsPath = common.credentialsPath;
    const workspacePath = common.workspacePath;
    expect(await readFile(credentialsPath, 'utf8')).toContain(key);
    // Only fail the account-login attempt; credential saves use the actual Host.
    await workbench.route('**/api/account/startSignIn', async route => {
      const input = route.request().postDataJSON(); await route.fulfill({ json: { type: 'server-response', rpcId: input.rpcId, result: { ok: false, error: { code: 'synthetic-login-failure', message: 'Synthetic offline account flow.' } } } });
    });
    await workbench.getByRole('button', { name: '账号菜单', exact: true }).click(); await workbench.getByRole('menuitem', { name: '登录', exact: true }).click();
    await workbench.getByRole('button', { name: '添加 API Key', exact: true }).click();
    await workbench.getByPlaceholder('输入 API 密钥', { exact: true }).fill(replacement); await save.click(); await expect(save).toHaveCount(0);
    await expect.poll(async () => (await readFile(credentialsPath, 'utf8')).includes(replacement), { timeout: 10000 }).toBe(true);
    const settings = await rpc(workbench, 'settings/describe', {}) as { namespaces: Array<{ ns: string; revision: number }> };
    const namespace = settings.namespaces.find(value => value.ns === 'llm-deepseek')!;
    await rpc(workbench, 'settings/mutate', { ns: namespace.ns, expectedRevision: namespace.revision, ops: [{ op: 'set', path: ['baseURL'], value: `http://127.0.0.1:${port}/v1` }] });
    await complete(page, { type: 'instance.stop', instanceId: instance.id });
    await complete(page, { type: 'instance.start', instanceId: instance.id }); workbench = application.windows().find(window => window !== page)!;
    await expect(workbench.getByRole('button', { name: /DeepSeek-V4.1-Flash/ })).toBeVisible(); await expect(workbench.getByRole('button', { name: '添加 API Key', exact: true })).toHaveCount(0);
    const workspace = await rpc(workbench, 'workspace/create', { request: { path: workspacePath } }) as { workspace: { workspaceId: string } };
    const conversation = await rpc(workbench, 'session/create', { request: { workspaceId: workspace.workspace.workspaceId } }) as { sessionId: string };
    await rpc(workbench, 'session/prompt', { request: { sessionId: conversation.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Synthetic authentication acceptance; use only the local fixture endpoint.' }] } });
    await expect.poll(() => requests, { timeout: 30000 }).toBeGreaterThan(0); expect(credentialMatched).toBe(true);
    await complete(page, { type: 'instance.stop', instanceId: instance.id });
    {
      // Reproduce an existing private instance, competing shared settings and a
      // persisted failed Web probe. The production migration must preserve it.
      await application.close();
      await copyFile(credentialsPath, path.join(instance.homePath, '.credentials.yaml'));
      await writeFile(credentialsPath, (await readFile(credentialsPath, 'utf8')).replaceAll(replacement, 'older-shared-synthetic-key'));
      await rmdir(path.join(instance.homePath, 'sessions')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await rename(common.sessionsPath, path.join(instance.homePath, 'sessions')); await mkdir(common.sessionsPath);
      const oldWorkspace = path.join(path.dirname(instance.homePath), 'user/Documents/deepseek-harness/default-workspace');
      await mkdir(oldWorkspace, { recursive: true }); await writeFile(path.join(oldWorkspace, 'legacy-note.txt'), 'preserved legacy workspace');
      const registryFile = path.join(root, 'profile/dsh-launcher/instances.json');
      const registered = JSON.parse(await readFile(registryFile, 'utf8')); registered[0].dataScope = 'isolated'; await writeFile(registryFile, JSON.stringify(registered));
      await rm(path.join(path.dirname(instance.homePath), 'launcher/shared-data-ready.json'));
      const reportFile = path.join(root, 'profile/dsh-launcher/compatibility', `${runtime.id}.json`);
      const report = JSON.parse(await readFile(reportFile, 'utf8'));
      report.status = 'failed'; report.finishedAt = new Date().toISOString();
      Object.assign(report.checks.find((check: { id: string }) => check.id === 'native-api'), { status: 'failed', detail: '原生环境启动超时（60 秒）。合成回归状态。', durationMs: 60000 });
      await writeFile(reportFile, JSON.stringify(report));
      application = await launch(); page = await application.firstWindow();
      await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
      expect((await state(page)).runtimes[0]?.compatibility?.status).toBe('failed');
      expect((await state(page)).instances[0]).not.toHaveProperty('dataScope');
    }
    serveSuccess = true;
    const beforeCli = requests;
    const firstTaskStartedAt = Date.now();
    const task = await request(page, { type: 'task.run', prompt: 'Use the selected native profile with the local synthetic endpoint.', title: 'Native saved configuration acceptance', timeoutMs: 300000 });
    expect(task.ok && task.operationId).toBeTruthy();
    if (!task.ok || !task.operationId) throw Error('CLI task was not admitted');
    await expect.poll(() => requests, { timeout: 360000 }).toBeGreaterThan(beforeCli);
    expect(credentialsSeen.slice(beforeCli).every(value => value === replacement)).toBe(true);
    expect((await state(page)).tasks?.find(value => value.id === task.operationId)?.instanceId).toBe(instance.id);
    expect((await state(page)).instances.every(value => value.status === 'stopped')).toBe(true);
    expect(application.windows()).toHaveLength(1);
    await expect.poll(async () => (await state(page)).operations.find(value => value.id === task.operationId)?.status, { timeout: 30000 }).not.toBe('running');
    const taskResult = await request(page, { type: 'task.result', taskId: task.operationId });
    expect(taskResult.ok && taskResult.taskResult?.text).toBe(finalText);
    const firstTaskMs = Date.now() - firstTaskStartedAt;
    const conversationId = 'private-deepseek-flash', companionId = 'deepseek-flash';
    await companionRequest(page, { type: 'conversation.open', companionId });
    const prompt = '只向本地测试服务请求并返回验收标记，不访问外网、不修改文件。';
    const sourceMessage = (await companionRequest(page, { type: 'message.send', conversationId, content: prompt, clientId: crypto.randomUUID(), delivery: 'chat' })).message!;
    const actionStartedAt = Date.now();
    const action = (await companionRequest(page, { type: 'action.run', conversationId, companionId, sourceMessageId: sourceMessage.id, title: '真实伙伴 CLI 验收', prompt })).actions!.find(value => value.sourceMessageId === sourceMessage.id)!;
    expect(action).toBeTruthy();
    await expect.poll(async () => (await companionRequest(page, { type: 'action.get', id: action.id })).action?.status, { timeout: 120000 }).toBe('succeeded');
    const completed = (await companionRequest(page, { type: 'action.get', id: action.id })).action!;
    const companionTaskMs = Date.now() - actionStartedAt;
    expect(completed.result).toContain(finalText);
    expect(await readFile(path.join(workspacePath, 'legacy-note.txt'), 'utf8')).toBe('preserved legacy workspace');
    expect((await state(page)).runtimes[0]?.compatibility?.status).toBe('passed');
    expect((await state(page)).instances.every(value => value.status === 'stopped')).toBe(true);
    expect(credentialsSeen.slice(beforeCli).every(value => value === replacement)).toBe(true);
    await complete(page, { type: 'instance.create', runtimeId: runtime.id, name: 'Second shared instance' });
    const second = (await state(page)).instances.find(value => value.id !== instance.id)!;
    // A legacy model-only profile also migrates, even without private saves or credentials.
    await mkdir(path.join(second.homePath, 'profiles/web'), { recursive: true });
    await writeFile(path.join(second.homePath, 'profiles/web/cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    baseURL: https://unused-legacy-model.invalid/v1\n');
    await complete(page, { type: 'instance.start', instanceId: second.id });
    workbench = application.windows().find(window => window !== page)!;
    await expect.poll(async () => {
      const sessions = await rpc(workbench, 'session/list', { _request: {} }) as { items: Array<{ sessionId: string }> };
      return sessions.items.some(value => value.sessionId === conversation.sessionId);
    }, { timeout: 30000 }).toBe(true);
    const beforeSecond = requests;
    await rpc(workbench, 'session/prompt', { request: { sessionId: conversation.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Confirm the second instance uses the shared saved model and credentials.' }] } });
    await expect.poll(() => requests, { timeout: 30000 }).toBeGreaterThan(beforeSecond);
    expect(credentialsSeen.slice(beforeSecond).every(value => value === replacement)).toBe(true);
    await complete(page, { type: 'instance.stop', instanceId: second.id });
    expect((await state(page)).instances.every(value => value.status === 'stopped')).toBe(true);
    await test.info().attach('shared-acceptance-timings', { contentType: 'application/json', body: JSON.stringify({ firstTaskWithRevalidationAndMigrationMs: firstTaskMs, companionTaskWithSavedEvidenceMs: companionTaskMs }) });
  } finally {
    await application.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-native-auth-')) await rm(root, { recursive: true, force: true });
  }
});
