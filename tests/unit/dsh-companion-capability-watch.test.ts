import { lstat, mkdir, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DshLauncher } from '../../src/main/dsh/launcher';
import { dshInstanceSchema, dshLauncherStateSchema, type DshInstance, type DshLauncherState } from '../../src/shared/dsh-launcher';
import { removeOwnedDirectorySync } from '../helpers/remove-owned-test-directory';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: class {}, dialog: {}, ipcMain: {}, session: {}, shell: {}, net: {}, nativeImage: {},
}));

const fixtures: Array<{ launcher: DshLauncher; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.launcher.shutdown();
    const absolute = path.resolve(fixture.directory);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('wlb-capability-watch-')
      || (await lstat(absolute)).isSymbolicLink() || path.resolve(await realpath(absolute)) !== absolute) throw Error('Unexpected capability watcher test directory.');
    removeOwnedDirectorySync(absolute);
  }
  vi.restoreAllMocks();
});

const ignored = ['sessions', 'storages', 'logs', 'cache', 'node_modules', '.plugin-manager', 'llm-deepseek', 'skills-disabled'];
async function fixture() {
  // Keep the production filesystem watcher and state serializer. Initialization,
  // native process launch and unrelated catalogues are outside this test.
  vi.spyOn(DshLauncher.prototype as unknown as { init(): Promise<void> }, 'init').mockResolvedValue();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wlb-capability-watch-'));
  const capabilityChanged = vi.fn(), launcher = new DshLauncher(() => undefined, undefined, undefined, capabilityChanged);
  fixtures.push({ launcher, directory }); Reflect.set(launcher, 'rootPath', directory);
  const records: DshInstance[] = ['shared', 'private'].map(id => dshInstanceSchema.parse({
    id, name: id, runtimeId: 'runtime', createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z',
    profile: 'web', status: 'stopped', homePath: path.join(directory, id, 'home'), agentsPath: path.join(directory, id, 'agents'),
    workspacePath: path.join(directory, id, 'workspace'), browserPartition: `persist:watch-${id}`, isDefault: id === 'shared',
    ...(id === 'private' ? { companionId: 'fish', companionName: '大肥鱼' } : {}),
  }));
  for (const instance of records) {
    await mkdir(path.join(instance.homePath, 'profiles', 'default'), { recursive: true });
    await mkdir(path.join(instance.agentsPath, 'skills', 'research'), { recursive: true });
    // Create ignored directories before attaching watchers: only file writes,
    // rather than relevant parent-directory creation, are under test below.
    for (const name of ignored) {
      await mkdir(path.join(instance.homePath, 'profiles', 'default', name), { recursive: true });
      await mkdir(path.join(instance.agentsPath, name), { recursive: true });
    }
    await writeFile(path.join(instance.homePath, 'profiles', 'default', 'cordis.yml'), 'plugins: []\n');
    await writeFile(path.join(instance.agentsPath, 'skills', 'research', 'SKILL.md'), '# Research\n');
  }
  const ensureHost = vi.fn(async () => { throw Error('Observing capabilities must never start DSH.'); });
  Reflect.set(launcher, 'instances', { list: () => records, snapshots: () => [], ensureHost, shutdown: async () => undefined });
  Reflect.set(launcher, 'runtimes', { list: () => [], close: () => undefined });
  Reflect.set(launcher, 'packs', { list: () => [] });
  Reflect.set(launcher, 'operations', { list: () => [], shutdown: async () => undefined });
  Reflect.set(launcher, 'cliTerminal', { state: () => undefined, shutdown: async () => undefined });
  Reflect.set(launcher, 'network', { state: () => undefined });
  Reflect.set(launcher, 'versions', { state: () => undefined });
  Reflect.set(launcher, 'marketplace', { state: () => undefined });
  Reflect.set(launcher, 'tasks', { state: () => [], shutdown: async () => undefined });
  const watch = Reflect.get(launcher, 'watchCompanionCapabilities') as (changed: () => void) => void;
  const broadcasts: DshLauncherState[] = [];
  const refreshWatchers = () => watch.call(launcher, () => { broadcasts.push(dshLauncherStateSchema.parse(launcher.state())); });
  const revisions = () => dshLauncherStateSchema.parse(launcher.state()).companionCapabilityRevisions!;
  refreshWatchers();
  return { launcher, records, ensureHost, capabilityChanged, broadcasts, refreshWatchers, revisions };
}

