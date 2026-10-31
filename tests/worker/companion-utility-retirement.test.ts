import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire, builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

const require = createRequire(path.join(process.cwd(), 'package.json'));
async function cleanup(root: string) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-companion-utility-')) throw new Error('Unexpected isolated UtilityProcess cleanup path.');
  await rm(root, { recursive: true, force: true });
}
it('initializes actual UtilityProcesses, publishes creation, and resumes the same durable retirement across process restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-companion-utility-'));
  const output = path.join(root, 'build'), reportPath = path.join(root, 'report.json'), configuration = path.join(root, 'configuration.json');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(output);
    const external = ['electron', 'better-sqlite3', ...builtinModules, ...builtinModules.map(name => 'node:' + name)];
    await build({ configFile: false, root: process.cwd(), logLevel: 'silent', resolve: { conditions: ['node'] },
      build: { outDir: output, emptyOutDir: false, minify: false, lib: { entry: path.resolve('src/companions/worker.ts'), formats: ['cjs'], fileName: () => 'companion-worker.cjs' },
        rollupOptions: { external, output: { paths: { 'better-sqlite3': require.resolve('better-sqlite3').replace(/\\/gu, '/') } } } } });
    await build({ configFile: false, root: process.cwd(), logLevel: 'silent', resolve: { conditions: ['node'] },
      build: { outDir: output, emptyOutDir: false, minify: false, lib: { entry: path.resolve('tests/fixtures/companion-utility-retirement-main.ts'), formats: ['cjs'], fileName: () => 'fixture-main.cjs' },
        rollupOptions: { external } } });
    await writeFile(configuration, JSON.stringify({ root, workerPath: path.join(output, 'companion-worker.cjs'), reportPath }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron') as string, [path.join(output, 'fixture-main.cjs'), configuration], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; child.stdout?.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-16000); }); child.stderr?.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-16000); });
    const running = child;
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { running.kill(); reject(new Error('Actual UtilityProcess retirement timed out. ' + diagnostics)); }, 30000);
      running.once('error', error => { clearTimeout(timeout); reject(error); }); running.once('exit', value => { clearTimeout(timeout); resolve(value); });
    });
    child = undefined;
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    expect(code, String(report.error ?? diagnostics)).toBe(0);
    expect(report).toMatchObject({ ready: true, runAsNode: false, windows: 0, initializedEmpty: true, createdWithPublication: true,
      restartedDuringStopping: true, sameRetirementId: true, autoAdvanceAfterCleanup: true, oldIdentityAbsentAfterRestart: true, otherOwnerPreserved: true });
    expect(report.retiredId).not.toBe(report.retainedId); expect(report.electronVersion).toBeTruthy();
  } finally {
    child?.kill();
    await cleanup(root);
  }
}, 90000);
