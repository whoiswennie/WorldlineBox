import { afterEach, describe, expect, it } from "vitest";

import {
  isViewerFitShortcut,
  shouldHandleViewerFitKeyboardEvent,
} from "../../src/renderer/viewer-fit-shortcut";
import { setShortcutRuntime } from "../../src/renderer/shortcut-runtime";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  setShortcutOverride,
} from "../../src/shared/shortcut-bindings";

afterEach(() => {
  setShortcutRuntime("windows", DEFAULT_SHORTCUT_BINDINGS);
});

describe("isViewerFitShortcut", () => {
  it("accepts the physical numpad decimal key and Windows legacy values", () => {
    expect(isViewerFitShortcut({ code: "NumpadDecimal", key: "." })).toBe(true);
    expect(isViewerFitShortcut({ code: "Decimal", key: "Decimal" })).toBe(true);
    expect(isViewerFitShortcut({ key: "NumpadDecimal" })).toBe(true);
    expect(isViewerFitShortcut({ key: ".", location: 3 })).toBe(true);
  });

  it("does not treat the regular period key as fit", () => {
    expect(isViewerFitShortcut({ key: ".", location: 0 })).toBe(false);
  });

  it("ignores system key-repeat events", () => {
    expect(isViewerFitShortcut({ code: "NumpadDecimal", key: ".", repeat: true })).toBe(false);
  });

  it("matches a custom Ctrl+F6 chord in both video and GIF viewer handlers", () => {
    const bindings = setShortcutOverride(DEFAULT_SHORTCUT_BINDINGS, "windows", "viewer.fit", {
      key: "F6",
      code: "F6",
      ctrlKey: true,
    });
    setShortcutRuntime("windows", bindings);
    const event = {
      key: "F6",
      code: "F6",
      location: 0,
      repeat: false,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: { tagName: "DIV" },
    };
    // VideoPlayerControls and GifViewerPlayer both call this shared owner.
    expect(shouldHandleViewerFitKeyboardEvent(event, { modalOpen: false })).toBe(true);
    expect(shouldHandleViewerFitKeyboardEvent(event, { modalOpen: false })).toBe(true);
  });

  it("keeps typing, modal, and repeat guards for media fit chords", () => {
    const event = {
      key: "F6",
      code: "F6",
      repeat: false,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: { tagName: "INPUT" },
    };
    expect(shouldHandleViewerFitKeyboardEvent(event, { modalOpen: false })).toBe(false);
    expect(shouldHandleViewerFitKeyboardEvent({ ...event, target: { tagName: "DIV" } }, { modalOpen: true })).toBe(false);
    expect(shouldHandleViewerFitKeyboardEvent({ ...event, repeat: true, target: { tagName: "DIV" } }, { modalOpen: false })).toBe(false);
  });
});
