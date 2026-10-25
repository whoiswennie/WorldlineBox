import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

it.skipIf(process.env.WORLDLINEBOX_DESKTOP_TRACE_REAL !== '1')('traces two real fish agent loops through actual storage IPC and the installed managed launcher', async () => {
  const outputRoot = path.resolve(process.env.WORLDLINEBOX_DESKTOP_TRACE_ROOT ?? 'artifacts/desktop-dsh-trace');
  await mkdir(outputRoot, { recursive: true });
  const root = await mkdtemp(path.join(outputRoot, 'run-'));
  for (const [entry, filename] of [['tests/fixtures/companion-desktop-dsh-trace-host.ts', 'main.cjs'], ['src/companions/worker.ts', 'companion-worker.cjs']]) {
    await build({ configFile: false, logLevel: 'silent', resolve: { conditions: ['node'] },
      build: { outDir: root, emptyOutDir: false, target: 'node22',
        lib: { entry: path.resolve(entry!), formats: ['cjs'], fileName: () => filename! },
        rollupOptions: { external: id => !id.startsWith('.') && !path.isAbsolute(id) } } });
  }
  const config = await realGlobalChatConfig(path.join(root, 'decrypt-profile'));
  const env: NodeJS.ProcessEnv = { ...process.env, WORLDLINEBOX_DESKTOP_TRACE_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
  const executable = createRequire(import.meta.url)('electron') as string;
  const child = spawn(executable, [path.join(root, 'main.cjs')], { env, cwd: process.cwd(),
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr?.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-4000); });
  child.on('message', message => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'ready-for-config') child.send(config);
    else console.log('DESKTOP_TRACE', JSON.stringify(message));
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Desktop trace host exceeded its bounded diagnostic runtime.')); }, 780000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
  });
  expect(code, stderr.replaceAll(config.apiKey, '[credential]')).toBe(0);
  const report = JSON.parse(await readFile(path.join(root, 'trace.json'), 'utf8'));
  expect(report.runs).toHaveLength(2);
  for (const run of report.runs) {
    expect(run.status).toBe('completed');
    expect(run.missingNames).toEqual([]);
    expect(run.desktopInventoryUnchanged).toBe(true);
    expect(run.tasks.some((task: { status: string; title: string }) => task.status === 'succeeded' && task.title !== 'DSH capability discovery')).toBe(true);
  }
}, 840000);
