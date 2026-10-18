// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCollectionCommandShortcuts } from "../../src/renderer/use-collection-command-shortcuts";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function Harness({ onCreate }: { onCreate: (id: string) => void }) {
  useCollectionCommandShortcuts({
    enabled: true,
    platform: "windows",
    previewOpen: false,
    createSubcollection: onCreate,
    renameCollection: vi.fn(),
    deleteCollection: vi.fn(),
  });
  return createElement(
    "button",
    { "data-nav-collection-id": "collection-1", type: "button" },
    createElement("span", { className: "nav-row-label" }, "Collection"),
  );
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("useCollectionCommandShortcuts", () => {
  it("dispatches create-subcollection from a focused collection row", async () => {
    const onCreate = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness, { onCreate }));
    });
    const row = container.querySelector<HTMLButtonElement>(
      "[data-nav-collection-id]",
    )!;
    row.focus();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          code: "KeyN",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onCreate).toHaveBeenCalledWith("collection-1");
  });
});
