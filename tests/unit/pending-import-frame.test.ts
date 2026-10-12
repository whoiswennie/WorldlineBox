import { describe, expect, it } from "vitest";

import {
  pendingImportFrameMime,
  resolvePendingImportFrame,
} from "../../src/main/pending-import-frame";

// WorldlineBox-866c20：导入前预览的候选帧解析（Renderer 只给 offerId + 帧号）。
describe("pending import frame resolution", () => {
  const sequences = [
    { firstFrame: 1, framePaths: ["/tmp/a/frame_001.png", "/tmp/a/frame_002.png"] },
    { firstFrame: 10, framePaths: ["/tmp/b/shot_010.jpg", "/tmp/b/shot_011.jpg"] },
  ];

  it("maps frame numbers with the codebase's firstFrame + offset convention", () => {
    expect(
      resolvePendingImportFrame({ sequences, sequenceIndex: 0, frameNumber: 1 }),
    ).toEqual({
      absolutePath: "/tmp/a/frame_001.png",
      mimeType: "image/png",
    });
    expect(
      resolvePendingImportFrame({ sequences, sequenceIndex: 1, frameNumber: 11 }),
    ).toEqual({
      absolutePath: "/tmp/b/shot_011.jpg",
      mimeType: "image/jpeg",
    });
  });

  it("refuses out-of-range, unknown or malformed requests", () => {
    // 帧号在候选范围之外
    expect(
      resolvePendingImportFrame({ sequences, sequenceIndex: 0, frameNumber: 3 }),
    ).toBeNull();
    expect(
      resolvePendingImportFrame({ sequences, sequenceIndex: 0, frameNumber: 0 }),
    ).toBeNull();
    // 序列下标越界
    expect(
      resolvePendingImportFrame({ sequences, sequenceIndex: 9, frameNumber: 1 }),
    ).toBeNull();
    // 非整数
    expect(
      resolvePendingImportFrame({ sequences, sequenceIndex: 0, frameNumber: 1.5 }),
    ).toBeNull();
    expect(
      resolvePendingImportFrame({ sequences, sequenceIndex: -1, frameNumber: 1 }),
    ).toBeNull();
    // 候选没带路径（例如已过期/被裁剪）
    expect(
      resolvePendingImportFrame({
        sequences: [{ firstFrame: 1 }],
        sequenceIndex: 0,
        frameNumber: 1,
      }),
    ).toBeNull();
  });

  it("serves images only", () => {
    expect(pendingImportFrameMime("/tmp/a/frame_001.PNG")).toBe("image/png");
    expect(pendingImportFrameMime("/tmp/a/frame_001.tiff")).toBe("image/tiff");
    // 不是图片（或没有扩展名）一律拒绝，避免协议被当成任意文件读取器
    expect(pendingImportFrameMime("/tmp/a/notes.txt")).toBeUndefined();
    expect(pendingImportFrameMime("/tmp/a/secret")).toBeUndefined();
    expect(
      resolvePendingImportFrame({
        sequences: [{ firstFrame: 1, framePaths: ["/tmp/a/notes.txt"] }],
        sequenceIndex: 0,
        frameNumber: 1,
      }),
    ).toBeNull();
  });
});
