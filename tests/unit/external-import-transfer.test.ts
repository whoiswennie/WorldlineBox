import { expect, test, vi } from "vitest";

import { MANAGED_ASSETS_DRAG_TYPE } from "../../src/renderer/asset-drag-drop";
import {
  reduceInternalDragPhase,
  scheduleInternalAssetDropCleanup,
  shouldActivateExternalImportOverlay,
  shouldConsumeManagedAssetDrop,
  supportsExternalImportTypes,
} from "../../src/renderer/external-import-transfer";

test("external import accepts Files / html / uri-list", () => {
  expect(supportsExternalImportTypes(["Files"])).toBe(true);
  expect(supportsExternalImportTypes(["text/uri-list"])).toBe(true);
  expect(supportsExternalImportTypes(["text/html", "Files"])).toBe(true);
});

test("managed asset drag is never treated as external import", () => {
  expect(
    supportsExternalImportTypes([MANAGED_ASSETS_DRAG_TYPE, "Files"]),
  ).toBe(false);
  expect(supportsExternalImportTypes([MANAGED_ASSETS_DRAG_TYPE])).toBe(false);
});

test("an in-app asset drag does not open the import overlay", () => {
  expect(shouldActivateExternalImportOverlay(["Files"], true)).toBe(false);
  expect(shouldActivateExternalImportOverlay(["Files"], false)).toBe(true);
  expect(
    shouldActivateExternalImportOverlay([MANAGED_ASSETS_DRAG_TYPE, "Files"], false),
  ).toBe(false);
});

test("only a complete WorldlineBox initiated file drop is consumed as a managed drag", () => {
  expect(shouldConsumeManagedAssetDrop(false, 1, ["asset-1"])).toBe(false);
  expect(shouldConsumeManagedAssetDrop(true, 1, ["asset-1"])).toBe(true);
  expect(shouldConsumeManagedAssetDrop(true, 2, ["asset-1"])).toBe(false);
  expect(shouldConsumeManagedAssetDrop(true, 1, [])).toBe(false);
});

test("the cancelled HTML5 dragend does not end an in-app OS drag", () => {
  let phase = reduceInternalDragPhase("idle", "begin");
  phase = reduceInternalDragPhase(phase, "dragend");
  expect(phase).toBe("starting");
  expect(shouldActivateExternalImportOverlay(["Files"], phase !== "idle")).toBe(false);
  phase = reduceInternalDragPhase(phase, "arm");
  expect(phase).toBe("active");
  phase = reduceInternalDragPhase(phase, "drop");
  expect(phase).toBe("idle");
  expect(shouldActivateExternalImportOverlay(["Files"], phase !== "idle")).toBe(true);
});

test("native drop cleanup waits through microtask checkpoints until event dispatch ends", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let phase = reduceInternalDragPhase("idle", "begin");
    phase = reduceInternalDragPhase(phase, "arm");

    scheduleInternalAssetDropCleanup(() => {
      phase = reduceInternalDragPhase(phase, "drop");
    });

    // Trusted native drops can checkpoint microtasks between native capture
    // and bubble listeners. React must still observe the active phase there.
    await Promise.resolve();
    expect(phase).toBe("active");

    vi.runOnlyPendingTimers();
    expect(phase).toBe("idle");
  } finally {
    vi.useRealTimers();
  }
});
