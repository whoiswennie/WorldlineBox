import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_SHORTCUT_BINDINGS,
  parseShortcutBindings,
  type ShortcutBindings,
} from "../shared/shortcut-bindings";

export const SHORTCUT_BINDINGS_FILE_NAME = "shortcut-bindings.json";

export function shortcutBindingsFilePath(userDataPath: string): string {
  return path.join(userDataPath, SHORTCUT_BINDINGS_FILE_NAME);
}

export function readShortcutBindings(filePath: string): ShortcutBindings {
  try {
    return parseShortcutBindings(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return DEFAULT_SHORTCUT_BINDINGS;
  }
}

export function writeShortcutBindings(
  filePath: string,
  bindings: ShortcutBindings,
): void {
  const parsed = parseShortcutBindings(bindings);
  writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
