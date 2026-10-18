import { useEffect } from "react";

import { createCommandRegistry } from "./commands/command-registry";
import {
  matchesShortcut,
  type CommandPlatform,
  type ShortcutSpec,
} from "./commands/command-types";
import {
  asLegacyKeyboardShortcutEvent,
  listenForShortcutInputs,
  matchesRuntimeShortcut,
} from "./shortcut-runtime";
import type { ShortcutEventLike } from "../shared/shortcut-resolution";
import {
  sidebarCommandDefinitions,
  type SidebarCommandDefinition,
} from "./commands/sidebar-commands";

const collectionKeyboardCommandRegistry = createCommandRegistry(
  sidebarCommandDefinitions as readonly SidebarCommandDefinition[],
);

type CollectionShortcutCommandId =
  | "collection.create-subcollection"
  | "collection.rename"
  | "collection.delete";

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function matchCollectionShortcut(
  commandId: CollectionShortcutCommandId,
  event: ShortcutEventLike,
  platform: CommandPlatform,
): boolean {
  const resolved = matchesRuntimeShortcut(commandId, event, platform);
  if (resolved !== null) return resolved;
  const spec: ShortcutSpec | undefined =
    collectionKeyboardCommandRegistry.get(commandId)?.shortcut;
  const keyboardEvent = asLegacyKeyboardShortcutEvent(event);
  return keyboardEvent !== null && spec !== undefined && matchesShortcut(spec, keyboardEvent, platform);
}

export type UseCollectionCommandShortcutsArgs = {
  readonly enabled: boolean;
  readonly platform: CommandPlatform;
  readonly previewOpen: boolean;
  readonly createSubcollection: (collectionId: string) => void;
  readonly renameCollection: (collectionId: string, currentName: string) => void;
  readonly deleteCollection: (collectionId: string, name: string) => void;
};

/**
 * Handles F2/Delete while a collection row owns sidebar focus. Keeping this
 * separate from canvas asset shortcuts prevents Delete from removing members
 * when the user is operating on the collection itself.
 */
export function useCollectionCommandShortcuts(
  args: UseCollectionCommandShortcutsArgs,
): void {
  const {
    enabled,
    platform,
    previewOpen,
    createSubcollection,
    renameCollection,
    deleteCollection,
  } = args;

  useEffect(() => {
    if (!enabled) return;

    const onShortcutInput = (shortcutInput: ShortcutEventLike, event: KeyboardEvent | MouseEvent) => {
      if (isEditableKeyboardTarget(event.target)) return;
      if (previewOpen) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;

      const focused = document.activeElement?.closest<HTMLElement>(
        "[data-nav-collection-id]",
      );
      if (!focused) return;
      const collectionId = focused.dataset.navCollectionId?.trim();
      if (!collectionId) return;
      const name = focused.querySelector<HTMLElement>(
        ".nav-row-label",
      )?.textContent?.trim();
      if (!name) return;

      if (matchCollectionShortcut("collection.create-subcollection", shortcutInput, platform)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        createSubcollection(collectionId);
        return;
      }
      if (matchCollectionShortcut("collection.rename", shortcutInput, platform)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        renameCollection(collectionId, name);
        return;
      }
      if (matchCollectionShortcut("collection.delete", shortcutInput, platform)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        deleteCollection(collectionId, name);
      }
    };

    return listenForShortcutInputs(document, onShortcutInput, platform === "windows");
  }, [
    enabled,
    platform,
    previewOpen,
    createSubcollection,
    renameCollection,
    deleteCollection,
  ]);
}
