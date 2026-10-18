import path from 'node:path';
import { constants } from 'node:fs';
import { copyFile, unlink } from 'node:fs/promises';
import type { WorkerCommand } from '../../shared/protocol/requests';
import type { WorkerResult } from '../../shared/protocol/responses';
import type { AssetSummary } from '../../shared/asset-types';
import type { BrowserCaptureHooks } from './capture-host';
import { safeCaptureFilename } from './capture-download';

type CaptureInput = Parameters<BrowserCaptureHooks['importStaged']>[0];
type Request = (command: WorkerCommand) => Promise<WorkerResult>;

/** Trusted native capture uses the normal import kernel for documents and audio.
 * The external extension retains its original image/video-only authority. */
export async function importCapturedFile(input: CaptureInput, request: Request): Promise<AssetSummary> {
  if (['image', 'video', 'screenshot'].includes(input.kind)) {
    const result = await request({ type: 'extension.save-from-file', libraryId: input.target.libraryId,
      targetFolderId: input.target.folderId ?? undefined, sourcePageUrl: input.sourcePageUrl, mediaUrl: input.mediaUrl,
      stagedFilePath: input.stagedFilePath, contentType: input.contentType, filename: input.filename });
    if (!result.ok) throw Error(result.error.message);
    if (result.type !== 'extension.asset-saved') throw Error('资产管理器返回了无效的采集结果。');
    return result.asset;
  }
  const filename = safeCaptureFilename(input.filename);
  const namedPath = path.join(input.stagingDirectory, filename === 'media' ? 'captured-media.txt' : filename);
  await copyFile(input.stagedFilePath, namedPath, constants.COPYFILE_EXCL);
  let pendingImport: string | undefined;
  try {
    let result = await request({ type: 'asset.import.prepare', libraryId: input.target.libraryId,
      targetFolderId: input.target.folderId ?? undefined, sourceKind: 'files', sourcePaths: [namedPath], createImageSequence: false });
    let duplicate: string | undefined;
    for (let attempt = 0; attempt < 3 && result.ok && result.type === 'asset.import.conflicts'; attempt++) {
      pendingImport = result.plan.importId;
      duplicate = result.plan.examples.find(example => example.kind === 'library-duplicate')?.existingAssetId;
      result = await request({ type: 'asset.import.resolve', importId: pendingImport, suspectedDuplicate: 'merge', nameConflict: 'keep-both' });
    }
    if (!result.ok) throw Error(result.error.message);
    if (result.type === 'asset.import.source-failure') { pendingImport = result.plan.importId; throw Error('无法读取采集文件，请重新采集。'); }
    if (result.type !== 'asset.import.completed') throw Error('采集文件未完成导入，请重试。');
    pendingImport = undefined;
    let asset = result.completion.assets[0];
    if (!asset && duplicate) {
      const existing = await request({ type: 'asset.list', libraryId: input.target.libraryId, recursive: true, assetIds: [duplicate] });
      if (existing.ok && existing.type === 'asset.list') asset = existing.assets[0];
    }
    if (!asset) throw Error('采集文件未生成可用资产，请重试。');
    // Preserve provenance without overwriting metadata on an existing duplicate.
    if (input.sourcePageUrl) {
      const metadata = await request({ type: 'asset.metadata.get', libraryId: input.target.libraryId, assetId: asset.assetId });
      if (metadata.ok && metadata.type === 'asset.metadata.got' && !metadata.metadata.sourcePageUrl) {
        await request({ type: 'asset.metadata.set', libraryId: input.target.libraryId, assetId: asset.assetId,
          expectedVersion: metadata.metadata.entityVersion, sourcePageUrl: input.sourcePageUrl });
      }
    }
    return asset;
  } finally {
    if (pendingImport) await request({ type: 'asset.import.abandon', importId: pendingImport }).catch(() => undefined);
    await unlink(namedPath).catch(() => undefined);
  }
}
