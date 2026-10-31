import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerCommand } from '../../shared/protocol/requests';
import type { WorkerResult } from '../../shared/protocol/responses';
import type { CompanionLearningAssetSnapshot, CompanionLearningAssetValidation, CompanionLearningGrant } from '../../shared/companion-learning';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { AssetSummary } from '../../shared/asset-types';
import { CompanionLearningReadError, type CompanionLearningAssets } from './learning-service';
import { assertCompanionExternalLearningSource, CompanionLearningSourceDenied } from './learning-source-admission';

export interface CompanionCanonicalLearningAssets extends CompanionLearningAssets {
  /** Only Main supplies canonical verification; never exposed as a model capability. */
  revalidate(filter?: { libraryId?: string; companionId?: string }): Promise<CompanionLearningAssetValidation>;
}
/** Reads existing libraries through their canonical Worker; never searches arbitrary folders. */
export function companionLearningAssets(options: { request(command: WorkerCommand): Promise<WorkerResult>; memoryRoot: string;
  storageRequest?(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }): CompanionCanonicalLearningAssets {
  const stamps = new Map<string, { fingerprint: string; contentDigest: string }>();
  const fingerprint = (info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  const cacheRead = (file: string, info: Parameters<typeof fingerprint>[0], revisionId: string) => {
    if (stamps.size >= 1024) stamps.delete(stamps.keys().next().value!);
    stamps.set(file, { fingerprint: fingerprint(info), contentDigest: revisionId.slice(-20) });
  };
  const request = async (command: WorkerCommand) => { const result = await options.request(command); if (!result.ok) throw new Error('学习资料库暂不可用，请在资产管理中检查来源。'); return result; };
  const libraries = async () => { const result = await request({ type: 'library.list' }); if (result.type !== 'library.list') throw new Error('无法列出学习资料库。'); return result.libraries; };
  const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
  const reserved = (candidate: string) => candidate.split(/[\\/]/u).some(segment => ['.worldlinebox', '伙伴记忆'].includes(segment.toLowerCase()));
  const protectedPath = async (candidate: string, libraryPath: string) => inside(await realpath(options.memoryRoot).catch(() => path.resolve(options.memoryRoot)), candidate)
    || inside(path.join(await realpath(libraryPath).catch(() => path.resolve(libraryPath)), '伙伴记忆'), candidate) || reserved(candidate);
  const folders = async (libraryId: string) => {
    const [managed, linked] = await Promise.all([request({ type: 'folder.list', libraryId }), request({ type: 'linked-folder.list', libraryId })]);
    return [
      ...(managed.type === 'folder.list' ? managed.folders.filter(folder => !reserved(folder.relativePath)).map(folder => ({ id: folder.folderId, name: folder.relativePath })) : []),
      ...(linked.type === 'linked-folder.list' ? linked.folders.filter(folder => !reserved(folder.absoluteRootPath) && !reserved(folder.relativePath ?? '') && !inside(options.memoryRoot, folder.absoluteRootPath)).map(folder => ({ id: folder.folderId ?? folder.linkedFolderId!, name: folder.displayName })) : []),
    ];
  };
  const ensure = async (grant: CompanionLearningGrant) => {
    const existing = (await libraries()).find(library => library.libraryId === grant.libraryId);
    if (existing) { if (path.resolve(existing.libraryPath) !== path.resolve(grant.libraryPath)) throw new CompanionLearningReadError('source-moved', '学习资料库的位置已变化，请重新授予来源。'); return; }
    const opened = await request({ type: 'library.open', selectedLibraryPath: grant.libraryPath });
    if (opened.type !== 'library.opened' || opened.library.libraryId !== grant.libraryId) throw new CompanionLearningReadError('source-moved', '学习资料库身份已变化，请重新选择来源。');
  };
  const describe = async (input: { libraryId: string; folderId?: string }) => {
    const library = (await libraries()).find(library => library.libraryId === input.libraryId); if (!library) throw new Error('请先在资产管理中打开要授予的资料库。');
    const folder = input.folderId ? (await folders(input.libraryId)).find(folder => folder.id === input.folderId) : undefined;
    if (input.folderId && !folder) throw new CompanionLearningReadError('source-moved', '学习目录不存在或属于伙伴私有存档。');
    return { libraryName: library.displayName, libraryPath: library.libraryPath, ...(folder ? { folderName: folder.name } : {}) };
  };
  const read = async (grant: CompanionLearningGrant, asset: AssetSummary, observe: boolean) => {
      await ensure(grant);
      // Membership is checked again immediately before the actual read.
      const verifyMembership = async () => {
        const allowed = await request({ type: 'asset.learning.page', libraryId: grant.libraryId, folderId: grant.folderId, assetId: asset.assetId, limit: 1 });
        if (allowed.type !== 'asset.learning.page' || !allowed.assets.some(current => current.assetId === asset.assetId && current.currentRevisionId === asset.currentRevisionId && current.mediaType === 'text' && !current.deletedAt))
          throw new CompanionLearningReadError('source-moved', '学习资料已移出授权目录或已发生变化，本次未收录。');
      };
      await verifyMembership();
      const source = await request({ type: 'media.get-asset-path', libraryId: grant.libraryId, assetId: asset.assetId });
      if (source.type !== 'media.asset-path') throw new Error('学习资料路径不可用。');
      const resolved = await realpath(source.absolutePath), info = await lstat(source.absolutePath, { bigint: true });
      if (await protectedPath(resolved, grant.libraryPath)) throw new CompanionLearningReadError('private-source', '伙伴私有记忆与应用运行文件不会作为学习资料来源。');
      try { await assertCompanionExternalLearningSource(source.absolutePath, { managedRoots: [options.memoryRoot, path.join(grant.libraryPath, '.worldlinebox'), path.join(grant.libraryPath, '伙伴记忆')] }); }
      catch (error) { if (error instanceof CompanionLearningSourceDenied) throw new CompanionLearningReadError('private-source', error.message); throw error; }
      if (!info.isFile() || info.isSymbolicLink()) throw new CompanionLearningReadError('private-source', '学习资料必须是资产库中可用的普通文本文件。');
      if (info.size > 2097152n) return { content: '', revisionId: asset.currentRevisionId, truncated: true };
      const handle = await open(resolved, 'r');
      try {
        const before = await handle.stat({ bigint: true });
        const same = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
        if (!same(info, before) || before.size > 2097152n) throw new Error('学习资料在打开前已经变化，本次未收录。');
        // Bound the read even if a writer grows the file after the size check.
        const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
        while (length < buffer.length) {
          const part = await handle.read(buffer, length, buffer.length - length, length);
          if (!part.bytesRead) break; length += part.bytesRead;
        }
        const bytes = buffer.subarray(0, length), after = await handle.stat({ bigint: true }), current = await lstat(resolved, { bigint: true });
        if (!same(before, after) || !same(before, current) || current.isSymbolicLink() || bytes.length !== Number(before.size)) throw new Error('学习资料在阅读过程中已经变化，本次未收录。');
        const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
        let content: string;
        try { content = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
        catch { throw new CompanionLearningReadError('unsupported-text', '学习资料不是有效的 UTF-8 或带 BOM 的 UTF-16 文本。'); }
        for (let index = 0; index < content.length; index++) {
          const code = content.charCodeAt(index);
          if (code < 32 && code !== 9 && code !== 10 && code !== 13)
            throw new CompanionLearningReadError('unsupported-text', '学习资料包含二进制数据，不作为纯文本阅读。');
        }
        await verifyMembership();
        const revisionId = asset.currentRevisionId + '_' + createHash('sha256').update(bytes).digest('hex').slice(0, 20);
        if (observe && options.storageRequest) {
          const accepted = await options.storageRequest({ type: 'learning.assets.observe', grantId: grant.id, expectedRevision: grant.revision, assetId: asset.assetId, assetRevisionId: revisionId });
          if (!accepted.ok) throw new CompanionLearningReadError('source-moved', accepted.error ?? '实际读取的资料授权已变化。');
        }
        cacheRead(resolved, current, revisionId);
        return { content, revisionId, truncated: false };
      } finally { await handle.close(); }
    };
  const api: CompanionCanonicalLearningAssets = {
    catalog: async () => Promise.all((await libraries()).map(async library => ({ libraryId: library.libraryId, displayName: library.displayName, folders: await folders(library.libraryId) }))),
    grant: describe,
    describe: async grant => { await ensure(grant); return describe(grant); },
    page: async (grant, afterId) => {
      await ensure(grant);
      const result = await request({ type: 'asset.learning.page', libraryId: grant.libraryId, folderId: grant.folderId, afterId, limit: 32 });
      if (result.type !== 'asset.learning.page') throw new Error('无法分页读取授权资料。');
      return { ...result, assets: result.assets.filter(asset => asset.mediaType === 'text' && !asset.deletedAt && !reserved(asset.relativeFilePath)) };
    },
    asset: async (grant, assetId) => {
      await ensure(grant);
      const result = await request({ type: 'asset.learning.page', libraryId: grant.libraryId, folderId: grant.folderId, assetId, limit: 1 });
      if (result.type !== 'asset.learning.page') throw new Error('无法核对学习资产。');
      return result.assets.find(asset => asset.assetId === assetId && asset.mediaType === 'text' && !asset.deletedAt && !reserved(asset.relativeFilePath));
    },
    read: (grant, asset) => read(grant, asset, true),
    revalidate: async (filter = {}) => {
      if (!options.storageRequest) throw new Error('学习资料授权验证存储尚未连接。');
      const changed = new Set<string>(), unavailable = new Set<string>(); let cursor: string | undefined, revokedSourceCount = 0;
      do {
        const response = await options.storageRequest({ type: 'learning.assets.snapshot', ...filter, cursor, limit: 64 });
        if (!response.ok || !response.learningAssetSnapshot) throw new Error(response.error ?? '无法读取学习资料验证快照。');
        const page: CompanionLearningAssetSnapshot = response.learningAssetSnapshot;
        const grants = new Map<string, 'valid' | 'revoked' | 'unavailable'>();
        const checked = new Map<string, Promise<'valid' | 'revoked' | 'unavailable'>>();
        const classify = (error: unknown): 'revoked' | 'unavailable' => error instanceof CompanionLearningReadError
          && (error.code === 'source-moved' || error.code === 'private-source' || error.code === 'unsupported-text') ? 'revoked' : 'unavailable';
        for (const entry of page.entries) if (!grants.has(entry.grant.id)) {
          try { await ensure(entry.grant); await describe(entry.grant); grants.set(entry.grant.id, 'valid'); }
          catch (error) { grants.set(entry.grant.id, classify(error)); }
        }
        const checks = [];
        for (const [index, entry] of page.entries.entries()) {
          let state = grants.get(entry.grant.id)!;
          if (state === 'valid' && entry.asset) {
            const asset = entry.asset, key = JSON.stringify([entry.grant.id, asset.assetId, asset.assetRevisionId]);
            let operation = checked.get(key);
            if (!operation) {
              operation = (async () => {
                try {
                  const current = await api.asset!(entry.grant, asset.assetId);
                  if (!current || !asset.assetRevisionId.startsWith(current.currentRevisionId + '_')) return 'revoked' as const;
                  const source = await request({ type: 'media.get-asset-path', libraryId: entry.grant.libraryId, assetId: asset.assetId });
                  if (source.type !== 'media.asset-path') return 'unavailable' as const;
                  const resolved = await realpath(source.absolutePath), info = await lstat(source.absolutePath, { bigint: true });
                  if (!info.isFile() || info.isSymbolicLink() || await protectedPath(resolved, entry.grant.libraryPath)) return 'revoked' as const;
                  const cached = stamps.get(resolved);
                  if (cached?.fingerprint === fingerprint(info)) return current.currentRevisionId + '_' + cached.contentDigest === asset.assetRevisionId ? 'valid' as const : 'revoked' as const;
                  const verified = await read(entry.grant, current, false);
                  return !verified.truncated && verified.revisionId === asset.assetRevisionId ? 'valid' as const : 'revoked' as const;
                } catch (error) { return classify(error); }
              })();
              checked.set(key, operation);
            }
            state = await operation;
          }
          checks.push({ index, state });
        }
        const applied = await options.storageRequest({ type: 'learning.assets.validate', token: page.token, checks });
        if (!applied.ok || !applied.learningAssetValidation) throw new Error(applied.error ?? '无法保存学习资料验证结果。');
        for (const owner of applied.learningAssetValidation.changedCompanionIds) changed.add(owner);
        for (const owner of applied.learningAssetValidation.unavailableCompanionIds) unavailable.add(owner);
        revokedSourceCount += applied.learningAssetValidation.revokedSourceCount; cursor = page.nextCursor;
      } while (cursor);
      return { changedCompanionIds: [...changed], unavailableCompanionIds: [...unavailable], revokedSourceCount };
    },
  };
  return api;
}
