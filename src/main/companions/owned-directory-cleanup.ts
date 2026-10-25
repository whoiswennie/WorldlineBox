import { lstat, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const component = /^[a-zA-Z0-9_-]{1,100}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** Call only after the owner's writers and processes have drained. Quarantine
 * is deterministic so a failed Windows cleanup can resume after restart. */
export async function removeOwnedDirectory(parent: string, owner: string, jobId: string): Promise<void> {
  if (!path.isAbsolute(parent) || !component.test(owner) || !component.test(jobId)) throw new Error('清理目录归属无效。');
  let root: string;
  try {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('清理根目录不能是链接。');
    root = await realpath(parent);
  } catch (error) { if (missing(error)) return; throw error; }
  const source = path.resolve(root, owner), retired = path.resolve(root, `.reset-${owner}-${jobId}`);
  if (path.dirname(source) !== root || path.dirname(retired) !== root) throw new Error('清理目录超出归属范围。');
  const ordinary = async (target: string) => {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== target) throw new Error('待清理目录不是普通归属目录。');
      return true;
    } catch (error) { if (missing(error)) return false; throw error; }
  };
  const retry = async (work: () => Promise<void>) => {
    for (let attempt = 0; ; attempt++) try { await work(); return; }
    catch (error) {
      if (attempt >= 7 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(Math.min(1500, 100 * 2 ** attempt));
    }
  };
  if (await ordinary(source)) {
    if (await ordinary(retired)) throw new Error('上次清理尚未完成，不能覆盖新的目录。');
    await retry(() => rename(source, retired));
  }
  if (await ordinary(retired)) await retry(() => rm(retired, { recursive: true, force: true }));
}
