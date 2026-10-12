import path from "node:path";

/**
 * WorldlineBox-866c20：序列帧确认面板在**导入完成前**也可能出现（候选帧还没成为库内资产）。
 * Renderer 只拿得到 Main 自己发出的不透明 offerId 与帧号，真实路径由这里解析——
 * 这个模块刻意不依赖 Electron，便于单测覆盖边界与编号约定。
 */

export interface PendingSequenceCandidate {
  readonly firstFrame: number;
  readonly framePaths?: readonly string[];
}

export interface PendingImportFrame {
  readonly absolutePath: string;
  readonly mimeType: string;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
  ".exr": "image/x-exr",
  ".hdr": "image/vnd.radiance",
  ".tga": "image/x-tga",
  ".dds": "image/vnd-ms.dds",
  ".psd": "image/vnd.adobe.photoshop",
};

/** 只服务图片：候选帧本来就只可能是图片，非图片一律拒绝。 */
export function pendingImportFrameMime(
  absolutePath: string,
): string | undefined {
  return IMAGE_MIME_BY_EXTENSION[path.extname(absolutePath).toLowerCase()];
}

/**
 * 候选帧按既有约定编号：第 offset 帧 = firstFrame + offset（与 Main 的序列帧
 * 导入路径 `sequence.firstFrame + index` 一致）。越界或没有路径时返回 null，
 * 绝不猜、绝不放行范围外的文件。
 */
export function resolvePendingImportFrame(input: {
  readonly sequences: readonly PendingSequenceCandidate[];
  readonly sequenceIndex: number;
  readonly frameNumber: number;
}): PendingImportFrame | null {
  const { sequences, sequenceIndex, frameNumber } = input;
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0) return null;
  if (!Number.isInteger(frameNumber) || frameNumber < 0) return null;
  const sequence = sequences[sequenceIndex];
  if (!sequence) return null;
  const framePaths = sequence.framePaths ?? [];
  const offset = frameNumber - sequence.firstFrame;
  if (offset < 0 || offset >= framePaths.length) return null;
  const absolutePath = framePaths[offset];
  if (!absolutePath) return null;
  const mimeType = pendingImportFrameMime(absolutePath);
  if (!mimeType) return null;
  return { absolutePath, mimeType };
}
