/**
 * WorldlineBox-d7acfa: Ctrl/⌘ 点击文件夹时的多选结果（纯函数，便于单测）。
 *
 * 用户口径（2026-09-19）：**当前打开的文件夹是隐式选中的**。如果此刻正在浏览
 * 文件夹 A，Ctrl+点击 B，应当得到 {A, B}，而不是只选中 B —— 与文件管理器里
 * 「先有焦点项，再用 Ctrl 扩展选区」一致。
 *
 * 例外（不把 A 一起选上）：
 * - 已经有选区时不替换，只追加（避免第二次 Ctrl+点击又把 A 拉回来）；
 * - A 就是被点的 B；
 * - A 不在当前可选列表里（例如被删掉、或在回收站模式下）——宁可不选，也不把
 *   一个未知 id 塞进批量动作的目标。
 */

export interface ToggleFolderMultiSelectionOptions {
  /** 当前正在浏览的文件夹 id；`null` 表示「所有资产 / 根目录」这类非文件夹视图。 */
  readonly openFolderId?: string | null;
  /** 该 id 此刻是否可选（存在于侧栏/画布列表里）。默认全部可选。 */
  readonly isSelectable?: (folderId: string) => boolean;
}

export function toggleFolderMultiSelection(
  current: readonly string[],
  folderId: string,
  options?: ToggleFolderMultiSelectionOptions,
): string[] {
  if (current.includes(folderId)) {
    return current.filter((id) => id !== folderId);
  }
  const openFolderId = options?.openFolderId ?? null;
  const isSelectable = options?.isSelectable ?? (() => true);
  if (
    current.length === 0 &&
    openFolderId !== null &&
    openFolderId !== folderId &&
    isSelectable(openFolderId)
  ) {
    return [openFolderId, folderId];
  }
  return [...current, folderId];
}
