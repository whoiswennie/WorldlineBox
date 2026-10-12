/**
 * Last directory used by a native open/save panel, for this process only.
 * A second linked-folder import, cover pick, or other disk browse opens
 * where the previous one finished.
 */

import path from "node:path";

let rememberedDirectory: string | undefined;

export function rememberedDialogDirectory(): string | undefined {
  return rememberedDirectory;
}

export function resetDialogDirectoryMemory(): void {
  rememberedDirectory = undefined;
}

/** Absolute paths win. A bare file name is placed inside the remembered directory. */
export function resolveDialogDefaultPath(
  explicit: string | undefined,
  remembered: string | undefined = rememberedDirectory,
): string | undefined {
  if (explicit !== undefined && path.isAbsolute(explicit)) return explicit;
  if (!remembered) return explicit;
  if (!explicit) return remembered;
  return path.join(remembered, explicit);
}

export function rememberDialogSelection(
  selectedPath: string,
  kind: "directory" | "file",
): void {
  rememberedDirectory = kind === "directory" ? selectedPath : path.dirname(selectedPath);
}
