import { copyFile, link, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DshRuntime } from '../../../src/shared/dsh-launcher';

/** Read-only SDK fixture: link immutable sealed files, never user saves or credentials. */
export async function seedNativeRuntime(manager: string, runtime: DshRuntime, profile: string): Promise<void> {
  const source = path.join(manager, 'runtimes', runtime.id);
  const target = path.join(profile, 'dsh-launcher/runtimes', runtime.id);
  const seal = JSON.parse(await readFile(path.join(source, 'seal.json'), 'utf8')) as { files: Array<{ path: string }> };
  await mkdir(path.join(target, 'program'), { recursive: true });
  let next = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    for (let index = next++; index < seal.files.length; index = next++) {
      const relative = seal.files[index]!.path;
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw Error('Unsafe sealed fixture path');
      const original = path.join(source, 'program', relative), destination = path.join(target, 'program', relative);
      const info = await lstat(original); if (!info.isFile() || info.isSymbolicLink()) throw Error('Native fixture must contain ordinary sealed files');
      await mkdir(path.dirname(destination), { recursive: true });
      await link(original, destination).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== 'EXDEV') throw error; await copyFile(original, destination); });
    }
  }));
  await copyFile(path.join(source, 'seal.json'), path.join(target, 'seal.json'));
  await writeFile(path.join(profile, 'dsh-launcher/runtimes.json'), JSON.stringify([runtime]));
}
