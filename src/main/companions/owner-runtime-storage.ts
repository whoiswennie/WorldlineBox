import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';

export async function companionRuntimeDirectory(directory: string, create = false): Promise<boolean> {
  if (!path.isAbsolute(directory)) throw new Error('伙伴索引目录必须是绝对路径。');
  let current = path.parse(directory).root;
  for (const part of path.relative(current, directory).split(path.sep)) {
    current = path.join(current, part); let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('伙伴索引目录必须为真实且未链接的目录。');
  } return true;
}

/** Returned only by the host's canonical asset-library resolver. */
export interface CompanionOwnerRuntimePaths { ownerId: string; ownerRoot: string; indexRoot: string; workspaceRoot: string }
export interface CompanionOwnerRuntimeStorage extends CompanionOwnerRuntimePaths {
  ownerPrompts: { aimemoTemplate: string; timelineTemplate: string; summaryTemplate: string } }
export function companionRuntimeOwner(ownerId: string): string {
  if (typeof ownerId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(ownerId)) throw new Error('记忆所属伙伴标识无效。');
  return ownerId;
}
export function companionOwnerRuntimePaths(ownerId: string, storage: CompanionOwnerRuntimePaths): CompanionOwnerRuntimePaths {
  companionRuntimeOwner(ownerId);
  if (storage.ownerId !== ownerId || ![storage.ownerRoot, storage.indexRoot, storage.workspaceRoot].every(value => typeof value === 'string' && path.isAbsolute(value)))
    throw new Error('记忆索引目录未绑定可信伙伴。');
  const workspaceRoot = path.resolve(storage.workspaceRoot), ownerRoot = path.resolve(storage.ownerRoot), indexRoot = path.resolve(storage.indexRoot);
  if (ownerRoot !== path.join(workspaceRoot, ownerId) || indexRoot !== path.join(ownerRoot, '.认知索引'))
    throw new Error('记忆索引目录不属于当前伙伴资产目录。');
  return Object.freeze({ ownerId, workspaceRoot, ownerRoot, indexRoot });
}
export function companionOwnerRuntimeStorage(ownerId: string, storage: CompanionOwnerRuntimeStorage): CompanionOwnerRuntimeStorage {
  const paths = companionOwnerRuntimePaths(ownerId, storage);
  if (!storage.ownerPrompts || ['aimemoTemplate', 'timelineTemplate', 'summaryTemplate'].some(key => {
    const value = storage.ownerPrompts[key as keyof typeof storage.ownerPrompts]; return typeof value !== 'string' || !value.trim();
  }))
    throw new Error('伙伴实时记忆聚焦提示词不可用。');
  return Object.freeze({ ...paths, ownerPrompts: Object.freeze({
    aimemoTemplate: storage.ownerPrompts.aimemoTemplate, timelineTemplate: storage.ownerPrompts.timelineTemplate, summaryTemplate: storage.ownerPrompts.summaryTemplate }) });
}
