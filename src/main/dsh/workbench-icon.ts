import path from 'node:path';
import { nativeImage, type NativeImage } from 'electron';
import { appIconImage } from '../app-icon';
import { lstat, realpath } from './disk';
import { contained } from './files';

const MAX_ICON_BYTES = 4 * 1024 * 1024;
// Read artwork only from the selected sealed Web runtime.
const FILE_CANDIDATES = [
  'resources/icon.png', 'resources/icon.ico', 'icon.png', 'icon.ico',
  'resources/app.png', 'resources/app.ico', 'resources/tray.ico',
] as const;
async function rejectLinkedComponents(root: string, relative: string, allowMissing = false): Promise<void> {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new Error('Linked DSH icon resources are not allowed.');
  }
}

async function iconFile(root: string, relative: string, allowLarge = false): Promise<string> {
  await rejectLinkedComponents(root, relative);
  const candidate = contained(root, relative);
  const stats = await lstat(candidate);
  if (!stats.isFile() || stats.size <= 0 || (!allowLarge && stats.size > MAX_ICON_BYTES)) {
    throw new Error('Invalid DSH icon resource.');
  }
  const actual = await realpath(candidate);
  const rel = path.relative(root, actual);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('DSH icon resource escapes the selected runtime.');
  }
  return actual;
}

/**
 * Supply this image to BrowserWindow.options.icon before creating the native
 * window, so Windows receives it for the title bar and taskbar as well as for
 * later setIcon calls. The runtime directory is RuntimeService.directory(id),
 * which works for user-managed versions in development and packaged builds.
 */
export async function resolveDshWorkbenchIcon(programDirectory: string): Promise<NativeImage> {
  try {
    const root = await realpath(programDirectory);
    for (const relative of FILE_CANDIDATES) {
      try {
        const image = nativeImage.createFromPath(await iconFile(root, relative));
        if (!image.isEmpty()) return image;
      } catch { /* A missing/invalid optional image must not prevent the fallback. */ }
    }
  } catch { /* Missing optional runtime artwork falls back to the app artwork. */ }
  const fallback = appIconImage();
  if (fallback && !fallback.isEmpty()) return fallback;
  // Passing undefined here would restore Electron's default atom icon. Keep
  // that packaging error visible instead of creating a misbranded window.
  throw new Error('No DSH or WorldlineBox window icon is available. Repair the application icon resources.');
}
