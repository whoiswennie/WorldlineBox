import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
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
    await this.migrateLegacy(selection.dataRoot);
    await mkdir(this.userData, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ libraryId: selection.libraryId, displayName: selection.displayName, libraryPath: selection.libraryPath }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
    return selection;
  }
  private async migrateLegacy(destination: string): Promise<void> {
    const source = path.resolve(this.userData, 'companions');
    if (source === path.resolve(destination)) return;
    const pending = path.join(destination, 'migration.pending.json');
    let resuming = false;
    try { await lstat(pending); resuming = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!resuming) try { await lstat(path.join(destination, 'messages.sqlite')); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await lstat(path.join(source, 'messages.sqlite')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    // Do not traverse runtime junctions. These two folders are derived and are rebuilt from the source ledger.
    await writeFile(pending, JSON.stringify({ source, startedAt: new Date().toISOString() }), 'utf8');
    const entries = (await readdir(source, { withFileTypes: true })).filter(entry => !['vcp', 'vcp-context'].includes(entry.name));
    for (const entry of entries) {
      const from = path.join(source, entry.name), to = path.join(destination, entry.name);
      if (entry.isSymbolicLink()) throw new Error('旧伙伴目录包含链接，请先在原目录处理后重新选择资产库。');
      await cp(from, to, { recursive: true, force: false, errorOnExist: false, dereference: false });
      if (await treeDigest(from) !== await treeDigest(to)) throw new Error('伙伴资料迁移校验未通过，原目录已保留。');
    }
    await writeFile(path.join(destination, 'migration.json'), JSON.stringify({ source, completedAt: new Date().toISOString(), verified: true }), 'utf8');
    // Verified authoritative data has moved. The derived indexes can also be discarded safely.
    if (path.dirname(source) !== path.resolve(this.userData) || path.basename(source) !== 'companions') throw new Error('旧伙伴目录范围无效。');
    await rm(source, { recursive: true });
    await rm(pending);
  }
}
async function treeDigest(file: string): Promise<string> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error('伙伴资料不能通过链接跨越存储目录。');
  if (info.isDirectory()) {
    const children = (await readdir(file)).sort();
    const values: string[] = [];
    for (const child of children) values.push(`${child}\n${await treeDigest(path.join(file, child))}`);
    return createHash('sha256').update(values.join('\n')).digest('hex');
  }
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
