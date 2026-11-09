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
it('opens the same shared environment for every character without provisioning a new owner', async () => {
  const f = fixture();
  vi.spyOn(f.launcher, 'state').mockImplementation(() => ({ supported: true }) as ReturnType<DshLauncher['state']>);
  const service = Reflect.get(f.launcher, 'instances'), handle = vi.fn(async () => ({ ok: true })), create = vi.fn();
  Reflect.set(service, 'handle', handle); Reflect.set(service, 'createCompanion', create);
  const route = Reflect.get(f.launcher, 'handle').bind(f.launcher);
  for (const companionId of ['fish', 'gpt', 'claude']) {
    expect(await route({ type: 'companion.environment.state', companionId, name: companionId })).toMatchObject({ ok: true, companionEnvironment: { mode: 'shared', instance: { id: 'default' } } });
    expect(await route({ type: 'companion.environment.ensure', companionId, name: companionId })).toMatchObject({ ok: true, companionEnvironment: { mode: 'shared', instance: { id: 'default' } } });
    expect(await route({ type: 'companion.environment.open', companionId, name: companionId })).toMatchObject({ ok: true, companionEnvironment: { mode: 'shared', instance: { id: 'default' } } });
  }
  expect(create).not.toHaveBeenCalled(); expect(handle).toHaveBeenCalledTimes(3);
  for (const call of handle.mock.calls) expect(call).toEqual([{ type: 'instance.open', instanceId: 'default' }]);
});
it('does not shut down a shared DSH Host when one character is stopped', async () => {
  const f = fixture(), stop = vi.fn(); Reflect.set(Reflect.get(f.launcher, 'instances'), 'stop', stop);
  await f.launcher.stopCompanionEnvironment('fish'); await f.launcher.stopCompanionEnvironment('claude');
  expect(stop).not.toHaveBeenCalled(); expect((await f.launcher.resolveCompanionInstance('gpt', 'GPT')).id).toBe('default');
});
it.each(['0.2.2-rc.1','0.2.2-alpha.3','0.3.0','1.0.0-beta.1','0.2.1-rc.2'])('selects the native Web adapter independently of DSH version %s', async version => {
  const f=fixture(false,version); expect((await f.launcher.resolveBotInstance()).id).toBe('default');
  expect((await f.launcher.resolveBotInstance('selected')).id).toBe('selected');expect(f.create).not.toHaveBeenCalled();
});
it('accepts a legacy Host only through an explicit binding and does not choose it for a new lane', async () => {
  const f = fixture(); f.records.splice(0, 2);
  await expect(f.launcher.resolveBotInstance()).rejects.toThrow('创建或选择一个共享执行实例');
  expect((await f.launcher.resolveBotInstance('old-bot')).id).toBe('old-bot');
  expect(f.create).not.toHaveBeenCalled();
});
it('accepts a historical profile for new shared work when the user explicitly selected it as default', async () => {
  const f = fixture(); f.records[0]!.isDefault = false; f.records[2]!.isDefault = true;
  expect((await f.launcher.resolveBotInstance()).id).toBe('old-bot');
  expect(f.launcher.companionCapabilityState('claude')).toMatchObject({ mode: 'shared', instanceId: 'old-bot', configured: true });
  expect(f.create).not.toHaveBeenCalled();
});
it('requires user-confirmed instance creation even after a runtime has been installed', async () => {
  const f = fixture(true); f.records.splice(0);
  const selected = await Promise.allSettled([f.launcher.resolveBotInstance(), f.launcher.resolveBotInstance()]);
  expect(selected.every(value => value.status === 'rejected')).toBe(true);
  expect(f.create).not.toHaveBeenCalled(); expect(f.ensureHost).not.toHaveBeenCalled(); expect(f.records).toHaveLength(0);
});
it('reports the same configured state and revision for every companion, independent of old private ownership', async () => {
  const f = fixture(), service = Reflect.get(f.launcher, 'instances');
  Reflect.set(service, 'companion', () => undefined);
  Reflect.set(f.records[1]!, 'companionId', 'fish');
  const fish = f.launcher.companionCapabilityState('fish'), gpt = f.launcher.companionCapabilityState('gpt');
  expect(fish).toMatchObject({ mode: 'shared', configured: true, status: 'running', instanceId: 'default' });
  expect(gpt).toEqual(fish);
  expect((await f.launcher.resolveCompanionInstance('fish', '大肥鱼')).id).toBe('default');
  expect(f.ensureHost).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});
