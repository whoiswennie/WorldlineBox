import type { ShortcutPlatform } from "./shortcut-catalog";
import type {
  ShortcutBindings,
  ShortcutPlatformBindings,
} from "./shortcut-bindings";

export type ShortcutBindingsSetRequest = {
  readonly platform: ShortcutPlatform;
  readonly bindings: ShortcutPlatformBindings;
};

export type ShortcutBindingsSetResult =
  | { readonly ok: true; readonly bindings: ShortcutBindings }
  | {
      readonly ok: false;
      readonly bindings: ShortcutBindings;
      readonly error: string;
    };

export type ShortcutFileExportResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: string; readonly canceled?: boolean };

export type ShortcutFileImportResult =
  | { readonly ok: true; readonly bindings: ShortcutBindings }
  | { readonly ok: false; readonly error: string; readonly canceled?: boolean };

/** Narrow preload API exposed as window.worldlinebox.shortcuts. */
export type WorldlineBoxShortcutsApi = {
  get(): Promise<ShortcutBindings>;
  set(input: ShortcutBindingsSetRequest): Promise<ShortcutBindingsSetResult>;
  exportToFile(): Promise<ShortcutFileExportResult>;
  importFromFile(): Promise<ShortcutFileImportResult>;
};
