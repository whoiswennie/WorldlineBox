import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { DshLauncherRequest, DshLauncherState, DshRuntime, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { verifyActualLauncherStandby } from './fixtures/dsh-launcher-standby';

async function request(page: Page, input: DshLauncherRequest) {
  const result = await page.evaluate(input => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request(input), input);
  if (!result.ok) throw Error(result.error); return result;
}
async function state(page: Page): Promise<DshLauncherState> { return (await request(page, { type: 'state' })).state!; }
async function complete(page: Page, input: DshLauncherRequest) {
  const result = await request(page, input);
  if (result.operationId) {
    await expect.poll(async () => (await state(page)).operations.find(value => value.id === result.operationId)?.status, { timeout: 120000 }).not.toBe('running');
    const operation = (await state(page)).operations.find(value => value.id === result.operationId)!;
    expect(operation.status, operation.error).toBe('succeeded');
  }
  return result;
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function removeProfile(root: string, parent: string) {
  if (path.dirname(await realpath(root)) !== parent || !path.basename(root).startsWith('worldlinebox-launcher-warm-')) throw Error('Unexpected cleanup root.');
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

test('real launcher prewarm survives identical profile rewrites and selection, while native plugin and skill changes retire its worker', async () => {
  test.setTimeout(900000);
  const source = path.join(process.env.APPDATA ?? '', 'WorldlineBox/dsh-launcher');
  test.skip(process.platform !== 'win32' || !existsSync(path.join(source, 'runtimes.json')), 'Requires an installed sealed official Windows runtime.');
  const runtimes = JSON.parse(await readFile(path.join(source, 'runtimes.json'), 'utf8')) as DshRuntime[];
  const runtime = runtimes.find(item => item.version === '0.2.1-rc.2')!; expect(runtime).toBeTruthy();
  const parent = await realpath(tmpdir()), root = process.env.WORLDLINEBOX_LAUNCHER_WARM_PROFILE ?? await mkdtemp(path.join(parent, 'worldlinebox-launcher-warm-')), profile = path.join(root, 'profile');
  if (!existsSync(path.join(profile, 'dsh-launcher/runtimes.json'))) await seedNativeRuntime(source, runtime, profile);
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
  const pids = new Set<number>(); let closed = false, pageForDiagnostics: Page | undefined;
  const report: Record<string, unknown> = { runtimeVersion: runtime.version, nativeRuntime: true, mainHandlersMocked: false, modelTurnsSubmitted: 0 };
  try {
    const page = await application.firstWindow(); pageForDiagnostics = page; const native = await application.browserWindow(page); await native.evaluate(win => win.hide());
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    const instanceName = '原生预热与管理验收 ' + Date.now();
    await complete(page, { type: 'instance.create', name: instanceName, runtimeId: runtime.id });
    const instance = (await state(page)).instances.find(item => item.name === instanceName)!;
    const waitReady = async (after?: string) => {
      await expect.poll(async () => {
        const current = await state(page), task = current.tasks?.find(value => value.title === 'DSH capability discovery' && value.instanceId === instance.id);
        if (current.executionReadiness?.status === 'failed' && task?.status === 'failed' && task.id !== after) throw Error(task.error);
        return current.executionReadiness?.status === 'ready' && task?.status === 'succeeded' && task.id !== after ? task : undefined;
      }, { timeout: 360000, intervals: [100, 250, 500] }).toBeTruthy();
      const task = (await state(page)).tasks!.find(value => value.title === 'DSH capability discovery' && value.instanceId === instance.id)!;
      expect(task.pid).toBeGreaterThan(0); pids.add(task.pid!); expect(alive(task.pid!)).toBe(true);
      const result = await request(page, { type: 'task.result', taskId: task.id }); expect(result.taskResult?.capabilities).toBeTruthy();
      return { task, capabilities: result.taskResult!.capabilities! };
    };
    const started = performance.now(); await complete(page, { type: 'cli.select', instanceId: instance.id });
    let ready = await waitReady(); report.initialReadyMs = Math.round(performance.now() - started);
    const originalPid = ready.task.pid!, originalId = ready.task.id;
    const patch = path.join(instance.homePath, 'profiles/web/cordis.patch.yml'), bytes = await readFile(patch);
    await writeFile(patch, bytes); const repeat = performance.now();
    await complete(page, { type: 'cli.select', instanceId: instance.id });
    report.repeatSelectionMs = Math.round(performance.now() - repeat);
    // Includes both FS event debounce windows and the discovery scheduling window.
    await new Promise(resolve => setTimeout(resolve, 1200));
    ready = await waitReady(); expect(ready.task.pid).toBe(originalPid); expect(ready.task.id).toBe(originalId);
    report.identicalRewriteAndSelectionMs = Math.round(performance.now() - repeat); report.identicalRewriteRetainedWorker = true;
    const accessMode = (await state(page)).taskAccess!.mode;
    await complete(page, { type: 'task.access.save', mode: accessMode });
    await new Promise(resolve => setTimeout(resolve, 700));
    ready = await waitReady(); expect(ready.task.id).toBe(originalId); expect(ready.task.pid).toBe(originalPid);
    report.identicalAccessModeRetainedWorker = true;
    await complete(page, { type: 'task.access.save', mode: accessMode === 'read-only' ? 'workspace-write' : 'read-only' });
    ready = await waitReady(originalId); expect(ready.task.pid).not.toBe(originalPid); expect(ready.task.accessMode).not.toBe(accessMode);
    report.changedAccessModeRetiredAndPrewarmed = true;
    const configurationPid = ready.task.pid!, configurationTaskId = ready.task.id;
    await writeFile(patch, Buffer.concat([bytes, Buffer.from('\n# Actual configuration content change acceptance\n')]));
    ready = await waitReady(configurationTaskId); expect(ready.task.pid).not.toBe(configurationPid); expect(alive(configurationPid)).toBe(false);
    report.actualContentChangeRetiredWorker = true;

    const skill = 'launcher-live-skill', skillPath = path.join(instance.agentsPath, 'skills', skill); await mkdir(skillPath, { recursive: true });
    await writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${skill}\ndescription: Actual temporary native registry acceptance skill.\n---\nRead this isolated fixture instruction.\n`);
    let previous = ready.task.id; ready = await waitReady(previous); expect(ready.capabilities.skills.map(item => item.name)).toContain(skill);
    expect((await request(page, { type: 'skill.list', instanceId: instance.id })).installedSkills).toEqual(expect.arrayContaining([expect.objectContaining({ name: skill, enabled: true, managed: false })]));
    previous = ready.task.id; await complete(page, { type: 'skill.toggle', instanceId: instance.id, name: skill, enabled: false }); ready = await waitReady(previous);
    expect(ready.capabilities.skills.map(item => item.name)).not.toContain(skill);
    expect(existsSync(path.join(instance.homePath, 'skills-disabled', skill, 'SKILL.md'))).toBe(true);
    previous = ready.task.id; await complete(page, { type: 'skill.toggle', instanceId: instance.id, name: skill, enabled: true }); ready = await waitReady(previous);
    expect(ready.capabilities.skills.map(item => item.name)).toContain(skill);
    previous = ready.task.id; await complete(page, { type: 'skill.remove', instanceId: instance.id, name: skill }); ready = await waitReady(previous);
    expect(ready.capabilities.skills.map(item => item.name)).not.toContain(skill); expect(existsSync(skillPath)).toBe(false);
    expect((await request(page, { type: 'skill.list', instanceId: instance.id })).installedSkills?.some(item => item.name === skill)).toBe(false);
    report.skillNativeEnabledDisabledReenabledRemoved = true;

    const plugin = 'worldlinebox-native-acceptance-plugin', tool = 'launcher_fixture_tool', directory = path.join(instance.homePath, 'profiles/web/node_modules', plugin);
    const manifestFile = path.join(instance.homePath, 'profiles/web/package.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { dependencies?: Record<string, string>; dsh: { profile: { bundles: string[] } } };
    await mkdir(directory, { recursive: true });
    const anchor = path.join(profile, 'dsh-launcher/runtimes', runtime.id, 'program/dsh/node_modules/@deepseek-ai/dsh/package.json');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: plugin, version: '1.0.0', type: 'module', description: 'Offline temporary native fixture bundle', repository: 'https://github.com/worldlinebox/acceptance', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(path.join(directory, 'index.mjs'), `import{createRequire}from'node:module';import{pathToFileURL}from'node:url';const load=createRequire(${JSON.stringify(anchor)});const{defineTool}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-tools')));export const inject=['tools'];export function apply(ctx){ctx.tools.register(defineTool({name:${JSON.stringify(tool)},description:'Offline live bundle fixture',parameters:{},output:{schema:{type:'object',additionalProperties:false,properties:{ok:{type:'boolean',required:true}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:()=>({ok:true})}));}`);
    await writeFile(path.join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'launcher-native-fixture', name: path.join(directory, 'index.mjs') }] }]));
    manifest.dependencies = { ...manifest.dependencies, [plugin]: '1.0.0' }; manifest.dsh.profile.bundles.push(plugin);
    previous = ready.task.id; await writeFile(manifestFile, JSON.stringify(manifest)); ready = await waitReady(previous);
    expect(ready.capabilities.tools.map(item => item.name)).toContain(tool);
    expect((await request(page, { type: 'instance.plugins', instanceId: instance.id })).installedPlugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: plugin, scope: 'instance', enabled: true, version: '1.0.0' })]));
    previous = ready.task.id; await complete(page, { type: 'instance.plugin-toggle', instanceId: instance.id, name: plugin, enabled: false }); ready = await waitReady(previous);
    expect(ready.capabilities.tools.map(item => item.name)).not.toContain(tool);
    previous = ready.task.id; await complete(page, { type: 'instance.plugin-toggle', instanceId: instance.id, name: plugin, enabled: true }); ready = await waitReady(previous);
    expect(ready.capabilities.tools.map(item => item.name)).toContain(tool);
    previous = ready.task.id; await complete(page, { type: 'instance.plugin', instanceId: instance.id, action: 'remove', spec: plugin }); ready = await waitReady(previous);
    expect(ready.capabilities.tools.map(item => item.name)).not.toContain(tool);
    expect((await request(page, { type: 'instance.plugins', instanceId: instance.id })).installedPlugins?.some(item => item.name === plugin)).toBe(false);
    report.pluginNativeEnabledDisabledReenabledOfficialCliRemoved = true;
    // pnpm owns packages it installed, while this offline fixture was placed by
    // the test. Removing its dependency and bundle must not recursively delete
    // arbitrary untracked files that the package manager never owned.
    report.unmanagedFixtureSourceFilesRetained = existsSync(directory);
    report.pluginInstallSource = 'Explicit offline fixture placed in isolated private instance; no network marketplace install was tested here.';
    report.workerPids = [...pids];
    await application.close(); closed = true;
    await expect.poll(() => [...pids].some(alive), { timeout: 15000 }).toBe(false); report.shutdownReleasedAllWorkers = true;
    report.standbyRotation = await verifyActualLauncherStandby(root, profile); report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error);
    if (pageForDiagnostics && !closed) { const current = await state(pageForDiagnostics); report.tasks = current.tasks; report.readiness = current.executionReadiness;
      report.taskEvents = await Promise.all((current.tasks ?? []).slice(0, 4).map(task => request(pageForDiagnostics!, { type: 'task.events', taskId: task.id })));
    }
    throw error;
  }
  finally {
    if (!closed) await application.close();
    await mkdir(path.resolve('.tools/test-output'), { recursive: true }); await writeFile(path.resolve('.tools/test-output/companion-dsh-launcher-warm.json'), JSON.stringify(report, null, 2));
    if (process.env.WORLDLINEBOX_LAUNCHER_WARM_KEEP !== '1') await removeProfile(root, parent);
  }
});