it('keeps terminal context separate while allowing an existing legacy profile to become the shared default', async () => {
  const f = fixture(), own = f.records[1]!; Reflect.set(own, 'companionId', 'fish');
  vi.spyOn(f.launcher, 'state').mockReturnValue({ supported: true } as ReturnType<DshLauncher['state']>);
  const instances = Reflect.get(f.launcher, 'instances'), cli = Reflect.get(f.launcher, 'cliTerminal');
  const prepare = vi.fn(async () => ({ instance: own })), select = vi.fn(async () => undefined), defaults = vi.fn(async () => ({ ok: true }));
  Reflect.set(instances, 'prepareCli', prepare); Reflect.set(instances, 'handle', defaults); Reflect.set(cli, 'selectContext', select);
  const route = Reflect.get(f.launcher, 'handle').bind(f.launcher);
  expect(await route({ type: 'cli.select', instanceId: own.id })).toMatchObject({ ok: true });
  expect(prepare).toHaveBeenCalledExactlyOnceWith(own.id); expect(select).toHaveBeenCalledOnce(); expect(defaults).not.toHaveBeenCalled();
  expect(await route({ type: 'instance.default', instanceId: own.id })).toMatchObject({ ok: true });
  expect(prepare).toHaveBeenCalledTimes(2); expect(defaults).toHaveBeenCalledExactlyOnceWith({ type: 'instance.default', instanceId: own.id });
});
it('prevents runtime deletion or cleanup during an explicit role provisioning commit', async () => {
  const f = fixture(), own = { ...f.records[1]!, companionId: 'fish' };
  vi.spyOn(f.launcher, 'state').mockReturnValue({ supported: true } as ReturnType<DshLauncher['state']>);
  let complete!: (value: typeof own) => void;
  Reflect.set(Reflect.get(f.launcher, 'instances'), 'createCompanion', () => new Promise(resolve => { complete = resolve; }));
  const route = Reflect.get(f.launcher, 'handle').bind(f.launcher);
  const pending = route({ type: 'companion.environment.create', companionId: 'fish', name: '大肥鱼', runtimeId: 'compatible' });
  await expect(route({ type: 'runtime.delete', runtimeId: 'compatible' })).rejects.toThrow('正在保存角色实例绑定');
  await expect(route({ type: 'runtime.cleanup' })).rejects.toThrow('正在保存角色实例绑定');
  complete(own); expect(await pending).toMatchObject({ ok: true });
});
it('validates actual role identity before either binding mutation touches the native catalogue', async () => {
  const f = fixture();
  vi.spyOn(f.launcher, 'state').mockReturnValue({ supported: true } as ReturnType<DshLauncher['state']>);
  const create = vi.fn(), bind = vi.fn(), validate = vi.fn(() => { throw new Error('角色不存在。'); });
  Reflect.set(f.launcher, 'validateCompanion', validate);
  Reflect.set(Reflect.get(f.launcher, 'instances'), 'createCompanion', create);
  Reflect.set(Reflect.get(f.launcher, 'instances'), 'bindCompanion', bind);
  const route = Reflect.get(f.launcher, 'handle').bind(f.launcher);
  await expect(route({ type: 'companion.environment.create', companionId: 'missing-role', name: '角色', runtimeId: 'compatible' })).rejects.toThrow('角色不存在');
  await expect(route({ type: 'companion.environment.bind', companionId: 'missing-role', name: '角色', instanceId: 'default' })).rejects.toThrow('角色不存在');
  expect(validate).toHaveBeenCalledTimes(2); expect(create).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
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
  const f = fixture();
  f.ensureHost.mockResolvedValue(new NativeHostClient(43210, 'a'.repeat(64), 123));
  const observe = Reflect.get(f.launcher, 'observeExecutionCapabilities') as () => void;
  observe.call(f.launcher); await vi.advanceTimersByTimeAsync(350);
  expect(f.ensureHost).toHaveBeenCalledExactlyOnceWith('default', undefined, { automatic: true });
  f.select('old-bot'); observe.call(f.launcher); await vi.advanceTimersByTimeAsync(350);
  f.select('selected'); observe.call(f.launcher); await vi.advanceTimersByTimeAsync(350);
  expect(f.ensureHost).toHaveBeenCalledExactlyOnceWith('default', undefined, { automatic: true });
});
it('invalidates Router capability facts only when the shared execution selection or runtime changes', () => {
  vi.useFakeTimers();
  const f = fixture(), changed = vi.fn();
  Reflect.set(f.launcher, 'onExecutionCapabilitiesChanged', changed);
  const observe = Reflect.get(f.launcher, 'observeExecutionCapabilities') as () => void;
  observe.call(f.launcher);
  Reflect.set(f.records[1]!, 'companionId', 'fish'); observe.call(f.launcher); expect(changed).not.toHaveBeenCalled();
  f.records[0]!.runtimeId = 'other-runtime'; observe.call(f.launcher); expect(changed).toHaveBeenCalledTimes(1);
  f.records[0]!.isDefault = false; f.records[1]!.isDefault = true; observe.call(f.launcher); expect(changed).toHaveBeenCalledTimes(2);
});

it.each(['running', 'stopped', 'failed'])('preserves the actual instance state when native Host prewarming fails (%s)', async status => {
  vi.useFakeTimers(); const f = fixture(); f.records[0]!.status = status;
  f.ensureHost.mockRejectedValue(new Error('Native Host startup is temporarily unavailable'));
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
