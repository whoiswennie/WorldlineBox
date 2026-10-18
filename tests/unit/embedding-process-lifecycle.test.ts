import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import {
  closeOwnedEmbeddingRuntime,
  trackOwnedEmbeddingRuntimeOwner,
} from '../../src/main/embedding-process-owner';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForFile(filePath: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath, 'utf8');
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error('fixture file was not created');
}

async function buildFixtureMain(root: string, source: string): Promise<string> {
  const mainSource = path.join(root, 'fixture-main.ts');
  const mainBundle = path.join(root, 'fixture-main.cjs');
  await writeFile(mainSource, source);
  await build({ configFile: false, logLevel: 'silent',
    build: { emptyOutDir: false, outDir: root, minify: false,
      ssr: mainSource, rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'fixture-main.cjs' },
      },
    },
  });
  return mainBundle;
}

async function writeFakeRuntime(root: string, delayHealthMs = 0): Promise<string> {
  const runtime = path.join(root, 'fake-runtime');
  await writeFile(runtime, `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const pidFile = process.argv[process.argv.indexOf('--model') + 1];
const descendantFile = pidFile + '.descendant';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(descendantFile, JSON.stringify({ pid: descendant.pid }));
fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid }));
process.on('SIGTERM', () => {});
setTimeout(() => http.createServer((req, res) => res.end('{}')).listen(port, '127.0.0.1'), ${delayHealthMs});
`, { mode: 0o700 });
  return runtime;
}

async function waitForExit(pid: number, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await delay(25);
  expect(alive(pid), `process ${pid} should exit`).toBe(false);
}

it('keeps an early Windows stop acknowledgement until owner exit is checked', async () => {
  const owner = spawn(process.execPath, ['-e', `process.stdout.write('WORLDLINEBOX_EMBEDDING_STOP\\n', () => setTimeout(() => process.exit(0), 10))`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  trackOwnedEmbeddingRuntimeOwner(owner, { requireStopAck: true });
  await new Promise<void>((resolve, reject) => {
    owner.once('error', reject);
    owner.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`owner exited with ${String(code)}`)));
  });
  await closeOwnedEmbeddingRuntime(owner);
});

