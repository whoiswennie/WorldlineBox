import { describe, expect, it } from "vitest";

import {
  deleteOverlayDetail,
  deleteOverlayTitleKey,
  isActiveDeleteProgress,
  isDeleteProgressCancelable,
} from "../../src/renderer/delete-progress-copy";
import type { DeleteProgressEvent } from "../../src/shared/protocol/responses";

function progress(
  patch: Partial<DeleteProgressEvent> = {},
): DeleteProgressEvent {
  return {
    type: "delete.progress",
    operationId: "delete-1",
    libraryId: "library-1",
    kind: "trash",
    phase: "run",
    filesProcessed: 3,
    totalFiles: 20,
    ...patch,
  };
}

describe("delete overlay copy", () => {
  it("keeps the overlay up only while files are still being removed", () => {
    expect(isActiveDeleteProgress(progress())).toBe(true);
    expect(isActiveDeleteProgress(progress({ phase: "complete" }))).toBe(false);
    expect(isActiveDeleteProgress(progress({ phase: "cancelled" }))).toBe(false);
    expect(isActiveDeleteProgress(null)).toBe(false);
  });

  it("allows cancelling only active disk-delete progress", () => {
    expect(isDeleteProgressCancelable(progress({ kind: "disk", cancelable: true }))).toBe(true);
    expect(isDeleteProgressCancelable(progress({ kind: "trash" }))).toBe(false);
    expect(isDeleteProgressCancelable(progress({ kind: "disk", cancelable: false }))).toBe(false);
    expect(isDeleteProgressCancelable(progress({ phase: "cancelled", kind: "disk" }))).toBe(false);
  });

  it("uses trash/permanent titles and counted detail", () => {
    expect(deleteOverlayTitleKey("trash")).toBe("progress.trashingAssets");
    expect(deleteOverlayTitleKey("permanent")).toBe("progress.purgingTrash");
    expect(deleteOverlayTitleKey("disk")).toBe("progress.deletingAssets");
    // 2026-09-15：移除链接文件夹只删链接记录，既不是清空回收站也不是从硬盘删除，
    // 必须有独立标题（曾复用 'permanent' 导致弹窗显示「正在清空回收站」）。
    expect(deleteOverlayTitleKey("linked-remove")).toBe(
      "progress.removingLinkedFolder",
    );
    expect(deleteOverlayDetail(progress())).toEqual({
      key: "progress.deletingFiles",
      params: { processed: 3, total: 20 },
    });
  });
});
