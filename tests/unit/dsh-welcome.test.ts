import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { hashFile, removeManaged } from '../../src/main/dsh/files';
import { instanceEnvironment, launchCli, parseReadyUrl, terminateOwnedProcess, type RuntimeLaunchPlan } from '../../src/main/dsh/instance-process';
import type { DshInstance } from '../../src/shared/dsh-launcher';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });

describe.skipIf(process.platform !== 'win32')('canonical runtime entry identity', () => {
  it('uses actual on-disk casing for the executable and ASAR CLI, including aliased parent folders', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-runtime-case-')); roots.push(root);
    const directory = path.join(root, 'MiXeDProgram'); await mkdir(directory);
    const entry = canonicalRuntimeEntryPaths(directory.toUpperCase());
    expect(entry.executable).toBe(path.join(realpathSync.native(directory), 'DeepSeek Harness.exe'));
    expect(entry.cli).toBe(path.join(realpathSync.native(directory), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'));
    expect(entry.cli).toContain('MiXeDProgram');
  });
});

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('official welcome acknowledgement persistence', () => {
  it('reproduces root-Include rejection with a case alias and saves through the native API after canonicalizing the same sealed runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-welcome-case-')); roots.push(root);
    const program = realpathSync.native(path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!));
    const archive = path.join(program, 'resources/app.asar'); const sourceHash = await hashFile(archive);
    const invoke = async (mode: 'alias' | 'canonical') => {
      const privateRoot = path.join(root, mode);
      const instance: DshInstance = { id: mode, name: mode, runtimeId: 'official', profile: 'web', status: 'stopped',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), homePath: path.join(privateRoot, 'home'),
        agentsPath: path.join(privateRoot, 'agents'), workspacePath: path.join(privateRoot, 'workspace'), browserPartition: `persist:${mode}`, isDefault: false };
      const aliased = program.toUpperCase();
      const entries = mode === 'alias' ? { executable: path.join(aliased, 'DeepSeek Harness.exe'),
        cli: path.join(aliased, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js') } : canonicalRuntimeEntryPaths(aliased);
      const plan: RuntimeLaunchPlan = { ...entries, env: { ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' } };
      const env = await instanceEnvironment(privateRoot, instance, plan);
      const child = await launchCli(plan, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], env, instance.workspacePath);
      try {
        const url = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Official welcome fixture did not become ready.')), 25_000); let pending = '';
          child.stdout.on('data', (chunk: Buffer) => { pending += chunk.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop()!;
            for (const line of lines) { const ready = parseReadyUrl(line); if (ready) { clearTimeout(timer); resolve(ready); } } });
          child.stderr.resume(); child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', () => { clearTimeout(timer); reject(new Error('Official welcome fixture exited.')); });
        });
        const exchange = await fetch(url, { redirect: 'manual' }); const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
        await exchange.body?.cancel(); expect(exchange.status).toBe(303); expect(cookie).toBeTruthy();
        const origin = new URL(url).origin;
        const call = async (method: string, args: Record<string, unknown>) => {
          const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie: cookie! },
            body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) });
          expect(response.status).toBe(200);
          return (await response.json() as { result: { ok: boolean; value?: { namespaces: Array<{ ns: string; revision: number }> }; error?: { code: string; message: string } } }).result;
        };
        const described = await call('settings/describe', {}); expect(described.ok).toBe(true);
        const welcome = described.value!.namespaces.find(item => item.ns === 'ui-settings-general')!; expect(welcome).toBeDefined();
        const result = await call('settings/mutate', { ns: 'ui-settings-general', ops: [{ op: 'set', path: ['welcomeNoticeVersion'], value: '2026-09-28.1' }], expectedRevision: welcome.revision });
        const saved = await readFile(path.join(instance.homePath, 'profiles/web/cordis.patch.yml'), 'utf8');
        return { result, saved };
      } finally { await terminateOwnedProcess(child); }
    };
    const failed = await invoke('alias');
    expect(failed.result.ok).toBe(false); expect(failed.result.error?.code).toBe('settings/rejected');
    expect(failed.result.error?.message).toContain('root Include entry'); expect(failed.saved).not.toContain('welcomeNoticeVersion');
    const fixed = await invoke('canonical'); expect(fixed.result.ok).toBe(true); expect(fixed.saved).toContain('welcomeNoticeVersion');
    expect(await hashFile(archive)).toBe(sourceHash);
  }, 60_000);
});
