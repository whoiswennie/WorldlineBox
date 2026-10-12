import { describe, expect, it } from "vitest";

import { LibraryOperationError } from "../../src/renderer/error-utils";
import { en } from "../../src/renderer/i18n/catalogs/en";
import { zhCN } from "../../src/renderer/i18n/catalogs/zh-CN";
import { lookupMessage } from "../../src/renderer/i18n/types";
import {
  USER_CANCELLATION_NOTICE_KEYS,
  isUserCancellation,
  userCancellationNoticeKey,
} from "../../src/renderer/user-cancellation";

// WorldlineBox-bcaf4a：用户主动停下（确认窗取消 / 进度取消）不是失败，必须走 info 通知。
describe("user cancellation", () => {
  it("treats only CANCELLED as a user stop", () => {
    expect(
      isUserCancellation(
        new LibraryOperationError({ code: "CANCELLED", message: "cancelled" }),
      ),
    ).toBe(true);
    expect(
      isUserCancellation(
        new LibraryOperationError({ code: "ASSET_NOT_FOUND", message: "gone" }),
      ),
    ).toBe(false);
    // preload/ipc 直传的 public error 形状
    expect(isUserCancellation({ code: "CANCELLED" })).toBe(true);
    expect(isUserCancellation({ code: "INTERNAL_ERROR" })).toBe(false);
    expect(isUserCancellation(new Error("boom"))).toBe(false);
    expect(isUserCancellation(null)).toBe(false);
    expect(isUserCancellation(undefined)).toBe(false);
  });

  it("gives every stoppable operation its own notice key", () => {
    const keys = Object.values(USER_CANCELLATION_NOTICE_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(userCancellationNoticeKey("diskDelete")).toBe("toast.diskDeleteCancelled");
    expect(userCancellationNoticeKey("permanentDelete")).toBe(
      "toast.permanentDeleteCancelled",
    );
    expect(userCancellationNoticeKey("emptyTrash")).toBe(
      "toast.emptyTrashCancelled",
    );
    expect(userCancellationNoticeKey("libraryDelete")).toBe(
      "toast.libraryDeleteCancelled",
    );
  });

  it("names the operation in both locales instead of a bare 'cancelled'", () => {
    const generic = lookupMessage(zhCN, "error.code.CANCELLED");
    expect(generic).toBe("操作已取消，没有做任何改动。");

    const zhCopy = [
      [USER_CANCELLATION_NOTICE_KEYS.diskDelete, "已取消从硬盘删除。"],
      [USER_CANCELLATION_NOTICE_KEYS.permanentDelete, "已取消永久删除。"],
      [USER_CANCELLATION_NOTICE_KEYS.emptyTrash, "已取消清空回收站。"],
      [USER_CANCELLATION_NOTICE_KEYS.libraryDelete, "已取消从硬盘删除资源库。"],
    ] as const;
    for (const [key, expected] of zhCopy) {
      expect(lookupMessage(zhCN, key)).toBe(expected);
      // 不能退化成「操作已取消。」这种不点名操作的空句
      expect(lookupMessage(zhCN, key)).not.toBe("操作已取消。");
    }

    const enCopy = [
      [USER_CANCELLATION_NOTICE_KEYS.diskDelete, "Cancelled deleting from disk."],
      [USER_CANCELLATION_NOTICE_KEYS.permanentDelete, "Cancelled permanent delete."],
      [USER_CANCELLATION_NOTICE_KEYS.emptyTrash, "Cancelled emptying Trash."],
      [
        USER_CANCELLATION_NOTICE_KEYS.libraryDelete,
        "Cancelled deleting the library from disk.",
      ],
    ] as const;
    for (const [key, expected] of enCopy) {
      expect(lookupMessage(en, key)).toBe(expected);
      expect(lookupMessage(en, key)).not.toBe("Operation cancelled.");
    }
  });
});
