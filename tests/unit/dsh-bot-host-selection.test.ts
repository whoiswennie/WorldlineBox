import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { DshLauncher } from '../../src/main/dsh/launcher';
import { NativeHostClient } from '../../src/main/dsh/native-host-client';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: class {}, dialog: {}, ipcMain: {}, session: {}, shell: {}, net: {}, nativeImage: {},
}));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(allowDefaultCreation = false, version = '0.2.1-rc.5') {
  // Constructor wiring remains real; suppress only the unrelated disk/network
  // initialization before supplying the trusted instance catalogue below.
  vi.spyOn(DshLauncher.prototype as unknown as { init(): Promise<void> }, 'init').mockResolvedValue();
  const launcher = new DshLauncher(() => undefined);
  const startup = Reflect.get(Reflect.get(launcher, 'instances'), 'options').onStartup as (progress: { instanceId: string; phase: string; updatedAt: string }) => void;
  const records = [
    { id: 'default', name: '我的 DSH', runtimeId: 'compatible', isDefault: true, status: 'running' },
    { id: 'selected', name: '工作环境', runtimeId: 'compatible', isDefault: false, status: 'running' },
    { id: 'old-bot', name: 'WorldlineBox 伙伴主脑', runtimeId: 'compatible', isDefault: false, status: 'stopped' },
  ];
  let selected = 'selected';
  let release!: (value: NativeHostClient) => void;
  const pending = new Promise<NativeHostClient>(resolve => { release = resolve; });
  const ensureHost = vi.fn(() => pending), create = vi.fn(async (name: string, runtimeId: string) => {
    if (!allowDefaultCreation) throw new Error('Creating a dedicated companion instance is forbidden');
    const value = { id: 'new-default', name, runtimeId, isDefault: true, status: 'stopped' }; records.push(value); return value;
  });
  Reflect.set(launcher, 'instances', { list: () => records, get: (id: string) => records.find(value => value.id === id), ensureHost, create,
    launchPlan: () => ({ executable: path.join(os.tmpdir(), 'managed-node.exe') }) });
  Reflect.set(launcher, 'runtimes', { get: () => ({ version, adapter: 'node-cli-web-v1' }),
    list: () => [{ id: 'compatible', version, adapter: 'node-cli-web-v1' }] });
  Reflect.set(launcher, 'cliTerminal', { state: () => ({ selectedInstanceId: selected }) });
  return { launcher, records, create, ensureHost, release, startup, select: (id: string) => { selected = id; } };
}
it('uses only the default compatible user instance, independent of the recently selected profile', async () => {
  const f = fixture();
  expect((await f.launcher.resolveBotInstance()).id).toBe('default');
  f.select('missing'); expect((await f.launcher.resolveBotInstance()).id).toBe('default');
  expect(f.create).not.toHaveBeenCalled(); expect(f.ensureHost).not.toHaveBeenCalled();
});
it('opens a companion-owned DSH for native plugin management without allocating or starting one when reading its card', async () => {
  const f = fixture();
  vi.spyOn(f.launcher, 'state').mockImplementation(() => ({ supported: true }) as ReturnType<DshLauncher['state']>);
  const service = Reflect.get(f.launcher, 'instances');
  const own = { ...f.records[0]!, id: 'private-fish', companionId: 'fish', isDefault: false };
  let created = false;
  const ensure = vi.fn(async () => { created = true; return own; });
  const handle = vi.fn(async () => ({ ok: true }));
  Reflect.set(service, 'companion', () => created ? own : undefined);
  Reflect.set(service, 'ensureCompanion', ensure);
  Reflect.set(service, 'handle', handle);
  const route = Reflect.get(f.launcher, 'handle').bind(f.launcher);
  expect(await route({ type: 'companion.environment.state', companionId: 'fish', name: '大肥鱼' })).toMatchObject({ companionEnvironment: { mode: 'shared', instance: { id: 'default' } } });
  expect(ensure).not.toHaveBeenCalled(); expect(handle).not.toHaveBeenCalled(); expect(f.ensureHost).not.toHaveBeenCalled();
  expect(await route({ type: 'companion.environment.open', companionId: 'fish', name: '大肥鱼' })).toMatchObject({ ok: true, companionEnvironment: { mode: 'private', instance: own } });
  expect(ensure).toHaveBeenCalledExactlyOnceWith('fish', '大肥鱼', f.records[0]);
  expect(handle).toHaveBeenCalledExactlyOnceWith({ type: 'instance.open', instanceId: own.id });
  await route({ type: 'companion.environment.open', companionId: 'fish', name: '大肥鱼' });
  expect(ensure).toHaveBeenCalledTimes(1);
});
it.each(['0.2.2-rc.1','0.2.2-alpha.3','0.3.0','1.0.0-beta.1','0.2.1-rc.2'])('selects the native Web adapter independently of DSH version %s', async version => {
  const f=fixture(false,version); expect((await f.launcher.resolveBotInstance()).id).toBe('default');
  expect((await f.launcher.resolveBotInstance('selected')).id).toBe('selected');expect(f.create).not.toHaveBeenCalled();
});
it('accepts a legacy Host only through an explicit binding and does not choose it for a new lane', async () => {
  const f = fixture(); f.records.splice(0, 2);
  await expect(f.launcher.resolveBotInstance()).rejects.toThrow('伙伴会复用默认实例');
  expect((await f.launcher.resolveBotInstance('old-bot')).id).toBe('old-bot');
  expect(f.create).not.toHaveBeenCalled();
});
it('creates only one ordinary default instance for a truly empty installation', async () => {
  const f = fixture(true); f.records.splice(0);
  const selected = await Promise.all([f.launcher.resolveBotInstance(), f.launcher.resolveBotInstance()]);
  expect(selected.map(value => value.id)).toEqual(['new-default', 'new-default']);
  expect(f.create).toHaveBeenCalledExactlyOnceWith('我的 DSH', 'compatible');
  expect(f.records).toHaveLength(1);
});
it('initializes memory Node without waiting for the same shared Host preparation', async () => {
  const f = fixture();
  expect(await f.launcher.botNodePath()).toBe(path.join(os.tmpdir(), 'managed-node.exe'));
  const waiting = f.launcher.prepareBot();
  await vi.waitFor(() => expect(f.ensureHost).toHaveBeenCalledTimes(1));
  expect(f.ensureHost).toHaveBeenCalledWith('default', undefined, { automatic: true });
  f.release(new NativeHostClient(43210, 'a'.repeat(64), 123)); await waiting;
  expect(f.create).not.toHaveBeenCalled();
});

