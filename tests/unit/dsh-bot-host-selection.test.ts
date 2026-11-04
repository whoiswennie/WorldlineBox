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
function fixture(allowDefaultCreation = false) {
  // Constructor wiring remains real; suppress only the unrelated disk/network
  // initialization before supplying the trusted instance catalogue below.
  vi.spyOn(DshLauncher.prototype as unknown as { init(): Promise<void> }, 'init').mockResolvedValue();
  const launcher = new DshLauncher(() => undefined);
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
  Reflect.set(launcher, 'runtimes', { get: () => ({ version: '0.2.1-rc.5', adapter: 'node-cli-web-v1' }),
    list: () => [{ id: 'compatible', version: '0.2.1-rc.5', adapter: 'node-cli-web-v1' }] });
  Reflect.set(launcher, 'cliTerminal', { state: () => ({ selectedInstanceId: selected }) });
  return { launcher, records, create, ensureHost, release, select: (id: string) => { selected = id; } };
}
it('uses only the default compatible user instance, independent of the recently selected profile', async () => {
  const f = fixture();
  expect((await f.launcher.resolveBotInstance()).id).toBe('default');
  f.select('missing'); expect((await f.launcher.resolveBotInstance()).id).toBe('default');
  expect(f.create).not.toHaveBeenCalled(); expect(f.ensureHost).not.toHaveBeenCalled();
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
  expect(f.ensureHost).toHaveBeenCalledWith('default');
  f.release(new NativeHostClient(43210, 'a'.repeat(64), 123)); await waiting;
  expect(f.create).not.toHaveBeenCalled();
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
