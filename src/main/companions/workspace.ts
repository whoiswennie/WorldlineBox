import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { companionWorkspaceLibrarySchema, type CompanionWorkspaceLibrary, type CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import type { LibraryWorkerClient } from '../worker-client';
import type { InternalLibrarySummary } from '../../shared/protocol/responses';

export interface CompanionWorkspaceSelection extends CompanionWorkspaceLibrary { dataRoot: string; memoryRoot: string }

/** Locator metadata can mount the UI while the same necessary library
 * admission runs. This response contains no role, avatar or conversation data. */
export async function readCompanionWorkspaceStatus(store: Pick<CompanionWorkspaceStore, 'current'>, includeLibraries: boolean,
  ports: { libraries(): Promise<CompanionWorkspaceLibrary[]>; beginAdmission?(selected: CompanionWorkspaceSelection): void }): Promise<CompanionWorkspaceResponse> {
  const selected = await store.current();
  if (selected && !includeLibraries) { ports.beginAdmission?.(selected); return { ok: true, selected }; }
  return { ok: true, selected, libraries: await ports.libraries() };
}

/** One in-flight admission, shared with the foreground. There is no retained
 * authorization cache or domain startup. Changing scope/closing stops the next
 * request; already dispatched Worker effects retain their normal settlement. */
export function createCompanionLibraryAdmission(ports: { worker(): Pick<LibraryWorkerClient, 'request'> | undefined;
  isClosing(): boolean; opened(library: InternalLibrarySummary): void }): { ensure(selected: CompanionWorkspaceSelection): Promise<void>; invalidate(): void } {
  let epoch = 0, pending: { path: string; libraryId: string; epoch: number; promise: Promise<void> } | undefined;
  return {
    invalidate() { ++epoch; },
    ensure(selected) {
      if (pending?.path === selected.libraryPath && pending.libraryId === selected.libraryId && pending.epoch === epoch) return pending.promise;
      const captured = epoch;
      const current = () => { if (ports.isClosing() || captured !== epoch) throw new Error('资产库准入已停止或选择发生变化，请在当前库重新读取。'); };
      const promise = (async () => {
        current(); const worker = ports.worker(); if (!worker) throw new Error('资产库服务暂时不可用。');
        const list = await worker.request({ type: 'library.list' }); current();
        if (!list.ok || list.type !== 'library.list') throw new Error('无法读取已打开的资产库。');
        const existing = list.libraries.find(library => library.libraryId === selected.libraryId);
        if (!existing) {
          const opened = await worker.request({ type: 'library.open', selectedLibraryPath: selected.libraryPath }); current();
          if (!opened.ok || opened.type !== 'library.opened' || opened.library.readOnly || opened.library.libraryId !== selected.libraryId) throw new Error('伙伴所选资产库无法重新打开，请检查目录后重新选择。');
          ports.opened(opened.library);
        } else if (existing.readOnly) throw new Error('伙伴资产库需要写入权限。');
        const roots = await worker.request({ type: 'linked-folder.list', libraryId: selected.libraryId }); current();
        if (!roots.ok || roots.type !== 'linked-folder.list') throw new Error('无法恢复伙伴记忆的资产目录映射。');
        if (!roots.folders.some(folder => path.resolve(folder.absoluteRootPath) === path.resolve(selected.memoryRoot))) {
          const linked = await worker.request({ type: 'asset.import-linked', libraryId: selected.libraryId, displayName: '伙伴记忆', sourceRootPath: selected.memoryRoot, companionMemory: true }); current();
          if (!linked.ok) throw new Error('伙伴目录已准备，但资产库目录映射失败，请重新选择以重试。');
        }
      })();
      pending = { path: selected.libraryPath, libraryId: selected.libraryId, epoch: captured, promise };
      void promise.finally(() => { if (pending?.promise === promise) pending = undefined; }).catch(() => undefined);
      return promise;
    },
  };
}
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
