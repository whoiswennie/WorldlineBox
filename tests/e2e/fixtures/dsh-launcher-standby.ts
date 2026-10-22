import { readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { parse } from 'yaml';
import type { DshLauncher } from '../../../src/main/dsh/launcher';
import { electronLaunchEnv, resolveElectronLaunchOptions } from '../electron-test-helpers';

type StandbyFixture = { standbyLauncher?: DshLauncher };
/** Loads the production-built launcher class in a real Main process, reusing this test's admitted temporary runtime. */
export async function verifyActualLauncherStandby(root: string, profile: string, verifyFailure = false) {
  const options = resolveElectronLaunchOptions(), appRoot = options.args?.[0];
  if (!appRoot) throw Error('The isolated built application is required.');
  const directory = path.join(appRoot, '.vite/build');
  const chunk = (await readdir(directory)).find(name => /^launcher-[\w-]+\.js$/.test(name));
  if (!chunk) throw Error('The production DshLauncher chunk is missing.');
  const entry = path.join(root, 'standby-main.cjs');
  const resources = path.join(root, 'resources');
  await symlink(path.join(appRoot, 'resources'), resources, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(entry, `const{app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.whenReady().then(()=>{globalThis.standbyLauncher=new(require(${JSON.stringify(path.join(directory, chunk))}).DshLauncher)(()=>null)});`);
  const host = await electron.launch({ ...options, args: [entry], env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_USER_DATA_PATH: profile }) });
  let restore: { file: string; bytes: Buffer } | undefined;
  try {
    const snapshot = () => host.evaluate(() => (globalThis as StandbyFixture).standbyLauncher?.state());
    await expect.poll(async () => (await snapshot())?.executionReadiness?.status, { timeout: 120000 }).toBe('ready');
    const originalPid = (await snapshot())!.tasks![0]!.pid!;
    // Initial background discovery is lease one. The thirty-first explicit read
    // reaches the normal retirement bound without a model turn.
    for (let index = 0; index < 31; index++) {
      const catalog = await host.evaluate(() => (globalThis as StandbyFixture).standbyLauncher!.taskCapabilities());
      expect(catalog.tools.some(tool => tool.name === 'read')).toBe(true);
    }
    await expect.poll(async () => {
      const state = await snapshot(); return state?.executionReadiness?.status === 'ready' && state.tasks?.[0]?.pid !== originalPid ? state.tasks?.[0]?.pid : undefined;
    }, { timeout: 60000 }).toBeTruthy();
    const replacementPid = (await snapshot())!.tasks![0]!.pid!;
    const started = performance.now(); await host.evaluate(() => (globalThis as StandbyFixture).standbyLauncher!.taskCapabilities());
    const warmAfterRotationMs = Math.round(performance.now() - started); expect(warmAfterRotationMs).toBeLessThan(2000);
    expect((await snapshot())!.tasks![0]!.pid).toBe(replacementPid);
    let failedProbeDoesNotRetry: boolean | undefined;
    if (verifyFailure) {
      const selected = (await snapshot())!, instance = selected.instances.find(item => item.id === selected.executionReadiness?.instanceId)!;
      const file = path.join(instance.homePath, 'profiles/web/cordis.patch.yml'), bytes = await readFile(file);
      restore = { file, bytes };
      const plugin = path.join(root, 'intentional-native-failure.mjs');
      await writeFile(plugin, "export function apply(ctx){ctx.on('agent/created',()=>{process.exit(17)})}");
      await writeFile(file, JSON.stringify([...(parse(bytes.toString()) as unknown[]), { insert: [{ id: 'intentional-native-failure', name: plugin }] }]));
      await expect.poll(async () => (await snapshot())?.executionReadiness?.status, { timeout: 60000 }).toBe('failed');
      const failedTaskId = (await snapshot())!.tasks![0]!.id;
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect((await snapshot())!.tasks![0]!.id).toBe(failedTaskId); expect((await snapshot())!.executionReadiness?.status).toBe('failed');
      failedProbeDoesNotRetry = true;
    }
    await host.evaluate(() => (globalThis as StandbyFixture).standbyLauncher!.shutdown());
    await expect.poll(() => [originalPid, replacementPid].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } })).toBe(false);
    return { originalPid, replacementPid, warmAfterRotationMs, retiredAtUses: 32, nativeMainLauncherReplenishedAutomatically: true, failedProbeDoesNotRetry };
  } finally { await host.evaluate(() => (globalThis as StandbyFixture).standbyLauncher?.shutdown()).catch(() => undefined); await host.close(); await unlink(resources); if (restore) await writeFile(restore.file, restore.bytes); }
}
