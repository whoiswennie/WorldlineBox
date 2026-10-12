import { describe, expect, it } from "vitest";

import { assetCommandDefinitions } from "../../src/renderer/commands/asset-commands";
import { assetMultiCommandDefinitions } from "../../src/renderer/commands/asset-multi-commands";
import { sidebarCommandDefinitions } from "../../src/renderer/commands/sidebar-commands";
import { toolbarCommandDefinitions } from "../../src/renderer/commands/toolbar-commands";
import type { ShortcutSpec } from "../../src/renderer/commands/command-types";
import { PLATFORM_SHORTCUT_TABLE } from "../../src/shared/platform-shortcut-table";
import { SELECT_ALL_SHORTCUT, INVERT_SELECTION_SHORTCUT } from "../../src/renderer/selection-keyboard";
import { FOCUS_SEARCH_SHORTCUT } from "../../src/renderer/workspace-discovery-shortcuts";

function expectBothPlatforms(id: string, shortcut: ShortcutSpec | undefined) {
  if (shortcut === undefined) return;
  expect(shortcut.mac, id).toBeDefined();
  expect(shortcut.windows, id).toBeDefined();
}

describe("platform shortcut parity", () => {
  it("gives every command chord both a mac and a windows binding", () => {
    const groups = [
      assetCommandDefinitions,
      assetMultiCommandDefinitions,
      sidebarCommandDefinitions,
      toolbarCommandDefinitions,
    ];
    for (const definitions of groups) {
      for (const definition of definitions) {
        expectBothPlatforms(definition.id, definition.shortcut);
      }
    }
    expectBothPlatforms("selection.select-all", SELECT_ALL_SHORTCUT);
    expectBothPlatforms("selection.invert", INVERT_SELECTION_SHORTCUT);
    expectBothPlatforms("workspace.focus-search", FOCUS_SEARCH_SHORTCUT);
    for (const row of PLATFORM_SHORTCUT_TABLE) {
      expect(row.mac, row.id).toBeDefined();
      expect(row.windows, row.id).toBeDefined();
    }
  });
});
