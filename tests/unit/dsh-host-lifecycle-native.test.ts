import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { HOST_LIFECYCLE_TOKEN_ENV, prepareManagedHostBootstrap, stopManagedHost } from '../../src/main/dsh/host-lifecycle';
import { sharedSessionRoutingPatches } from '../../src/main/dsh/shared-session-data';
import { SHARED_WORKSPACE_ADAPTER_SOURCE } from '../../src/main/dsh/shared-workspace-adapter';

const fixtureFile = process.env.WORLDLINEBOX_DSH_NODE_FIXTURE ?? path.resolve('.tools/dsh-native-node/result.json');

it.skipIf(!existsSync(fixtureFile))('the real RC and alpha native CLI preserve an immediately renamed session across graceful shutdown', async () => {
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8')) as { root: string; runtimes: Array<{ id: string; version: string }> };
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-native-host-stop-'));
  const children = new Set<ChildProcess>();
  const reports: Array<{ version: string; stopMs: number; graceful: boolean; title: string }> = [];
  const commonRoot = path.join(root, 'shared'); const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const forceOwned = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  };
  const boot = async (runtime: { id: string; version: string }, label: string) => {
    const instance = path.join(root, label); await mkdir(instance);
    const program = path.join(fixture.root, 'manager', 'runtimes', runtime.id, 'program');
    const nativeCli = path.join(program, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const bootstrap = await prepareManagedHostBootstrap(instance, nativeCli);
    const adapter = path.join(instance, 'launcher', 'shared-workspace.mjs');
    await writeFile(adapter, SHARED_WORKSPACE_ADAPTER_SOURCE);
    const patch = path.join(instance, 'launcher', 'shared.patch.json');
    await writeFile(patch, JSON.stringify([...sharedSessionRoutingPatches(commonRoot), { insert: [{
      id: 'worldline-shared-workspace', name: adapter, config: { workspacePath: workspace, runtimeVersion: runtime.version },
    }] }]));
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i.test(key)) env[key] = value;
    }
    Object.assign(env, { DSH_HOME: path.join(instance, 'home'), DSH_AGENTS_HOME: path.join(instance, 'agents'),
      USERPROFILE: path.join(instance, 'user'), HOME: path.join(instance, 'user'),
      APPDATA: path.join(instance, 'user', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(instance, 'user', 'AppData', 'Local'),
      DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', FORCE_COLOR: '0',
      PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      PATH: `${path.dirname(path.join(program, 'bin', 'node.exe'))};${systemRoot}\\System32;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
      [HOST_LIFECYCLE_TOKEN_ENV]: bootstrap.token });
    for (const directory of [env.DSH_HOME!, env.DSH_AGENTS_HOME!, env.USERPROFILE!, env.APPDATA!, env.LOCALAPPDATA!]) await mkdir(directory, { recursive: true });
    const child = spawn(path.join(program, 'bin', 'node.exe'), ['--expose-internals', bootstrap.bootstrapPath, bootstrap.nativeCli, 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child); child.once('error', () => undefined);
    let lines = ''; let stderr = ''; child.stderr!.on('data', value => { stderr += String(value); });
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout!.on('data', value => {
        lines += String(value); const found = lines.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)/);
        if (found?.[1]) resolve(found[1]);
      });
      child.once('error', reject); child.once('exit', code => reject(new Error(`Native ${runtime.version} exited before readiness (${code}): ${stderr.slice(-1500)}`)));
    });
    const url = await ready;
    const auth = await fetch(url, { redirect: 'manual' });
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    await auth.body?.cancel(); expect(auth.status).toBe(303);
    const rpc = async (method: string, args: Record<string, unknown>) => {
      const response = await fetch(new URL(`/api/${method}`, url), { method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
      const value = await response.json() as { result: { ok: boolean; value?: unknown; error?: { code?: string } } };
      if (!value.result.ok) throw new Error(`Native ${method}: ${value.result.error?.code}`);
      return value.result.value;
    };
    return { child, bootstrap, rpc };
  };
  try {
    const rc = fixture.runtimes.find(value => value.version === '0.2.0-rc.2')!;
    const alpha = fixture.runtimes.find(value => value.version === '0.2.1-alpha.2')!;
    expect(rc).toBeDefined(); expect(alpha).toBeDefined();
    let previousSession: string | undefined;
    for (const runtime of [rc, alpha, rc]) {
      const host = await boot(runtime, `host-${reports.length}`);
      const createdWorkspace = await host.rpc('workspace/create', { request: { path: workspace } }) as { workspace: { workspaceId: string } };
      if (previousSession) {
        await expect.poll(async () => JSON.stringify(await host.rpc('session/list', { _request: {} })), { timeout: 15_000 })
          .toContain(`立即改名 ${reports.length - 1}`);
      }
      const createdSession = await host.rpc('session/create', { request: { workspaceId: createdWorkspace.workspace.workspaceId } }) as { sessionId: string };
      const title = `立即改名 ${reports.length}`;
      const renamed = await host.rpc('session/rename', { request: { sessionId: createdSession.sessionId, title } }) as { title: string };
      expect(renamed.title).toBe(title);
      const started = Date.now();
      const stopped = await stopManagedHost(host.child, host.bootstrap.token, () => forceOwned(host.child));
      expect(stopped.graceful, stopped.reason).toBe(true);
      reports.push({ version: runtime.version, stopMs: Date.now() - started, graceful: stopped.graceful, title });
      previousSession = createdSession.sessionId;
    }
    // A small evidence receipt contains no credentials, gateway capabilities or process tokens.
    const evidenceDirectory = path.resolve('.tools/dsh-research'); await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(path.join(evidenceDirectory, 'native-host-lifecycle.json'), JSON.stringify({ reports, modelCalls: 0, sessionFilesPresent: (await readdir(path.join(commonRoot, 'sessions'))).length > 0 }, null, 2));
  } finally {
    for (const child of children) await forceOwned(child);
    const resolved = path.resolve(root);
    if (path.dirname(resolved).toLowerCase() === path.resolve(tmpdir()).toLowerCase() && path.basename(resolved).startsWith('worldlinebox-native-host-stop-')) await rm(resolved, { recursive: true, force: true });
  }
}, 180_000);
