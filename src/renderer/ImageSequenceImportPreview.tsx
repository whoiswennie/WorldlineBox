import { useEffect, useMemo, useState } from "react";

import {
  clampSequencePreviewFrame,
  nextSequencePreviewFrame,
  sequencePreviewFrameCount,
  sequencePreviewFrameUrl,
  sequencePreviewIntervalMs,
  sequencePreviewRange,
  type SequencePreviewSource,
} from "./image-sequence-preview";
import { useT } from "./i18n";

export interface ImageSequenceImportPreviewProps {
  /** 当前这一组的预览来源（库内资产或导入候选帧）；为空时不显示预览。 */
  readonly source: SequencePreviewSource | null;
  readonly firstFrame: number;
  readonly lastFrame: number;
  readonly fps: number;
  /** 导入进行中时停住预览，避免和真实导入抢 IO。 */
  readonly paused?: boolean;
}

/**
 * WorldlineBox-866c20：确认面板里的序列预览。改范围或帧率都会立刻重排/换档，
 * 不用等确认导入；预览只在当前范围里循环，不把隐藏帧写进主浏览队列。
 */
export function ImageSequenceImportPreview({
  source,
  firstFrame,
  lastFrame,
  fps,
  paused = false,
}: ImageSequenceImportPreviewProps) {
  const t = useT();
  const range = useMemo(
    () => sequencePreviewRange(firstFrame, lastFrame),
    [firstFrame, lastFrame],
  );
  const frameCount = useMemo(
    () => (source ? sequencePreviewFrameCount(source, range) : 0),
    [source, range],
  );
  const [currentFrame, setCurrentFrame] = useState(() =>
    clampSequencePreviewFrame(range.firstFrame, range),
  );

  // 改范围时不写 state：播放头只在定时器里推进，渲染前统一 clamp 回当前范围，
  // 因此缩小范围不会留下已被排除的帧（也避免在 effect 里直接 setState）。
  useEffect(() => {
    if (paused || !source || frameCount === 0) return undefined;
    const timer = window.setInterval(() => {
      setCurrentFrame((frame) => nextSequencePreviewFrame(frame, range, true));
    }, sequencePreviewIntervalMs(fps));
    return () => window.clearInterval(timer);
  }, [fps, frameCount, paused, range, source]);

  const frameUrl = source
    ? sequencePreviewFrameUrl(
        source,
        clampSequencePreviewFrame(currentFrame, range),
      )
    : undefined;

  if (!source || frameCount === 0 || frameUrl === undefined) {
    return (
      <div className="image-sequence-preview" data-sequence-preview="empty">
        <p className="field-help">
          {t("dialog.imageSequenceImport.previewUnavailable")}
        </p>
      </div>
    );
  }

  return (
    <div className="image-sequence-preview" data-sequence-preview="ready">
      <img
        alt={t("dialog.imageSequenceImport.previewAlt")}
        className="image-sequence-preview-frame"
        draggable={false}
        src={frameUrl}
      />
      <p className="field-help image-sequence-preview-caption">
        {t("dialog.imageSequenceImport.previewCaption", {
          frame: clampSequencePreviewFrame(currentFrame, range),
          count: frameCount,
          fps,
        })}
      </p>
    </div>
  );
}