it('observes shared native profiles and private skills independently and broadcasts schema-preserved revisions', async () => {
  const f = await fixture(), shared = f.records[0]!, personal = f.records[1]!;
  expect(f.revisions()).toEqual({ shared: 0, private: 0 });
  await writeFile(path.join(shared.homePath, 'profiles', 'default', 'cordis.yml'), 'plugins:\n  - native-search\n');
  await vi.waitFor(() => {
    expect(f.broadcasts.at(-1)?.companionCapabilityRevisions?.shared).toBeGreaterThan(0);
    expect(f.broadcasts.at(-1)?.companionCapabilityRevisions?.private).toBe(0);
  }, { timeout: 4000 });
  const beforePrivate = f.revisions().shared!;
  await writeFile(path.join(personal.agentsPath, 'skills', 'research', 'SKILL.md'), '# Research\nUse primary sources.\n');
  await vi.waitFor(() => expect(f.broadcasts.at(-1)?.companionCapabilityRevisions?.private).toBeGreaterThan(0), { timeout: 4000 });
  expect(f.revisions().shared).toBe(beforePrivate);
  expect(f.capabilityChanged).toHaveBeenCalled(); expect(f.ensureHost).not.toHaveBeenCalled();
  const state = dshLauncherStateSchema.parse(f.launcher.state());
  expect(state.companionCapabilityRevisions).toEqual(f.revisions());
  expect(dshLauncherStateSchema.safeParse({ ...state, companionCapabilityRevisions: { shared: -1 } }).success).toBe(false);
  expect(dshLauncherStateSchema.safeParse({ ...state, companionCapabilityRevisions: { shared: 1.5 } }).success).toBe(false);
});

it('ignores ordinary task logs, sessions, caches and dependencies without hiding later real configuration changes', async () => {
  const f = await fixture();
  const events: string[] = [], probes = f.records.flatMap(instance => [instance.homePath, instance.agentsPath].map(directory => watch(directory, { recursive: true }, (event, name) => events.push(`${path.relative(f.launcher.state().rootPath, directory)}:${event}:${name}`))));
  try {
  for (const instance of f.records) for (const name of ignored) {
    await writeFile(path.join(instance.homePath, 'profiles', 'default', name, 'task.log'), 'ordinary task output\n');
    await writeFile(path.join(instance.agentsPath, name, 'task.log'), 'ordinary task output\n');
  }
  // Negative observation must outlast the production 150 ms debounce; a later
  // positive control also proves the real native watchers remain attached.
  await new Promise(resolve => setTimeout(resolve, 450));
  expect(f.revisions(), JSON.stringify(events)).toEqual({ shared: 0, private: 0 });
  expect(f.broadcasts).toHaveLength(0); expect(f.capabilityChanged).not.toHaveBeenCalled();
  const config = path.join(f.records[0]!.homePath, 'profiles', 'default', 'cordis.yml');
  await writeFile(config + '.next', 'plugins: [native-calendar]\n'); await rename(config + '.next', config);
  await vi.waitFor(() => expect(f.broadcasts.at(-1)?.companionCapabilityRevisions?.shared).toBeGreaterThan(0), { timeout: 4000 });
  expect(f.revisions().private).toBe(0); expect(f.ensureHost).not.toHaveBeenCalled();
  } finally { for (const probe of probes) probe.close(); }
});

it('detaches removed instances and closes native watchers on shutdown', async () => {
  const f = await fixture(), removed = f.records.pop()!;
  f.refreshWatchers(); expect(f.revisions()).toEqual({ shared: 0 });
  await writeFile(path.join(removed.agentsPath, 'skills', 'research', 'SKILL.md'), '# Removed character\n');
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(f.broadcasts).toHaveLength(0); expect(f.revisions()).toEqual({ shared: 0 });
  await f.launcher.shutdown();
  await writeFile(path.join(f.records[0]!.homePath, 'profiles', 'default', 'cordis.yml'), 'plugins: [closed]\n');
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(f.broadcasts).toHaveLength(0); expect(f.capabilityChanged).not.toHaveBeenCalled();
  expect(Reflect.get(f.launcher, 'companionCapabilityWatchers').size).toBe(0);
});
