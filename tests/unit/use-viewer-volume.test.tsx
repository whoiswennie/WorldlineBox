// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useViewerVolume } from "../../src/renderer/use-viewer-volume";
import { setShortcutRuntime } from "../../src/renderer/shortcut-runtime";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  setShortcutOverride,
} from "../../src/shared/shortcut-bindings";
import { VIEWER_VOLUME_PREF_KEY } from "../../src/renderer/viewer-volume-preferences";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function VolumeProbe({ enabled }: { enabled: boolean }) {
  const { volume } = useViewerVolume(enabled);
  return createElement("output", { "data-volume": true }, String(volume));
}

function VolumePairProbe() {
  const browseVolume = useViewerVolume(false);
  const viewerVolume = useViewerVolume(true);
  return createElement(
    "div",
    null,
    createElement("output", { "data-owner": "browse" }, String(browseVolume.volume)),
    createElement("output", { "data-owner": "viewer" }, String(viewerVolume.volume)),
  );
}

async function renderProbe(enabled: boolean): Promise<HTMLOutputElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(VolumeProbe, { enabled }));
  });
  return container.querySelector("output")!;
}

async function renderPair(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(VolumePairProbe));
  });
  return container.querySelector("div")!;
}

function deleteShortcutEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "Delete",
    code: "Delete",
    bubbles: true,
    cancelable: true,
  });
}

beforeEach(() => {
  window.localStorage.setItem(
    VIEWER_VOLUME_PREF_KEY,
    JSON.stringify({ version: 1, volume: 0.5, muted: false }),
  );
  const bindings = setShortcutOverride(
    DEFAULT_SHORTCUT_BINDINGS,
    "windows",
    "viewer.volume-up",
    { key: "Delete", code: "Delete" },
  );
  setShortcutRuntime("windows", bindings);
});

afterEach(() => {
  root?.unmount();
  root = undefined;
  container?.remove();
  container = undefined;
  window.localStorage.removeItem(VIEWER_VOLUME_PREF_KEY);
  setShortcutRuntime("windows", DEFAULT_SHORTCUT_BINDINGS);
});

describe("useViewerVolume keyboard ownership", () => {
  it("does not consume a viewer-only binding while the browse hook is disabled", async () => {
    const output = await renderProbe(false);
    const browseAction = vi.fn();
    window.addEventListener("keydown", browseAction);
    const event = deleteShortcutEvent();

    await act(async () => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(browseAction).toHaveBeenCalledTimes(1);
    expect(output.textContent).toBe("0.5");
    window.removeEventListener("keydown", browseAction);
  });

  it("adjusts volume when an audio/video viewer owns the shortcut", async () => {
    const output = await renderProbe(true);
    const event = deleteShortcutEvent();

    await act(async () => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(output.textContent).toBe("0.55");
  });

  it("yields a volume chord to a modal dialog's non-editable control", async () => {
    const output = await renderProbe(true);
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    button.textContent = "Confirm";
    dialog.append(button);
    document.body.append(dialog);
    button.focus();
    const event = deleteShortcutEvent();

    await act(async () => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(output.textContent).toBe("0.5");
    dialog.remove();
  });

  it("updates browse preview volume without registering a second key handler", async () => {
    const pair = await renderPair();
    const browse = pair.querySelector('[data-owner="browse"]')!;
    const viewer = pair.querySelector('[data-owner="viewer"]')!;

    await act(async () => {
      window.dispatchEvent(deleteShortcutEvent());
    });

    expect(viewer.textContent).toBe("0.55");
    expect(browse.textContent).toBe("0.55");
  });
});
