import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import type { DshLauncherRequest, DshRuntime, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('cold and repeated real native Host starts finish through the launcher with saved phase timings and no inherited user data', async () => {
  // The first launch verifies the runtime and initializes its native profile.
  // Later launches reuse the native profile and cached integrity inventory.
  test.setTimeout(540000);
  const fixtureFile = process.env.WORLDLINEBOX_DSH_NODE_FIXTURE ?? path.resolve('.tools/dsh-native-node/result.json');
  test.skip(process.platform !== 'win32' || !existsSync(fixtureFile), 'An inspected Windows native runtime is required.');
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8')) as { root: string }, manager = path.join(fixture.root, 'manager');
  const runtimes = JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as DshRuntime[];
  const runtime = runtimes.find(value => value.adapter === 'node-cli-web-v1'); expect(runtime).toBeTruthy();
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-startup-latency-')), profile = path.join(root, 'profile');
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-startup-latency-')) throw Error('Invalid cleanup target.');
  await seedNativeRuntime(manager, runtime!, profile);
  const launch = () => electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    const request = (input: DshLauncherRequest) => page.evaluate(input => (globalThis as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(input), input);
    const state = async () => { const result = await request({ type: 'state' }); if (!result.ok || !result.state) throw Error(result.ok ? 'Missing state' : result.error); return result.state; };
    const complete = async (input: DshLauncherRequest, timeout = 60000) => {
      const result = await request(input); if (!result.ok) throw Error(result.error);
      if (!result.operationId) throw Error('Missing operation'); const id = result.operationId;
      try {
        await expect.poll(async () => (await state()).operations.find(operation => operation.id === id)?.status, { timeout }).not.toBe('running');
      } catch (error) {
        const output = path.resolve('.tools/test-output/dsh-startup'); await mkdir(output, { recursive: true });
        const current = await state();
        await writeFile(path.join(output, 'failed-startup-state.json'), JSON.stringify({ runtimeVersion: runtime!.version, operation: current.operations.find(operation => operation.id === id) }, null, 2));
        await writeFile(path.join(output, 'failed-startup.log'), await readFile(path.join(profile, 'dsh/operations', id + '.log'), 'utf8'));
        throw error;
      }
      const operation = (await state()).operations.find(operation => operation.id === id)!; expect(operation.status, operation.error).toBe('succeeded'); return operation;
    };
    await complete({ type: 'instance.create', name: '启动耗时验收', runtimeId: runtime!.id });
    const instance = (await state()).instances[0]!, reports: Array<{ run: number; scenario: string; milliseconds: number; timingLog: string[] }> = [];
    for (const run of [1, 2, 3, 4]) {
      if (run === 4) { await app.close(); app = await launch(); page = await app.firstWindow(); await expect(page.locator('[data-dsh-launcher]')).toBeVisible(); }
      const started = performance.now(), operation = await complete({ type: 'instance.start', instanceId: instance.id }, run === 1 ? 360000 : 60000);
      const milliseconds = Math.round(performance.now() - started); expect((await state()).instances[0]!.status).toBe('running');
      const log = await readFile(path.join(profile, 'dsh/operations', operation.id + '.log'), 'utf8');
      expect(log).toContain('Native Web Host ready'); expect(log).not.toContain('dsh web: http:');
      reports.push({ run, scenario: run === 1 ? 'first-native-profile-start' : run === 4 ? 'application-restart' : 'repeated-start', milliseconds, timingLog: log.split('\n').filter(line => line.startsWith('Native Web Host')) });
      if (run > 1) expect(milliseconds, 'An initialized native profile should start promptly').toBeLessThan(30000);
      await complete({ type: 'instance.stop', instanceId: instance.id });
      expect((await state()).instances[0]!.status).toBe('stopped');
    }
    const output = path.resolve('.tools/test-output/dsh-startup'); await mkdir(output, { recursive: true });
    const report = { packaged: await app.evaluate(({ app }) => app.isPackaged), runtimeVersion: runtime!.version, runs: reports, userCredentialsUsed: false };
    await writeFile(path.join(output, 'launcher-startup.json'), JSON.stringify(report, null, 2));
    console.log('LAUNCHER_STARTUP_LATENCY', JSON.stringify(report));
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
});
