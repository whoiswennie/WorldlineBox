import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HOST_LIFECYCLE_TOKEN_ENV, prepareManagedHostBootstrap, stopManagedHost } from '../../src/main/dsh/host-lifecycle';
import { ownedWindowsProcessCreatedAt } from '../../src/main/dsh/windows-job';

const program = process.env.WORLDLINEBOX_DSH_STARTUP_PROGRAM;
it.skipIf(!program || process.platform !== 'win32')('measures cold and repeated native Host readiness with direct Windows process identity checks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-host-startup-'));
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-host-startup-')) throw Error('Invalid cleanup');
  const reports: Array<{ run: number; readyMs: number; identityMs: number; verified: boolean }> = [], children = new Set<ChildProcess>();
  const force = async (child: ChildProcess) => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) return; const ended = once(child, 'exit'); child.kill(); await ended; };
  try {
    const nativeCli = path.join(program!, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
    for (const run of [1, 2, 3]) {
      const instance = path.join(root, 'instance-' + reports.length); await mkdir(instance);
      const bootstrap = await prepareManagedHostBootstrap(instance, nativeCli), systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      const env: NodeJS.ProcessEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: process.env.COMSPEC,
        TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: `${path.join(program!, 'bin')};${systemRoot}\\System32`,
        DSH_HOME: path.join(instance, 'home'), DSH_AGENTS_HOME: path.join(instance, 'agents'),
        HOME: path.join(instance, 'user'), USERPROFILE: path.join(instance, 'user'),
        APPDATA: path.join(instance, 'user/AppData/Roaming'), LOCALAPPDATA: path.join(instance, 'user/AppData/Local'),
        DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', FORCE_COLOR: '0', [HOST_LIFECYCLE_TOKEN_ENV]: bootstrap.token };
      for (const directory of [env.DSH_HOME!, env.DSH_AGENTS_HOME!, env.USERPROFILE!, env.APPDATA!, env.LOCALAPPDATA!]) await mkdir(directory, { recursive: true });
      const started = performance.now(), child = spawn(path.join(program!, 'bin/node.exe'), ['--expose-internals', bootstrap.bootstrapPath, bootstrap.nativeCli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
        { cwd: instance, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }); children.add(child);
      const identityAt = performance.now(); expect(ownedWindowsProcessCreatedAt(child.pid!)).toMatch(/^\d{4}-/u); const identityMs = Math.round((performance.now() - identityAt) * 100) / 100;
      let timer: ReturnType<typeof setTimeout> | undefined, output = '';
      child.stderr!.on('data', () => undefined);
      let url: string;
      try {
        url = await new Promise<string>((resolve, reject) => {
          timer = setTimeout(() => reject(Error('Native Host readiness deadline exceeded')), 60000);
          child.once('error', reject); child.once('exit', code => reject(Error('Native Host exited before readiness: ' + code)));
          child.stdout!.on('data', chunk => { output += String(chunk); const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)/u); if (match?.[1]) resolve(match[1]); });
        });
      } finally { clearTimeout(timer); }
      const readyMs = Math.round(performance.now() - started), response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel(); expect(response.status).toBe(303);
      reports.push({ run, readyMs, identityMs, verified: true });
      const stopped = await stopManagedHost(child, bootstrap.token, () => force(child)); expect(stopped.graceful, stopped.reason).toBe(true);
    }
    const output = path.resolve('.tools/test-output/dsh-startup'); await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'native-startup.json'), JSON.stringify({ reports, credentialsUsed: false }, null, 2));
    console.log('NATIVE_HOST_STARTUP', JSON.stringify(reports));
  } finally {
    for (const child of children) await force(child);
    await rm(root, { recursive: true, force: true });
  }
}, 200000);
