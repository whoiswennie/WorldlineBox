import { ipcRenderer } from "electron";

import {
  SHORTCUT_BINDINGS_EXPORT_CHANNEL,
  SHORTCUT_BINDINGS_GET_CHANNEL,
  SHORTCUT_BINDINGS_IMPORT_CHANNEL,
  SHORTCUT_BINDINGS_SET_CHANNEL,
} from "../../shared/protocol/channels";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  parseShortcutBindings,
  type ShortcutBindings,
} from "../../shared/shortcut-bindings";
import type {
  WorldlineBoxShortcutsApi,
  ShortcutBindingsSetRequest,
  ShortcutBindingsSetResult,
  ShortcutFileExportResult,
  ShortcutFileImportResult,
} from "../../shared/shortcut-api";

function parseBindings(payload: unknown): ShortcutBindings {
  return parseShortcutBindings(payload) ?? DEFAULT_SHORTCUT_BINDINGS;
}

export const shortcuts: WorldlineBoxShortcutsApi = Object.freeze({
  async get() {
    return parseBindings(await ipcRenderer.invoke(SHORTCUT_BINDINGS_GET_CHANNEL));
  },
  async set(input: ShortcutBindingsSetRequest): Promise<ShortcutBindingsSetResult> {
    const payload = await ipcRenderer.invoke(SHORTCUT_BINDINGS_SET_CHANNEL, input);
    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        bindings: DEFAULT_SHORTCUT_BINDINGS,
        error: "invalid-shortcut-response",
      };
    }
    const record = payload as {
      ok?: unknown;
      bindings?: unknown;
      error?: unknown;
    };
    const bindings = parseBindings(record.bindings);
    if (record.ok === true) return { ok: true, bindings };
    return {
      ok: false,
      bindings,
      error: typeof record.error === "string" ? record.error : "shortcut-save-failed",
    };
  },
  async exportToFile(): Promise<ShortcutFileExportResult> {
    const payload = await ipcRenderer.invoke(SHORTCUT_BINDINGS_EXPORT_CHANNEL);
    if (payload && typeof payload === "object") {
      const record = payload as { ok?: unknown; path?: unknown; error?: unknown; canceled?: unknown };
      if (record.ok === true && typeof record.path === "string") {
        return { ok: true, path: record.path };
      }
      return {
        ok: false,
        error: typeof record.error === "string" ? record.error : "shortcut-export-failed",
        ...(record.canceled === true ? { canceled: true } : {}),
      };
    }
    return { ok: false, error: "shortcut-export-failed" };
  },
  async importFromFile(): Promise<ShortcutFileImportResult> {
    const payload = await ipcRenderer.invoke(SHORTCUT_BINDINGS_IMPORT_CHANNEL);
    if (payload && typeof payload === "object") {
      const record = payload as { ok?: unknown; bindings?: unknown; error?: unknown; canceled?: unknown };
      if (record.ok === true) {
        return { ok: true, bindings: parseBindings(record.bindings) };
      }
      return {
        ok: false,
        error: typeof record.error === "string" ? record.error : "shortcut-import-failed",
        ...(record.canceled === true ? { canceled: true } : {}),
      };
    }
    return { ok: false, error: "shortcut-import-failed" };
  },
});
