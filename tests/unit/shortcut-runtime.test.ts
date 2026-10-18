// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import {
  formatRuntimeShortcut,
  matchesRuntimeShortcut,
  listenForShortcutInputs,
  setShortcutRuntime,
} from "../../src/renderer/shortcut-runtime";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  setShortcutOverride,
} from "../../src/shared/shortcut-bindings";

const event = (key: string, code: string) => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

afterEach(() => {
  setShortcutRuntime("windows", DEFAULT_SHORTCUT_BINDINGS);
});

describe("shortcut runtime", () => {
  it("routes matchers and menu labels through the current override", () => {
    const bindings = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "asset.rename",
      { key: "F3", code: "F3" },
    );
    setShortcutRuntime("windows", bindings);

    expect(formatRuntimeShortcut("asset.rename", "windows")).toBe("F3");
    expect(matchesRuntimeShortcut("asset.rename", event("F3", "F3"), "windows")).toBe(true);
    expect(matchesRuntimeShortcut("asset.rename", event("F2", "F2"), "windows")).toBe(false);
    expect(matchesRuntimeShortcut("not-a-catalog-action", event("F3", "F3"), "windows")).toBeNull();
  });

  it("routes real mouse side-button events through the same runtime matcher", () => {
    const bindings = setShortcutOverride(
      DEFAULT_SHORTCUT_BINDINGS,
      "windows",
      "asset.rename",
      { key: "MouseBack", altKey: true },
    );
    setShortcutRuntime("windows", bindings);
    const seen: Array<{ input: unknown; event: Event }> = [];
    const remove = listenForShortcutInputs(window, (input, event) => {
      seen.push({ input, event });
    });
    const event = new MouseEvent("mousedown", {
      button: 3,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    remove();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe(event);
    expect(seen[0]?.input).toMatchObject({
      kind: "mouse",
      button: 3,
      altKey: true,
    });
    expect(matchesRuntimeShortcut("asset.rename", seen[0]!.input as never, "windows"))
      .toBe(true);
  });
});
