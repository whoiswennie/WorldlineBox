import { symlinkSync } from 'node:fs';

/** Directory junctions exercise the same no-link boundary without elevated Windows privileges. */
export function directorySymlink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Skip only when this Windows account cannot create an actual file symlink. */
export function fileSymlinkOrSkip(target: string, link: string, skip: () => void): boolean {
  try {
    symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      skip();
      return false;
    }
    throw error;
  }
}
