// ---------------------------------------------------------------------------
// Pure view-model helpers for the shortcut settings page.
// ---------------------------------------------------------------------------

import {
  SHORTCUT_ACTIONS,
  SHORTCUT_CATEGORY_ORDER,
  type ShortcutActionDefinition,
  type ShortcutCategory,
  type ShortcutChord,
  type ShortcutPlatform,
} from "../shared/shortcut-catalog";
import {
  hasShortcutOverride,
  type ShortcutBindings,
} from "../shared/shortcut-bindings";
import {
  findAllShortcutConflicts,
  formatShortcutChords,
  resolveActionChords,
  type ShortcutMouseLabels,
  type ShortcutConflict,
} from "../shared/shortcut-resolution";

export type ShortcutFilter = "all" | "modified" | "conflicts";

export type ShortcutRowModel = {
  readonly action: ShortcutActionDefinition;
  readonly chords: readonly ShortcutChord[];
  readonly shortcutLabel: string;
  readonly modified: boolean;
  readonly unassigned: boolean;
  readonly conflicts: readonly ShortcutConflict[];
};

export function buildShortcutRows(
  platform: ShortcutPlatform,
  bindings: ShortcutBindings,
  mouseLabels?: ShortcutMouseLabels,
): ShortcutRowModel[] {
  const conflictMap = new Map<string, ShortcutConflict[]>();
  for (const conflict of findAllShortcutConflicts(platform, bindings)) {
    conflictMap.set(conflict.actionId, [
      ...(conflictMap.get(conflict.actionId) ?? []),
      conflict,
    ]);
  }
  return SHORTCUT_ACTIONS.filter((action) => action.customizable).map((action) => {
    const chords = resolveActionChords(action.id, platform, bindings);
    return {
      action,
      chords,
      shortcutLabel: formatShortcutChords(chords, platform, mouseLabels),
      modified: hasShortcutOverride(bindings, platform, action.id),
      unassigned: chords.length === 0,
      conflicts: conflictMap.get(action.id) ?? [],
    };
  });
}

export function filterShortcutRows(
  rows: readonly ShortcutRowModel[],
  filter: ShortcutFilter,
): ShortcutRowModel[] {
  if (filter === "modified") return rows.filter((row) => row.modified);
  if (filter === "conflicts") return rows.filter((row) => row.conflicts.length > 0);
  return [...rows];
}

export function matchesShortcutQuery(
  row: ShortcutRowModel,
  query: string,
  label: string,
  scopeLabel: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [label, scopeLabel, row.shortcutLabel, row.action.id]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalized);
}

export type ShortcutGroupModel = {
  readonly category: ShortcutCategory;
  readonly rows: ShortcutRowModel[];
};

export function groupShortcutRows(
  rows: readonly ShortcutRowModel[],
): ShortcutGroupModel[] {
  const groups: ShortcutGroupModel[] = [];
  for (const category of SHORTCUT_CATEGORY_ORDER) {
    const groupRows = rows.filter((row) => row.action.category === category);
    if (groupRows.length > 0) groups.push({ category, rows: groupRows });
  }
  return groups;
}

export type ShortcutCounts = {
  readonly all: number;
  readonly modified: number;
  readonly conflicts: number;
};

export function countShortcutRows(
  rows: readonly ShortcutRowModel[],
): ShortcutCounts {
  return {
    all: rows.length,
    modified: rows.filter((row) => row.modified).length,
    conflicts: rows.filter((row) => row.conflicts.length > 0).length,
  };
}
