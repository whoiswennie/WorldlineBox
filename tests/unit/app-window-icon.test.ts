import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions, NativeImage } from 'electron';

const fixture = vi.hoisted(() => ({ app: { isPackaged: false }, image: { isEmpty: () => false }, exists: vi.fn(), decode: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: fixture.exists }));
vi.mock('electron', () => ({ app: fixture.app, nativeImage: { createFromPath: fixture.decode } }));
import { withAppWindowIcon } from '../../src/main/app-icon';

const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
beforeAll(() => Object.defineProperty(process, 'resourcesPath', { configurable: true, value: path.join(process.cwd(), '.fixture-resources') }));
afterAll(() => { if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor); else Reflect.deleteProperty(process, 'resourcesPath'); });

beforeEach(() => { vi.clearAllMocks(); fixture.app.isPackaged = false; fixture.exists.mockReturnValue(true); fixture.decode.mockReturnValue(fixture.image); });

it('gives native children the same project icon while retaining their sandbox, preload and window options', () => {
  const options: BrowserWindowConstructorOptions = { show: false, frame: true, width: 720, webPreferences: { preload: '/observer.js', sandbox: true, contextIsolation: true, nodeIntegration: false } };
  const result = withAppWindowIcon(options);
  expect(result.icon).toBe(fixture.image); expect(options.icon).toBeUndefined();
  expect(result.webPreferences).toBe(options.webPreferences); expect(result).toMatchObject({ show: false, frame: true, width: 720 });
  expect(fixture.decode).toHaveBeenCalledWith(path.normalize(path.join(process.cwd(), 'assets/icons/app.png')));
});

it('uses packaged resource resolution and preserves an explicit workbench icon', () => {
  fixture.app.isPackaged = true;
  expect(withAppWindowIcon({}).icon).toBe(fixture.image);
  expect(fixture.decode.mock.calls[0]![0]).toBe(path.join(process.resourcesPath, 'app.png'));
  const icon = { isEmpty: () => false } as NativeImage;
  fixture.decode.mockClear(); const explicit = { icon, show: false };
  expect(withAppWindowIcon(explicit)).toBe(explicit); expect(fixture.decode).not.toHaveBeenCalled();
});

it('leaves native creation available when neither packaged icon candidate decodes', () => {
  fixture.app.isPackaged = true; fixture.decode.mockReturnValue({ isEmpty: () => true });
  const options = { show: false }; expect(withAppWindowIcon(options)).toBe(options);
  expect(fixture.decode).toHaveBeenCalledTimes(2);
});
