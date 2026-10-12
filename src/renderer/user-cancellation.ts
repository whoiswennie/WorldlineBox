import { LibraryOperationError } from "./error-utils";

/**
 * 用户**主动停下**（危险操作确认窗点取消、进度浮层点取消、确认框选否）不是失败。
 * 这类结果统一走 info 通知，不许进顶部 error 条 / 阻塞错误窗
 * （`docs/internal/ui/0004-calm-error-and-copy-ux-principles.md`：预期内取消不弹错误）。
 */
export const USER_CANCELLATION_NOTICE_KEYS = {
  /** 资产或文件夹的「从硬盘删除」：同一句文案 */
  diskDelete: "toast.diskDeleteCancelled",
  /** 回收站里的「永久删除」 */
  permanentDelete: "toast.permanentDeleteCancelled",
  /** 「清空回收站」 */
  emptyTrash: "toast.emptyTrashCancelled",
  /** 「从硬盘删除资源库」 */
  libraryDelete: "toast.libraryDeleteCancelled",
} as const;

export type UserCancellationKind = keyof typeof USER_CANCELLATION_NOTICE_KEYS;

/**
 * 判断一个失败结果是否只是「用户取消」。同时接受抛出的 `LibraryOperationError`
 * 与 `{ code }` 形状的 public error，避免每个调用点各写一遍 code 比较。
 */
export function isUserCancellation(caught: unknown): boolean {
  if (caught instanceof LibraryOperationError) return caught.code === "CANCELLED";
  if (caught === null || typeof caught !== "object") return false;
  return (caught as { code?: unknown }).code === "CANCELLED";
}

/** 通知文案 key（保留字面量类型，便于 `t()` 做目录校验）。 */
export function userCancellationNoticeKey(kind: UserCancellationKind) {
  return USER_CANCELLATION_NOTICE_KEYS[kind];
}
