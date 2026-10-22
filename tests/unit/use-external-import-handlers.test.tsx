// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../../src/renderer/i18n";
import { useExternalImportHandlers } from "../../src/renderer/use-external-import-handlers";

function noop(): void {}

function DropLifecycleHarness({ observed }: { observed: boolean[] }) {
  const handlers = useExternalImportHandlers({
    api: null,
    library: null,
    busy: false,
    activeCollectionId: null,
    autoDetectImageSequences: false,
    detectImageSequences: false,
    previewBlocksDrop: false,
    managedImportTargetFolderIdRef: { current: undefined },
    reloadCurrentContent: async () => undefined,
    reloadCurrentContentRef: { current: async () => undefined },
    onImportCompleted: noop,
    setUiState: noop,
    setImportProgress: noop,
    runImportRpc: (work) => work(),
    setError: noop,
    setNotice: noop,
    setConflicts: noop,
    setImageSequenceImportOffer: noop,
  });

  return createElement(
    "div",
    null,
    createElement(
      "button",
      { "data-testid": "begin-drag", onClick: handlers.beginInternalAssetDrag },
      "Begin drag",
    ),
    createElement(
      "div",
      {
        "data-testid": "drop-target",
        onDrop: () => observed.push(handlers.isInternalAssetDrag()),
      },
      "Drop target",
    ),
  );
}

describe("useExternalImportHandlers native drag lifecycle", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    container?.remove();
    container = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function mountHarness(observed: boolean[]): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          LocaleProvider,
          null,
          createElement(DropLifecycleHarness, { observed }),
        ),
      );
    });
  }

  async function beginArmedDrag(): Promise<void> {
    const start = container?.querySelector<HTMLButtonElement>(
      '[data-testid="begin-drag"]',
    );
    if (!start) throw new Error("Drag start control is missing");
    await act(async () => {
      start.click();
      vi.advanceTimersByTime(50);
    });
  }

  it("keeps the native drag active across a capture-to-bubble microtask checkpoint", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const observed: boolean[] = [];
    await mountHarness(observed);
    await beginArmedDrag();

    const target = container?.querySelector<HTMLDivElement>(
      '[data-testid="drop-target"]',
    );
    if (!target) throw new Error("Drop target is missing");

    await act(async () => {
      // Model Chromium's trusted native-drop checkpoint after the window
      // capture listener and before React's delegated target handler.
      window.dispatchEvent(new Event("drop", { bubbles: true }));
      await Promise.resolve();
      target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    });

    expect(observed).toEqual([true]);
    await act(async () => vi.runOnlyPendingTimers());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending drop cleanup when a new native drag begins", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const observed: boolean[] = [];
    await mountHarness(observed);
    await beginArmedDrag();

    await act(async () => {
      window.dispatchEvent(new Event("drop", { bubbles: true }));
      await Promise.resolve();
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="begin-drag"]')
        ?.click();
    });
    await act(async () => vi.advanceTimersByTime(50));

    const target = container?.querySelector<HTMLDivElement>(
      '[data-testid="drop-target"]',
    );
    if (!target) throw new Error("Drop target is missing");
    await act(async () => {
      target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    });

    expect(observed).toEqual([true]);
  });

  it("clears a pending native-drop cleanup timer when unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const observed: boolean[] = [];
    await mountHarness(observed);
    await beginArmedDrag();

    await act(async () => {
      window.dispatchEvent(new Event("drop", { bubbles: true }));
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      root?.unmount();
      root = undefined;
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