it('automatically starts the bound Host on demand without overriding a manual-stop fence', async () => {
  const f = fixture(); f.records[0]!.status = 'stopped';
  const waiting = f.launcher.botHost('default');
  await vi.waitFor(() => expect(f.ensureHost).toHaveBeenCalledExactlyOnceWith('default', undefined, { automatic: true }));
  f.release(new NativeHostClient(43210, 'a'.repeat(64), 123));
  expect((await waiting).instance.id).toBe('default'); expect(f.create).not.toHaveBeenCalled();
});

it('passes an explicit task-resume permission only to the requested bound Host', async () => {
  const f = fixture(), waiting = f.launcher.botHost('selected', undefined, { explicit: true });
  await vi.waitFor(() => expect(f.ensureHost).toHaveBeenCalledExactlyOnceWith('selected', undefined, { automatic: false }));
  f.release(new NativeHostClient(43210, 'a'.repeat(64), 123)); await waiting;
  expect(f.create).not.toHaveBeenCalled();
});

it('returns a typed configuration error when no native runtime is installed', async () => {
  const f = fixture(true); f.records.splice(0);
  Reflect.set(f.launcher, 'runtimes', { list: () => [] });
  await expect(f.launcher.botHost()).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'configuration' });
  expect(f.create).not.toHaveBeenCalled(); expect(f.ensureHost).not.toHaveBeenCalled();
});

it('preserves the binding and explains when its original instance no longer exists', async () => {
  const f = fixture();
  await expect(f.launcher.botHost('missing')).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'configuration', instanceId: 'missing' });
  expect(f.ensureHost).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});
it('automatically prewarms only default and does not start profiles merely selected in the launcher', async () => {
  vi.useFakeTimers();
  const f = fixture(), discover = vi.fn(async () => undefined);
  Reflect.set(f.launcher, 'tasks', { discover });
  const observe = Reflect.get(f.launcher, 'observeExecutionCapabilities') as () => void;
  observe.call(f.launcher); await vi.advanceTimersByTimeAsync(350);
  expect(discover).toHaveBeenCalledExactlyOnceWith('default');
  f.select('old-bot'); observe.call(f.launcher); await vi.advanceTimersByTimeAsync(350);
  f.select('selected'); observe.call(f.launcher); await vi.advanceTimersByTimeAsync(350);
  expect(discover).toHaveBeenCalledExactlyOnceWith('default');
});

it.each(['running', 'stopped', 'failed'])('does not confuse capability-discovery errors with the current Host state (%s)', async status => {
  vi.useFakeTimers(); const f = fixture(); f.records[0]!.status = status;
  Reflect.set(f.launcher, 'tasks', { discover: vi.fn(async () => { throw new Error('capability registry is unavailable'); }) });
  const observe = Reflect.get(f.launcher, 'observeExecutionCapabilities') as () => void;
  observe.call(f.launcher); await vi.advanceTimersByTimeAsync(350);
  const readiness = Reflect.get(f.launcher, 'executionReadiness');
  expect(readiness).toMatchObject({ instanceId: 'default', status: status === 'running' ? 'ready' : status === 'stopped' ? 'cold' : 'failed' });
});

it('clears an old preparation failure as soon as the same native Host becomes ready', () => {
  const f = fixture(); Reflect.set(f.launcher, 'executionReadiness', { instanceId: 'default', status: 'failed', updatedAt: 'old' });
  f.startup({ instanceId: 'selected', phase: 'ready', updatedAt: 'other-ready' });
  expect(Reflect.get(f.launcher, 'executionReadiness')).toMatchObject({ instanceId: 'default', status: 'failed' });
  f.startup({ instanceId: 'default', phase: 'ready', updatedAt: 'host-ready' });
  expect(Reflect.get(f.launcher, 'executionReadiness')).toEqual({ instanceId: 'default', status: 'ready', updatedAt: 'host-ready' });
});
