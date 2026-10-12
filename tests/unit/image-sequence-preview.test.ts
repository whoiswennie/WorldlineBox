import { describe, expect, it } from "vitest";

import {
  clampSequencePreviewFrame,
  framesInPreviewRange,
  importedSequenceFrameUrl,
  nextSequencePreviewFrame,
  pendingSequenceFrameUrl,
  sequencePreviewFrameCount,
  sequencePreviewFrameUrl,
  sequencePreviewIntervalMs,
  sequencePreviewRange,
  type SequencePreviewFrame,
  type SequencePreviewSource,
} from "../../src/renderer/image-sequence-preview";

// WorldlineBox-866c20：确认面板预览的帧推进 / 范围绑定 / 帧率换档。
describe("image sequence preview", () => {
  const range = sequencePreviewRange(10, 14);

  it("keeps the range ordered no matter how the user types it", () => {
    expect(range).toEqual({ firstFrame: 10, lastFrame: 14 });
    expect(sequencePreviewRange(14, 10)).toEqual({
      firstFrame: 10,
      lastFrame: 14,
    });
  });

  it("loops inside the selected range only", () => {
    expect(nextSequencePreviewFrame(10, range, true)).toBe(11);
    expect(nextSequencePreviewFrame(13, range, true)).toBe(14);
    // 到末帧回到起始帧，绝不跑到范围外
    expect(nextSequencePreviewFrame(14, range, true)).toBe(10);
    // 暂停时停在当前帧
    expect(nextSequencePreviewFrame(12, range, false)).toBe(12);
    expect(nextSequencePreviewFrame(99, range, false)).toBe(14);
  });

  it("clamps the current frame when the range shrinks", () => {
    expect(clampSequencePreviewFrame(3, range)).toBe(10);
    expect(clampSequencePreviewFrame(30, range)).toBe(14);
    expect(clampSequencePreviewFrame(Number.NaN, range)).toBe(10);
  });

  it("derives the interval from fps inside the dialog's 1–240 range", () => {
    expect(sequencePreviewIntervalMs(30)).toBe(33);
    expect(sequencePreviewIntervalMs(1)).toBe(1000);
    expect(sequencePreviewIntervalMs(240)).toBe(4);
    // 非法输入退化到 1 FPS，而不是 0/NaN 定时器
    expect(sequencePreviewIntervalMs(0)).toBe(1000);
    expect(sequencePreviewIntervalMs(Number.NaN)).toBe(1000);
    expect(sequencePreviewIntervalMs(10_000)).toBe(4);
  });

  it("previews only frames inside the range for imported assets", () => {
    const frames: SequencePreviewFrame[] = [
      { frameNumber: 9, url: importedSequenceFrameUrl("lib", "a", "rev-a") },
      { frameNumber: 10, url: importedSequenceFrameUrl("lib", "b", "rev-b") },
      { frameNumber: 12, url: importedSequenceFrameUrl("lib", "c", "rev-c") },
      { frameNumber: 15, url: importedSequenceFrameUrl("lib", "d", "rev-d") },
    ];
    const source: SequencePreviewSource = { kind: "assets", frames };
    expect(framesInPreviewRange(frames, range).map((f) => f.frameNumber)).toEqual([
      10, 12,
    ]);
    expect(sequencePreviewFrameCount(source, range)).toBe(2);
    expect(sequencePreviewFrameUrl(source, 12)).toBe(
      "worldlinebox://source/lib/c?revision=rev-c",
    );
    // 范围内没有资产时退回最近的帧，而不是空白
    expect(sequencePreviewFrameUrl(source, 11)).toBe(
      "worldlinebox://source/lib/b?revision=rev-b",
    );
    expect(sequencePreviewFrameCount(source, sequencePreviewRange(20, 24))).toBe(0);
  });

  it("addresses pending import frames by opaque offer id and frame number", () => {
    const source: SequencePreviewSource = {
      kind: "pending",
      offerId: "offer-1",
      sequenceIndex: 2,
      firstFrame: 1,
      frameCount: 5,
    };
    expect(sequencePreviewFrameCount(source, sequencePreviewRange(1, 5))).toBe(5);
    expect(sequencePreviewFrameCount(source, sequencePreviewRange(3, 5))).toBe(3);
    // 越界帧不猜：不返回 URL
    expect(sequencePreviewFrameUrl(source, 0)).toBeUndefined();
    expect(sequencePreviewFrameUrl(source, 6)).toBeUndefined();
    expect(sequencePreviewFrameUrl(source, 3)).toBe(
      pendingSequenceFrameUrl("offer-1", 2, 3),
    );
    // offerId 必须转义，不能让它带出路径分隔符
    expect(pendingSequenceFrameUrl("a/b", 0, 1)).toBe(
      "worldlinebox://import-frame/a%2Fb/0/1",
    );
  });
});