it('does not treat an unacknowledged non-zero owner exit as successful cleanup', async () => {
  const owner = spawn(process.execPath, ['-e', 'process.exit(1)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  trackOwnedEmbeddingRuntimeOwner(owner, { requireStopAck: true });
  await new Promise<void>((resolve, reject) => {
    owner.once('error', reject);
    owner.once('exit', (code) => code === 1 ? resolve() : reject(new Error(`owner exited with ${String(code)}`)));
  });
  await expect(closeOwnedEmbeddingRuntime(owner)).rejects.toThrow(/before confirming cleanup/);
});

async function launchElectronFixture(input: {
  root: string;
  runtime: string;
  pidFile: string;
  closeNormally: boolean;
}): Promise<ChildProcess> {
  const main = await buildFixtureMain(input.root, `
    import { app } from 'electron';
    import { startLlamaEmbeddingSession } from ${JSON.stringify(path.join(process.cwd(), 'src/main/embedding-llama-session.ts'))};
    app.setPath('userData', process.env.WORLDLINEBOX_E2E_USER_DATA_PATH);
    app.whenReady().then(async () => {
      if (process.platform === 'darwin') app.dock.hide();
      const session = await startLlamaEmbeddingSession({ executable: ${JSON.stringify(input.runtime)},
        files: { corePath: ${JSON.stringify(input.pidFile)}, projectorPath: 'fixture' },
        gpuLayers: 0, startupTimeoutMs: 10000 });
      process.stdout.write('ready\\n');
      ${input.closeNormally ? `
        await session.close();
        process.stdout.write('closed\\n');
        app.exit(0);
      ` : ''}
    }).catch((error) => { console.error(error); app.exit(1); });
  `);
  await writeFile(path.join(input.root, 'package.json'), JSON.stringify({ main: path.basename(main) }));
  const packageRequire = createRequire(path.join(process.cwd(), 'package.json'));
  const electronModule = packageRequire('electron') as unknown;
  const electronPackageDirectory = path.dirname(packageRequire.resolve('electron/package.json'));
  const electronRelativePath = (await readFile(path.join(electronPackageDirectory, 'path.txt'), 'utf8')).trim();
  const electronExecutable = typeof electronModule === 'string'
    ? electronModule
    : path.resolve(electronPackageDirectory, 'dist', electronRelativePath);
  const env: NodeJS.ProcessEnv = { ...process.env, WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(input.root, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(electronExecutable, [input.root], { cwd: input.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A real fake HTTP runtime exercises process ownership without model downloads
// or opening a user's library. The executable fixture uses a POSIX shebang.
it.skipIf(process.platform === 'win32')('reaps the runtime when its owner is forcibly killed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-embedding-lifetime-'));
  let owner: ChildProcess | undefined;
  let runtimePid: number | undefined;
  try {
    const runtime = path.join(root, 'fake-runtime');
    const pidFile = path.join(root, 'runtime.json');
    await writeFile(runtime, `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const pidFile = process.argv[process.argv.indexOf('--model') + 1];
http.createServer((req, res) => res.end('{}')).listen(port, '127.0.0.1', () => {
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid }));
});
// Require escalation so merely sending SIGTERM cannot pass this regression.
process.on('SIGTERM', () => {});
`, { mode: 0o700 });
    const parent = path.join(root, 'owner.cjs');
    const parentSource = path.join(root, 'owner.ts');
    await writeFile(parentSource, `
        import { startLlamaEmbeddingSession } from ${JSON.stringify(path.join(process.cwd(), 'src/main/embedding-llama-session.ts'))};
        startLlamaEmbeddingSession({ executable: ${JSON.stringify(runtime)},
          files: { corePath: ${JSON.stringify(pidFile)}, projectorPath: 'fixture' },
          gpuLayers: 0, startupTimeoutMs: 10000 }).then(() => {
            process.stdout.write('ready');
          });`);
    await build({ configFile: false, logLevel: 'silent',
      build: { emptyOutDir: false, outDir: root, minify: false,
        ssr: parentSource, rollupOptions: { output: { format: 'cjs', entryFileNames: 'owner.cjs' } } },
    });
    owner = spawn(process.execPath, [parent], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture did not start')), 12000);
      owner!.once('error', reject);
      owner!.once('exit', () => { clearTimeout(timer); reject(new Error('owner exited early')); });
      owner!.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
    });
    runtimePid = JSON.parse(await readFile(pidFile, 'utf8')).pid;
    expect(alive(runtimePid!)).toBe(true);
    owner.kill('SIGKILL');
    const deadline = Date.now() + 6000;
    while (alive(runtimePid!) && Date.now() < deadline) await delay(50);
    expect(alive(runtimePid!), 'runtime survived the death of its owner').toBe(false);
  } finally {
    owner?.kill('SIGKILL');
    if (runtimePid && alive(runtimePid)) process.kill(runtimePid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it.skipIf(process.platform === 'win32')('waits for normal concurrent close to reap runtime and descendants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-embedding-close-'));
  let owner: ChildProcess | undefined;
  const runtime = await writeFakeRuntime(root);
  const pidFile = path.join(root, 'runtime.json');
  try {
    const main = await buildFixtureMain(root, `
      import { startLlamaEmbeddingSession } from ${JSON.stringify(path.join(process.cwd(), 'src/main/embedding-llama-session.ts'))};
      (async () => {
      const session = await startLlamaEmbeddingSession({ executable: ${JSON.stringify(runtime)},
        files: { corePath: ${JSON.stringify(pidFile)}, projectorPath: 'fixture' }, gpuLayers: 0, startupTimeoutMs: 10000 });
      process.stdout.write('ready\\n');
      await Promise.all([session.close(), session.close()]);
      process.stdout.write('closed\\n');
      })().catch((error) => { console.error(error); process.exit(1); });
    `);
    owner = spawn(process.execPath, [main], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture did not become ready')), 12000);
      owner!.once('error', reject);
      owner!.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
    });
    const runtimePid = JSON.parse(await readFile(pidFile, 'utf8')).pid as number;
    const descendantPid = JSON.parse(await readFile(`${pidFile}.descendant`, 'utf8')).pid as number;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('normal close did not finish')), 8000);
      owner!.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await waitForExit(runtimePid);
    await waitForExit(descendantPid);
  } finally {
    owner?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 25000);

it.skipIf(process.platform === 'win32')('cancels a runtime that is still loading before health becomes ready', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-embedding-start-cancel-'));
  let owner: ChildProcess | undefined;
  const runtime = await writeFakeRuntime(root, 10000);
  const pidFile = path.join(root, 'runtime.json');
  try {
    const main = await buildFixtureMain(root, `
      import { readFile } from 'node:fs/promises';
      import { startLlamaEmbeddingSession } from ${JSON.stringify(path.join(process.cwd(), 'src/main/embedding-llama-session.ts'))};
      (async () => {
      const controller = new AbortController();
      const opening = startLlamaEmbeddingSession({ executable: ${JSON.stringify(runtime)},
        files: { corePath: ${JSON.stringify(pidFile)}, projectorPath: 'fixture' }, gpuLayers: 0,
        startupTimeoutMs: 20000, signal: controller.signal });
      while (true) {
        try { await readFile(${JSON.stringify(pidFile)}, 'utf8'); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      controller.abort(new Error('fixture cancellation'));
      await opening.then(() => { throw new Error('cancelled startup unexpectedly opened'); }, () => undefined);
      process.stdout.write('cancelled\\n');
      })().catch((error) => { console.error(error); process.exit(1); });
    `);
    owner = spawn(process.execPath, [main], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup cancellation did not finish')), 12000);
      owner!.once('error', reject);
      owner!.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(); else reject(new Error(`fixture exited with ${String(code)}`));
      });
    });
    const runtimePid = JSON.parse(await readFile(pidFile, 'utf8')).pid as number;
    const descendantPid = JSON.parse(await readFile(`${pidFile}.descendant`, 'utf8')).pid as number;
    await waitForExit(runtimePid);
    await waitForExit(descendantPid);
  } finally {
    owner?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 25000);

it.skipIf(process.platform === 'win32')('closing one runtime does not affect another session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-embedding-isolation-'));
  let owner: ChildProcess | undefined;
  const runtime = await writeFakeRuntime(root);
  const firstPidFile = path.join(root, 'first.json');
  const secondPidFile = path.join(root, 'second.json');
  try {
    const main = await buildFixtureMain(root, `
      import { startLlamaEmbeddingSession } from ${JSON.stringify(path.join(process.cwd(), 'src/main/embedding-llama-session.ts'))};
      (async () => {
      const first = await startLlamaEmbeddingSession({ executable: ${JSON.stringify(runtime)},
        files: { corePath: ${JSON.stringify(firstPidFile)}, projectorPath: 'fixture' }, gpuLayers: 0, startupTimeoutMs: 10000 });
      const second = await startLlamaEmbeddingSession({ executable: ${JSON.stringify(runtime)},
        files: { corePath: ${JSON.stringify(secondPidFile)}, projectorPath: 'fixture' }, gpuLayers: 0, startupTimeoutMs: 10000 });
      process.stdout.write('ready\\n');
      await first.close();
      process.stdout.write('first-closed\\n');
      await second.embedText('still alive');
      process.stdout.write('second-alive\\n');
      await second.close();
      })().catch((error) => { console.error(error); process.exit(1); });
    `);
    owner = spawn(process.execPath, [main], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('both sessions did not start')), 16000);
      owner!.once('error', reject);
      owner!.stdout!.once('data', () => { clearTimeout(timer); resolve(); });
    });
    const firstPid = JSON.parse(await readFile(firstPidFile, 'utf8')).pid as number;
    const secondPid = JSON.parse(await readFile(secondPidFile, 'utf8')).pid as number;
    await waitForFile(`${firstPidFile}.descendant`);
    await waitForFile(`${secondPidFile}.descendant`);
    await waitForExit(firstPid);
    expect(alive(secondPid), 'closing one session must keep the other runtime alive').toBe(true);
    owner.kill('SIGKILL');
    await waitForExit(secondPid);
    const secondDescendantPid = JSON.parse(await readFile(`${secondPidFile}.descendant`, 'utf8')).pid as number;
    await waitForExit(secondDescendantPid);
  } finally {
    owner?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it.skipIf(process.platform === 'win32' || process.env.WORLDLINEBOX_EMBEDDING_TEST_ELECTRON !== '1')(
  'reaps semantic runtime after real Electron Main closes normally or is killed', async () => {
    for (const closeNormally of [true, false]) {
      const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-electron-embedding-lifetime-'));
      const runtime = await writeFakeRuntime(root);
      const pidFile = path.join(root, 'runtime.json');
      let application: ChildProcess | undefined;
      let applicationExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      try {
        application = await launchElectronFixture({ root, runtime, pidFile, closeNormally });
        applicationExit = new Promise((resolve) => {
          application!.once('exit', (code, signal) => resolve({ code, signal }));
        });
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error('Electron fixture did not open the runtime')), 20000);
          const failed = (error: Error) => {
            clearTimeout(deadline);
            reject(error);
          };
          const exited = (code: number | null, signal: NodeJS.Signals | null) => {
            failed(new Error(`Electron fixture exited before runtime readiness (code=${String(code)}, signal=${String(signal)}).`));
          };
          const ready = (chunk: Buffer | string) => {
            if (!chunk.toString().includes('ready')) return;
            clearTimeout(deadline);
            application!.stdout?.removeListener('data', ready);
            application!.removeListener('error', failed);
            application!.removeListener('exit', exited);
            resolve();
          };
          application!.stdout?.on('data', ready);
          application!.once('error', failed);
          application!.once('exit', exited);
        });
        const runtimePid = JSON.parse(await readFile(pidFile, 'utf8')).pid as number;
        const descendantPid = JSON.parse(await readFile(`${pidFile}.descendant`, 'utf8')).pid as number;
        if (closeNormally) {
          const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Electron fixture did not finish normal close')), 12000);
            void applicationExit!.then((result) => {
              clearTimeout(deadline);
              resolve(result);
            });
          });
          expect(exited).toEqual({ code: 0, signal: null });
        } else {
          application.kill('SIGKILL');
          await applicationExit;
        }
        await waitForExit(runtimePid);
        await waitForExit(descendantPid);
      } finally {
        if (application && application.exitCode === null && application.signalCode === null) {
          application.kill('SIGKILL');
          await applicationExit;
        }
        for (const file of [pidFile, `${pidFile}.descendant`]) {
          try {
            const pid = JSON.parse(await readFile(file, 'utf8')).pid as number;
            if (alive(pid)) await waitForExit(pid);
          } catch {
            // A fixture that failed before spawn has no process to reap.
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 60000);
