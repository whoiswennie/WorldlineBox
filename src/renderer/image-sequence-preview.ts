/**
 * WorldlineBox-866c20：序列帧确认面板下方的播放预览。
 *
 * 预览只描述「用当前帧范围 + 帧率播放」，与导入本身无关：这里全部是纯函数，
 * 便于单测覆盖帧推进 / 范围绑定 / 帧率换档；真实解码由 <img> 走既有
 * `worldlinebox://` 通道（人类验收项）。
 *
 * 两种来源：
 * - `assets`：导入后成组，帧已经是库内资产，走 `worldlinebox://source/<libraryId>/<assetId>`。
 * - `pending`：导入前的候选帧，Renderer 只拿得到 Main 发出的不透明 offerId 与帧号，
 *   路径由 Main 解析。候选帧按既有约定「第 offset 帧 = firstFrame + offset」编号，
 *   因此这里不需要把上万帧展开成数组。
 */

export interface SequencePreviewRange {
  readonly firstFrame: number;
  readonly lastFrame: number;
}

export interface SequencePreviewFrame {
  /** 文件名里的帧号（可能与数组下标不一致，例如起始帧是 0001）。 */
  readonly frameNumber: number;
  readonly url: string;
}

export type SequencePreviewSource =
  | { readonly kind: "assets"; readonly frames: readonly SequencePreviewFrame[] }
  | {
      readonly kind: "pending";
      readonly offerId: string;
      readonly sequenceIndex: number;
      readonly firstFrame: number;
      readonly frameCount: number;
    };

const MIN_FPS = 1;
const MAX_FPS = 240;

/** 面板里的帧率输入沿用容器校验范围（1–240 FPS）。 */
export function sequencePreviewIntervalMs(fps: number): number {
  const safeFps = Number.isFinite(fps)
    ? Math.min(MAX_FPS, Math.max(MIN_FPS, fps))
    : MIN_FPS;
  return Math.round(1000 / safeFps);
}

export function sequencePreviewRange(
  firstFrame: number,
  lastFrame: number,
): SequencePreviewRange {
  return {
    firstFrame: Math.min(firstFrame, lastFrame),
    lastFrame: Math.max(firstFrame, lastFrame),
  };
}

/** 帧范围变小时，把当前帧夹回范围内，避免预览停在已排除的帧上。 */
export function clampSequencePreviewFrame(
  frameNumber: number,
  range: SequencePreviewRange,
): number {
  if (!Number.isFinite(frameNumber)) return range.firstFrame;
  return Math.min(range.lastFrame, Math.max(range.firstFrame, Math.round(frameNumber)));
}

/**
 * 预览播放只在当前范围内循环；暂停时停在当前帧。
 * 与卡片播放（`advanceImageSequenceFrame`）的区别是后者在整段素材里循环，
 * 这里必须尊重用户刚选的范围。
 */
export function nextSequencePreviewFrame(
  currentFrame: number,
  range: SequencePreviewRange,
  isPlaying: boolean,
): number {
  const current = clampSequencePreviewFrame(currentFrame, range);
  if (!isPlaying) return current;
  if (range.lastFrame <= range.firstFrame) return range.firstFrame;
  return current >= range.lastFrame ? range.firstFrame : current + 1;
}

/** 当前范围里、按帧号升序的真实帧（超出范围或未解析的帧不进预览）。 */
export function framesInPreviewRange(
  frames: readonly SequencePreviewFrame[],
  range: SequencePreviewRange,
): SequencePreviewFrame[] {
  return frames
    .filter(
      (frame) =>
        frame.frameNumber >= range.firstFrame &&
        frame.frameNumber <= range.lastFrame,
    )
    .sort((left, right) => left.frameNumber - right.frameNumber);
}

/** 预览当前应显示哪一帧：范围内离 `frameNumber` 最近的那一帧。 */
export function resolveSequencePreviewFrame(
  frames: readonly SequencePreviewFrame[],
  frameNumber: number,
): SequencePreviewFrame | undefined {
  if (frames.length === 0) return undefined;
  let best: SequencePreviewFrame | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const distance = Math.abs(frame.frameNumber - frameNumber);
    if (distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

/** 该来源实际覆盖的帧号闭区间（预览范围要与它取交集）。 */
export function sequencePreviewSourceBounds(
  source: SequencePreviewSource,
): { readonly firstFrame: number; readonly lastFrame: number } {
  if (source.kind === "pending") {
    return {
      firstFrame: source.firstFrame,
      lastFrame: source.firstFrame + Math.max(0, source.frameCount - 1),
    };
  }
  if (source.frames.length === 0) return { firstFrame: 0, lastFrame: -1 };
  let first = source.frames[0]!.frameNumber;
  let last = first;
  for (const frame of source.frames) {
    first = Math.min(first, frame.frameNumber);
    last = Math.max(last, frame.frameNumber);
  }
  return { firstFrame: first, lastFrame: last };
}

/** 范围里真正能显示多少帧（用于面板上的计数）。 */
export function sequencePreviewFrameCount(
  source: SequencePreviewSource,
  range: SequencePreviewRange,
): number {
  const bounds = sequencePreviewSourceBounds(source);
  if (source.kind === "assets") {
    return framesInPreviewRange(source.frames, range).length;
  }
  const first = Math.max(range.firstFrame, bounds.firstFrame);
  const last = Math.min(range.lastFrame, bounds.lastFrame);
  return last < first ? 0 : last - first + 1;
}

/** 某一帧的预览 URL；该来源没有这一帧时返回 undefined（不猜、不越界）。 */
export function sequencePreviewFrameUrl(
  source: SequencePreviewSource,
  frameNumber: number,
): string | undefined {
  if (source.kind === "pending") {
    const offset = frameNumber - source.firstFrame;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= source.frameCount
    ) {
      return undefined;
    }
    return pendingSequenceFrameUrl(source.offerId, source.sequenceIndex, frameNumber);
  }
  return resolveSequencePreviewFrame(source.frames, frameNumber)?.url;
}

/**
 * 已入库帧（导入后成组）：走既有 source 通道。必须带 `revision`——Main 的
 * `worldlinebox://source` 只认「库 + 资产 + 修订」三元组，缺 revision 直接 400。
 */
export function importedSequenceFrameUrl(
  libraryId: string,
  assetId: string,
  revisionId: string,
): string {
  return `worldlinebox://source/${libraryId}/${assetId}?revision=${encodeURIComponent(revisionId)}`;
}

/**
 * 尚未入库的导入候选帧：Renderer 只给 Main 自己发出的不透明 offerId 与帧号，
 * 由 Main 从它保存的候选清单里解析真实路径（Renderer 永远不经手磁盘路径）。
 */
export function pendingSequenceFrameUrl(
  offerId: string,
  sequenceIndex: number,
  frameNumber: number,
): string {
  return `worldlinebox://import-frame/${encodeURIComponent(offerId)}/${sequenceIndex}/${frameNumber}`;
}
