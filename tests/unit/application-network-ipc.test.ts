import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { LauncherNetwork } from '../../src/main/dsh/launcher-network';
import type { ApplicationNetworkResponse, ApplicationNetworkState } from '../../src/shared/application-network';
import { APPLICATION_NETWORK_CHANGED, APPLICATION_NETWORK_REQUEST } from '../../src/shared/application-network';

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<ApplicationNetworkResponse>>(),
  handle: vi.fn(), removeHandler: vi.fn(), state: vi.fn(), clear: vi.fn(),
  diagnosticListeners: new Set<() => void>(), stopDiagnostics: vi.fn(),
  pixivTest: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: mocked.handle, removeHandler: mocked.removeHandler } }));
vi.mock('../../src/main/application-network', () => ({
  applicationNetworkState: mocked.state,
  clearApplicationNetworkDiagnostics: mocked.clear,
  testApplicationPixivNetwork: mocked.pixivTest,
  onApplicationNetworkDiagnostics: (listener: () => void) => {
    mocked.diagnosticListeners.add(listener);
    return () => { mocked.stopDiagnostics(); mocked.diagnosticListeners.delete(listener); };
  },
}));
import { registerApplicationNetworkIpc } from '../../src/main/application-network-ipc';

let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); mocked.handlers.clear(); mocked.diagnosticListeners.clear();
  mocked.handle.mockImplementation((channel, handler) => { mocked.handlers.set(channel, handler); });
  mocked.removeHandler.mockImplementation(channel => { mocked.handlers.delete(channel); });
});
afterEach(() => { dispose?.(); dispose = undefined; });

