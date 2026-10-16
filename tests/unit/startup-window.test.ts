import { afterEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], html: '', execute: vi.fn(async () => undefined), destroy: vi.fn(), quit: vi.fn() }));
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), quit: calls.quit }, nativeTheme: { shouldUseDarkColors: false }, BrowserWindow: class {
  webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), executeJavaScript: calls.execute };
  constructor(options: Record<string, unknown>) { calls.options.push(options); }
  on() {} once() {} isDestroyed() { return false; } show() {} destroy() { calls.destroy(); }
  async loadURL(url: string) { calls.html = decodeURIComponent(url.slice(url.indexOf(',') + 1)); }
} }));
vi.mock('../../src/main/app-icon', () => ({ withAppWindowIcon: (options: unknown) => options }));
import { StartupWindow } from '../../src/main/startup-window';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('shows only local sandboxed branding and records completed phase timings', async () => {
  vi.stubEnv('WORLDLINEBOX_E2E', '1'); vi.stubEnv('WORLDLINEBOX_E2E_STARTUP_SCREEN', '1'); vi.stubEnv('WORLDLINEBOX_E2E_HIDE_WINDOW', '1');
  const report = vi.fn(), startup = new StartupWindow(report); await startup.open();
  expect(calls.options.at(-1)?.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(calls.html).toContain("default-src 'none'"); expect(calls.html).toContain('data:image/png;base64,'); expect(calls.html).toContain('WorldlineBox');
  startup.set('storage', '读取本地数据'); startup.complete(); startup.complete();
  expect(report).toHaveBeenCalledWith('environment', expect.any(Number), expect.any(Number)); expect(report).toHaveBeenCalledWith('main-ready', 0, expect.any(Number)); expect(calls.destroy).toHaveBeenCalledTimes(1); expect(calls.execute).toHaveBeenCalled(); expect(calls.quit).not.toHaveBeenCalled();
});
