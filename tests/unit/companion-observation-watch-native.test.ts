import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { companionObservationRemuxArguments, createNativeCompanionObservationWatch } from '../../src/main/companions/observation-watch-native';

type DisplayHandler = NonNullable<Parameters<Electron.Session['setDisplayMediaRequestHandler']>[0]>;
type PermissionHandler = NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>;
type PermissionCheck = NonNullable<Parameters<Electron.Session['setPermissionCheckHandler']>[0]>;
type Scope = { display?: DisplayHandler; permission?: PermissionHandler; check?: PermissionCheck; partition: string;
  protocol: { handle: ReturnType<typeof vi.fn>; unhandle: ReturnType<typeof vi.fn> };
  webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }; clearStorageData: ReturnType<typeof vi.fn>;
  setDisplayMediaRequestHandler(handler: DisplayHandler | null): void; setPermissionRequestHandler(handler: PermissionHandler | null): void;
  setPermissionCheckHandler(handler: PermissionCheck | null): void };
const native = vi.hoisted(() => ({ scopes: [] as Scope[], windows: [] as Array<{ isDestroyed(): boolean; webContents: { mainFrame: { url: string } } }>,
  selected: [] as unknown[], getSources: vi.fn() }));
vi.mock('electron', () => ({
  desktopCapturer: { getSources: native.getSources },
  session: { fromPartition: (partition: string) => {
    const scope: Scope = { partition, protocol: { handle: vi.fn(), unhandle: vi.fn() }, webRequest: { onBeforeRequest: vi.fn() }, clearStorageData: vi.fn(async () => undefined),
      setDisplayMediaRequestHandler(handler) { this.display = handler ?? undefined; }, setPermissionRequestHandler(handler) { this.permission = handler ?? undefined; },
      setPermissionCheckHandler(handler) { this.check = handler ?? undefined; } };
    native.scopes.push(scope); return scope;
  } },
  BrowserWindow: class {
    private dead = false; private frame = 0;
    webContents = { mainFrame: { url: '' }, setWindowOpenHandler: vi.fn(), on: vi.fn(), executeJavaScript: vi.fn(async (script: string) => {
      if (script.includes('getDisplayMedia')) {
        // Compile the actual renderer script for syntax; desktop/media APIs
        // are controlled below and never invoked on the user's machine.
        expect(() => new Function('return ' + script)).not.toThrow();
        const selected = await new Promise(resolve => this.scope.display!({ frame: this.webContents.mainFrame, videoRequested: true, audioRequested: false } as Parameters<DisplayHandler>[0], resolve));
        native.selected.push(selected); expect(selected).toMatchObject({ video: { id: 'window:1:0' } }); return {};
      }
      if (script.includes('.frame()')) return { data: 'data:image/png;base64,AQID', offsetMs: this.frame++ * 2000 };
      return { base64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]).toString('base64'), startedAt: '2026-10-29T10:00:00.000Z',
        endedAt: '2026-10-29T10:00:02.020Z', durationMs: 2020, width: 1280, height: 720 };
    }) };
    private scope: Scope;
    constructor(options: { webPreferences: { session: Scope } }) { this.scope = options.webPreferences.session; native.windows.push(this); }
    removeMenu() { } isDestroyed() { return this.dead; } destroy() { this.dead = true; }
    async loadURL(url: string) { this.webContents.mainFrame.url = url; }
  },
}));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-29T10:00:00.000Z'); native.scopes.length = 0; native.windows.length = 0; native.selected.length = 0;
  native.getSources.mockResolvedValue([{ id: 'window:1:0', name: '编辑器', display_id: '1' }]); });
afterEach(() => vi.useRealTimers());
const input = () => ({ companionId: 'alice', source: { id: 'window:1:0', title: '编辑器', displayId: '1' }, seconds: 2, frameCount: 2,
  signal: new AbortController().signal, verify: vi.fn(async () => undefined) });

it('uses distinct private secure capture surfaces and exact native sources for concurrent partner recordings', async () => {
  const driver = createNativeCompanionObservationWatch(), a = input(), b = { ...input(), companionId: 'bob' };
  const done = Promise.all([driver(a), driver(b)]); await vi.advanceTimersByTimeAsync(2200); const result = await done;
  expect(result).toHaveLength(2); expect(result[0]!.frames.map(frame => frame.offsetMs)).toEqual([0, 2000]);
  expect(new Set(native.scopes.map(scope => scope.partition)).size).toBe(2); expect(native.selected).toHaveLength(2);
  expect(native.getSources.mock.calls.every(([query]) => JSON.stringify(query.types) === '["window"]')).toBe(true);
  expect(native.windows.every(window => window.isDestroyed())).toBe(true);
  for (const scope of native.scopes) { expect(scope.protocol.handle.mock.calls[0]![0]).toBe('https'); expect(scope.protocol.unhandle).toHaveBeenCalledWith('https');
    expect(scope.display).toBeUndefined(); expect(scope.permission).toBeUndefined(); expect(scope.check).toBeUndefined(); expect(scope.clearStorageData).toHaveBeenCalledOnce(); }
  expect(a.verify.mock.calls.length).toBeGreaterThan(6); expect(b.verify.mock.calls.length).toBeGreaterThan(6);
});

it('ends a pending recording immediately on abort and keeps remux arguments fixed and shell-free', async () => {
  const controller = new AbortController(), driver = createNativeCompanionObservationWatch();
  const done = driver({ ...input(), signal: controller.signal }).then(() => 'unexpected', error => error);
  await vi.advanceTimersByTimeAsync(1); controller.abort(new Error('真实授权已经撤回')); await vi.advanceTimersByTimeAsync(1);
  expect((await done).message).toBe('真实授权已经撤回'); expect(native.windows.every(window => window.isDestroyed())).toBe(true);
  expect(companionObservationRemuxArguments('C:/owned/source.webm', 'C:/owned/final.webm')).toEqual([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe', '-i', 'C:/owned/source.webm',
    '-map', '0:v:0', '-an', '-c', 'copy', '-f', 'webm', 'C:/owned/final.webm']);
});
