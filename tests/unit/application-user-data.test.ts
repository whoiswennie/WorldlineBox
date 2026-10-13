import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveApplicationUserData } from '../../src/main/application-user-data';

const appDataPath = path.resolve('user-profile', 'AppData');
const tmpDirectory = path.resolve('temporary-profile');
const resolve = (env: NodeJS.ProcessEnv = {}, pid = 123) => resolveApplicationUserData({ appDataPath, tmpDirectory, pid, env });

describe('shared application user-data path', () => {
  it('uses the same user profile for development and installed distributions', () => {
    const development = resolve({ WORLDLINEBOX_DISTRIBUTION: 'development', WORLDLINEBOX_DEV_USER_DATA_PATH: path.resolve('.tools/dev-user-data') });
    const installed = resolve({ WORLDLINEBOX_DISTRIBUTION: 'release' });
    expect(development).toEqual(installed);
    expect(installed.userDataPath).toBe(path.join(appDataPath, 'WorldlineBox'));
    expect(installed.mode).toBe('shared');
  });

  it('honors an absolute unified override in either distribution', () => {
    const override = path.resolve('custom-profile');
    expect(resolve({ WORLDLINEBOX_USER_DATA_PATH: override, WORLDLINEBOX_DISTRIBUTION: 'development' }).userDataPath).toBe(override);
    expect(resolve({ WORLDLINEBOX_USER_DATA_PATH: override, WORLDLINEBOX_DISTRIBUTION: 'release' }).mode).toBe('override');
    expect(() => resolve({ WORLDLINEBOX_USER_DATA_PATH: 'relative-profile' })).toThrow('absolute');
  });

  it('prioritizes E2E isolation over shared overrides and multi-instance mode', () => {
    const testPath = path.resolve('e2e-profile');
    const selected = resolve({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: testPath, WORLDLINEBOX_USER_DATA_PATH: path.resolve('custom-profile'), WORLDLINEBOX_ALLOW_MULTI_INSTANCE: '1' });
    expect(selected.userDataPath).toBe(testPath);
    expect(selected.mode).toBe('e2e');
    expect(resolve({ WORLDLINEBOX_E2E: '1' }).userDataPath).toBe(path.join(tmpDirectory, 'worldlinebox-e2e-user-data', '123'));
    expect(() => resolve({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: 'relative-test' })).toThrow('absolute');
  });

  it('isolates only explicitly requested concurrent development processes', () => {
    const first = resolve({ WORLDLINEBOX_ALLOW_MULTI_INSTANCE: '1' }, 42);
    const second = resolve({ WORLDLINEBOX_ALLOW_MULTI_INSTANCE: '1' }, 43);
    expect(first.mode).toBe('multi-instance');
    expect(first.userDataPath).toBe(path.join(first.sharedUserDataPath, 'dev-instances', 'pid-42'));
    expect(second.userDataPath).not.toBe(first.userDataPath);
    expect(resolve().userDataPath).toBe(first.sharedUserDataPath);
    expect(() => resolve({}, 0)).toThrow('process id');
  });
});