function fixture() {
  const settings: ApplicationNetworkState['settings'] = { proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7896', proxyProfiles: [], npmRegistry: 'https://registry.npmjs.org', npmDownloadRoute: 'auto', pythonIndex: 'https://pypi.org/simple', githubMirror: 'auto', githubMirrorUrl: '' };
  const state: ApplicationNetworkState = { settings, revision: 8, recentFailures: [] };
  const mainFrame = {} as Electron.WebFrameMain;
  const send = vi.fn();
  const owner = { isDestroyed: vi.fn(() => false), webContents: { mainFrame, send, isDestroyed: vi.fn(() => false) } } as unknown as BrowserWindow;
  let activeOwner: BrowserWindow | null | undefined = owner;
  const policyListeners = new Set<() => void>();
  const stopPolicy = vi.fn();
  const network = {
    subscribe: vi.fn((listener: () => void) => { policyListeners.add(listener); return () => { stopPolicy(); policyListeners.delete(listener); }; }),
    inspect: vi.fn(async () => undefined), save: vi.fn(async () => undefined), patch: vi.fn(async () => undefined),
    setProxyEnabled: vi.fn(async () => undefined), test: vi.fn(async () => 'npm: OK\nGitHub: FAILED'),
  };
  mocked.state.mockReturnValue(state);
  mocked.clear.mockImplementation(() => { state.recentFailures = []; for (const listener of mocked.diagnosticListeners) listener(); });
  dispose = registerApplicationNetworkIpc(() => activeOwner, network as unknown as LauncherNetwork);
  const event = { sender: owner.webContents, senderFrame: mainFrame } as IpcMainInvokeEvent;
  const request = (input: unknown, from = event) => mocked.handlers.get(APPLICATION_NETWORK_REQUEST)!(from, input);
  return { network, state, settings, event, owner, send, request, policyListeners, stopPolicy, setOwner(value: BrowserWindow | null | undefined) { activeOwner = value; } };
}

it('registers one application endpoint and reads the policy without activating launcher operations', async () => {
  const subject = fixture();
  expect(mocked.handle).toHaveBeenCalledOnce();
  expect(await subject.request({ type: 'state' })).toEqual({ ok: true, state: subject.state });
  // Avoid matcher pretty-printing the policy object: Node treats its inspect
  // method as a custom inspector and would invoke the mocked network action.
  expect(mocked.state.mock.calls[0]![0] === subject.network).toBe(true);
  expect(subject.network.inspect).not.toHaveBeenCalled();
  expect(subject.network.save).not.toHaveBeenCalled();
});

it('requires both the current owner webContents and its exact main frame', async () => {
  const subject = fixture();
  const rejected = [
    { ...subject.event, sender: { id: subject.owner.webContents.id } },
    { ...subject.event, senderFrame: {} },
    { ...subject.event, senderFrame: undefined },
    { ...subject.event, senderFrame: null },
  ];
  for (const event of rejected) expect(await subject.request({ type: 'network.proxy.toggle', enabled: false }, event as IpcMainInvokeEvent)).toEqual({ ok: false, error: '无权访问全局网络设置。' });
  subject.owner.isDestroyed = vi.fn(() => true);
  expect((await subject.request({ type: 'state' })).ok).toBe(false);
  subject.setOwner(null); expect((await subject.request({ type: 'state' })).ok).toBe(false);
  subject.setOwner(undefined); expect((await subject.request({ type: 'state' })).ok).toBe(false);
  expect(mocked.state).not.toHaveBeenCalled();
  expect(subject.network.setProxyEnabled).not.toHaveBeenCalled();
});

it.each([null, { type: 'state', extra: 'forbidden' }, { type: 'network.patch', patch: { proxyMode: 'invalid' } }, { type: 'network.patch', patch: { arbitrary: true } }, { type: 'network.proxy.toggle', enabled: 'true' }, { type: 'network.save', settings: {} }, { type: 'instance.start', instanceId: 'one' }])('rejects invalid or unrelated requests before calling the policy: %j', async input => {
  const subject = fixture();
  expect(await subject.request(input)).toEqual({ ok: false, error: '无效的全局网络请求。' });
  expect(mocked.state).not.toHaveBeenCalled();
  for (const method of [subject.network.save, subject.network.patch, subject.network.inspect, subject.network.setProxyEnabled, subject.network.test]) expect(method).not.toHaveBeenCalled();
});

it('saves and patches the shared policy before inspecting the applied routes', async () => {
  const subject = fixture();
  expect((await subject.request({ type: 'network.save', settings: subject.settings })).ok).toBe(true);
  expect(subject.network.save).toHaveBeenCalledWith(subject.settings);
  expect(subject.network.save.mock.invocationCallOrder[0]).toBeLessThan(subject.network.inspect.mock.invocationCallOrder[0]!);
  expect((await subject.request({ type: 'network.patch', patch: { proxyMode: 'direct' } })).ok).toBe(true);
  expect(subject.network.patch).toHaveBeenCalledWith({ proxyMode: 'direct' });
  expect(subject.network.patch.mock.invocationCallOrder[0]).toBeLessThan(subject.network.inspect.mock.invocationCallOrder[1]!);
});

it.each([false, true])('routes proxy enabled=%j through the live policy and then inspects it', async enabled => {
  const subject = fixture();
  expect((await subject.request({ type: 'network.proxy.toggle', enabled })).ok).toBe(true);
  expect(subject.network.setProxyEnabled).toHaveBeenCalledWith(enabled);
  expect(subject.network.setProxyEnabled.mock.invocationCallOrder[0]).toBeLessThan(subject.network.inspect.mock.invocationCallOrder[0]!);
});

it('returns actual diagnostic test output and routes explicit inspection independently', async () => {
  const subject = fixture();
  expect(await subject.request({ type: 'network.test' })).toEqual({ ok: true, state: subject.state, text: 'npm: OK\nGitHub: FAILED' });
  expect(subject.network.test).toHaveBeenCalledOnce();
  expect(subject.network.inspect).not.toHaveBeenCalled();
  expect((await subject.request({ type: 'network.inspect' })).ok).toBe(true);
  expect(subject.network.inspect).toHaveBeenCalledOnce();
});
it('routes the Pixiv check through the authorized application network endpoint', async () => {
  const subject = fixture();
  expect((await subject.request({ type: 'network.pixiv.test' })).ok).toBe(true);
  expect(mocked.pixivTest.mock.calls[0]![0] === subject.network).toBe(true);
});

it('broadcasts policy and diagnostic changes only to the live owner and removes every subscription on disposal', async () => {
  const subject = fixture();
  for (const listener of subject.policyListeners) listener();
  for (const listener of mocked.diagnosticListeners) listener();
  expect(subject.send).toHaveBeenCalledTimes(2);
  expect(subject.send).toHaveBeenLastCalledWith(APPLICATION_NETWORK_CHANGED, subject.state);
  subject.state.recentFailures = [{ id: 'one', origin: 'https://example.com', error: 'net::ERR_CONNECTION_CLOSED', resourceType: 'image', occurredAt: '', count: 1 }];
  expect(await subject.request({ type: 'network.diagnostics.clear' })).toEqual({ ok: true, state: { ...subject.state, recentFailures: [] } });
  expect(mocked.clear).toHaveBeenCalledOnce();
  expect(subject.send).toHaveBeenCalledTimes(3);
  subject.owner.isDestroyed = vi.fn(() => true);
  for (const listener of subject.policyListeners) listener();
  expect(subject.send).toHaveBeenCalledTimes(3);
  subject.setOwner(undefined);
  for (const listener of mocked.diagnosticListeners) listener();
  expect(subject.send).toHaveBeenCalledTimes(3);
  dispose!(); dispose = undefined;
  expect(subject.stopPolicy).toHaveBeenCalledOnce();
  expect(mocked.stopDiagnostics).toHaveBeenCalledOnce();
  expect(subject.policyListeners.size).toBe(0); expect(mocked.diagnosticListeners.size).toBe(0);
  expect(mocked.removeHandler).toHaveBeenCalledWith(APPLICATION_NETWORK_REQUEST);
  expect(mocked.handlers.has(APPLICATION_NETWORK_REQUEST)).toBe(false);
});

it('returns bounded failures without losing the endpoint after a failed policy operation', async () => {
  const subject = fixture();
  subject.network.patch.mockRejectedValueOnce(new Error('x'.repeat(2100)));
  expect(await subject.request({ type: 'network.patch', patch: { proxyMode: 'direct' } })).toEqual({ ok: false, error: 'x'.repeat(2000) });
  expect(subject.network.inspect).not.toHaveBeenCalled();
  expect((await subject.request({ type: 'state' })).ok).toBe(true);
  subject.network.inspect.mockRejectedValueOnce('inspection unavailable');
  expect(await subject.request({ type: 'network.inspect' })).toEqual({ ok: false, error: 'inspection unavailable' });
});

it('isolates renderer shutdown from an already applied policy broadcast', () => {
  const subject = fixture();
  subject.send.mockImplementationOnce(() => { throw Error('WebContents was destroyed'); });
  expect(() => { for (const listener of subject.policyListeners) listener(); }).not.toThrow();
  subject.owner.webContents.isDestroyed = vi.fn(() => true);
  for (const listener of mocked.diagnosticListeners) listener();
  expect(subject.send).toHaveBeenCalledOnce();
});
