import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { companionWorkspaceLibrarySchema, type CompanionWorkspaceLibrary } from '../../shared/companion-workspace';

export interface CompanionWorkspaceSelection extends CompanionWorkspaceLibrary { dataRoot: string; memoryRoot: string }
/** Only a small locator lives in userData. All world, journal, attachment and vector data lives in the library. */
export class CompanionWorkspaceStore {
  private readonly file: string;
  constructor(private readonly userData: string) { this.file = path.join(userData, 'companion-library.json'); }
  async current(): Promise<CompanionWorkspaceSelection | undefined> {
    let input: unknown;
    try { input = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('伙伴资产库记录无法读取，请重新选择资产库。', { cause: error }); }
    return this.resolve(companionWorkspaceLibrarySchema.parse(input));
  }
  private async resolve(library: CompanionWorkspaceLibrary): Promise<CompanionWorkspaceSelection> {
    const libraryPath = await realpath(library.libraryPath);
    const metadata = path.join(libraryPath, '.worldlinebox');
    const [directory, database] = await Promise.all([lstat(metadata), lstat(path.join(metadata, 'library.db'))]);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !database.isFile() || database.isSymbolicLink()) throw new Error('请选择有效的 WorldlineBox 资产库。');
    await access(metadata, constants.R_OK | constants.W_OK);
    for (const target of [path.join(metadata, 'companions'), path.join(libraryPath, '伙伴记忆')]) {
      try {
        const entry = await lstat(target);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('伙伴数据目录不能是链接或普通文件。');
        const resolved = await realpath(target), relative = path.relative(libraryPath, resolved);
        if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('伙伴数据目录必须保存在所选资产库中。');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { ...library, libraryPath, dataRoot: path.join(metadata, 'companions'), memoryRoot: path.join(libraryPath, '伙伴记忆') };
  }
  async select(library: CompanionWorkspaceLibrary): Promise<CompanionWorkspaceSelection> {
    const selection = await this.resolve(library);
    await mkdir(selection.dataRoot, { recursive: true });
    await mkdir(selection.memoryRoot, { recursive: true });
    await mkdir(this.userData, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ libraryId: selection.libraryId, displayName: selection.displayName, libraryPath: selection.libraryPath }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
    return selection;
  }
}
