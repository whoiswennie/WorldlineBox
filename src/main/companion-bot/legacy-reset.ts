import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';

export interface LegacyBotResetManifest {
  version: 3; completed: boolean; targets: string[]; removed: string[];
  phase: 'planned' | 'preparing' | 'deleting' | 'done'; beforeDeleteCompleted: boolean;
  libraryPath?: string; oldMemoryRoot?: string; locatorSha256?: string; locatorRemoved?: boolean;
  completedAt?: string; lastError?: string;
}
export interface LegacyBotResetOptions {
  expectedLibrary?: string;
  expectedLocatorSha256?: string;
  removeLocator?: boolean;
  beforeDelete?(manifest: Readonly<LegacyBotResetManifest>): Promise<void>;
}
const equalPath = (a: string, b: string) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
async function inspectTarget(target: string, directory: boolean): Promise<boolean> {
  let info;
  try { info = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || !equalPath(await realpath(target), target)) {
    throw new Error('旧伙伴清理目标包含链接或类型不匹配，停止清理。');
  }
  if (directory) {
    const scan = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        if (entry.isSymbolicLink() || !equalPath(await realpath(child), child)) throw new Error('旧伙伴目录内含链接，停止清理。');
        if (entry.isDirectory()) await scan(child);
      }
    };
    await scan(target);
  }
  return true;
}

/** Explicit development tool only; production startup never invokes this.
 * The durable pre-delete barrier removes index projections before files. */
export async function resetLegacyBotData(userData: string, newRoot: string, options: LegacyBotResetOptions = {}): Promise<LegacyBotResetManifest> {
  const marker = path.join(newRoot, 'legacy-reset.json');
  let saved: LegacyBotResetManifest | undefined;
  try { saved = JSON.parse(await readFile(marker, 'utf8')) as LegacyBotResetManifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (saved?.version === 3 && saved.completed) {
    if (options.expectedLibrary && (!saved.libraryPath || !equalPath(saved.libraryPath, options.expectedLibrary))) throw new Error('清理收据属于不同资产库。');
    return saved;
  }
  const locatorFile = path.join(userData, 'companion-library.json');
  let locatorBytes: Buffer | undefined;
  try { locatorBytes = await readFile(locatorFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const locator = locatorBytes ? JSON.parse(locatorBytes.toString('utf8')) as { libraryPath?: unknown } : undefined;
  const locatorSha256 = locatorBytes ? createHash('sha256').update(locatorBytes).digest('hex') : saved?.locatorSha256;
  if (options.expectedLocatorSha256 && locatorSha256 !== options.expectedLocatorSha256) throw new Error('旧伙伴定位文件已变化，拒绝按旧清单删除。');
  const selected = typeof locator?.libraryPath === 'string' ? locator.libraryPath : saved?.version === 3 ? saved.libraryPath : undefined;
  const result: LegacyBotResetManifest = { version: 3, completed: false, phase: 'planned', beforeDeleteCompleted: false, targets: [], removed: [], locatorSha256 };
  if (selected) {
    const library = await realpath(selected);
    if (options.expectedLibrary && !equalPath(library, await realpath(options.expectedLibrary))) throw new Error('旧伙伴资产库与审核清单不一致。');
    if (!(await lstat(path.join(library, '.worldlinebox', 'library.db'))).isFile()) throw new Error('旧伙伴库不是有效资产库，停止清理。');
    result.libraryPath = library; result.oldMemoryRoot = path.join(library, '伙伴记忆');
    const expected: Array<[string, boolean]> = [
      [path.join('.worldlinebox', 'companions'), true], ['伙伴记忆', true],
      [path.join('.worldlinebox', 'companions-recovery-authority.sqlite'), false],
      [path.join('.worldlinebox', 'companions-recovery-authority.sqlite-wal'), false],
      [path.join('.worldlinebox', 'companions-recovery-authority.sqlite-shm'), false],
      [path.join('.worldlinebox', 'companions-recovery-enrollment.json'), false],
    ];
    for (const [relative, directory] of expected) {
      const target = path.resolve(library, relative), within = path.relative(library, target), nested = path.relative(target, path.resolve(newRoot));
      if (!within || path.isAbsolute(within) || within === '..' || within.startsWith('..' + path.sep)) throw new Error('旧伙伴目录越过资产库范围。');
      if (!nested || !path.isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + path.sep)) throw new Error('新伙伴目录位于旧目录内部，拒绝清理。');
      if (await inspectTarget(target, directory) || saved?.version === 3 && saved.targets.some(old => equalPath(old, target))) result.targets.push(target);
    }
    if (saved?.version === 3 && saved.libraryPath && equalPath(saved.libraryPath, library)) {
      result.removed = saved.removed.filter(target => result.targets.some(allowed => equalPath(allowed, target)));
      result.beforeDeleteCompleted = saved.beforeDeleteCompleted;
      result.locatorRemoved = saved.locatorRemoved;
    }
  }
  await mkdir(newRoot, { recursive: true });
  const persist = async () => {
    const temporary = marker + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, marker); }
    finally { await rm(temporary, { force: true }); }
  };
  await persist();
  try {
    if (!result.beforeDeleteCompleted) {
      result.phase = 'preparing'; await persist(); await options.beforeDelete?.(result);
      result.beforeDeleteCompleted = true; await persist();
    }
    result.phase = 'deleting'; await persist();
    for (const target of result.targets) {
      if (result.removed.some(removed => equalPath(removed, target))) continue;
      const directory = equalPath(target, path.join(result.libraryPath!, '.worldlinebox', 'companions')) || equalPath(target, result.oldMemoryRoot!);
      await inspectTarget(target, directory);
      await rm(target, { recursive: directory, force: true });
      result.removed.push(target); await persist();
    }
    if (options.removeLocator && locatorBytes) {
      const current = await readFile(locatorFile);
      if (createHash('sha256').update(current).digest('hex') !== locatorSha256) throw new Error('清理期间旧伙伴定位文件发生变化，未移除。');
      await rm(locatorFile); result.locatorRemoved = true; await persist();
    }
    result.completed = true; result.phase = 'done'; result.completedAt = new Date().toISOString(); await persist(); return result;
  } catch (error) { result.lastError = error instanceof Error ? error.message : String(error); await persist(); throw error; }
}
