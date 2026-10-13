import path from 'node:path';

export interface ApplicationUserDataResolution {
  readonly userDataPath: string;
  readonly sharedUserDataPath: string;
  readonly mode: 'shared' | 'override' | 'e2e' | 'multi-instance';
}

function absoluteDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be an absolute directory path.`);
  return path.resolve(value);
}

/** Packaged and development applications deliberately use the same user-owned profile. */
export function resolveApplicationUserData(options: {
  readonly appDataPath: string;
  readonly tmpDirectory: string;
  readonly pid: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}): ApplicationUserDataResolution {
  const override = options.env.WORLDLINEBOX_USER_DATA_PATH;
  const sharedUserDataPath = override
    ? absoluteDirectory(override, 'WORLDLINEBOX_USER_DATA_PATH')
    : path.join(absoluteDirectory(options.appDataPath, 'appDataPath'), 'WorldlineBox');
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) throw new Error('Expected a positive process id.');
  if (options.env.WORLDLINEBOX_E2E === '1') {
    const explicit = options.env.WORLDLINEBOX_E2E_USER_DATA_PATH;
    return { sharedUserDataPath, mode: 'e2e', userDataPath: explicit
      ? absoluteDirectory(explicit, 'WORLDLINEBOX_E2E_USER_DATA_PATH')
      : path.join(absoluteDirectory(options.tmpDirectory, 'tmpDirectory'), 'worldlinebox-e2e-user-data', String(options.pid)) };
  }
  if (options.env.WORLDLINEBOX_ALLOW_MULTI_INSTANCE === '1') {
    return { sharedUserDataPath, mode: 'multi-instance', userDataPath: path.join(sharedUserDataPath, 'dev-instances', `pid-${options.pid}`) };
  }
  return { sharedUserDataPath, userDataPath: sharedUserDataPath, mode: override ? 'override' : 'shared' };
}
