// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../../src/shared/asset-types";
import type { WorldlineBoxLibraryApi } from "../../src/shared/library-api";

vi.mock("../../src/renderer/i18n", () => {
  const t = (key: string) => key;
  return { useT: () => t };
});
vi.mock("../../src/renderer/PdfViewerSurface", () => ({ PdfViewerSurface: () => null }));
vi.mock("../../src/renderer/3d-viewer/viewer-surface", () => ({ ModelViewerSurface: () => null }));
vi.mock("../../src/renderer/use-viewer-chrome-contrast", () => ({
  useViewerChromeContrast: () => ({ prev: "on-dark", next: "on-dark" }),
}));
vi.mock("../../src/renderer/use-viewer-volume", () => ({
  useViewerVolume: () => ({ volume: 1, muted: false, setVolume: () => undefined, setMuted: () => undefined }),
}));

import { AssetPreviewModal } from "../../src/renderer/AssetPreviewModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function asset(assetId: string): AssetSummary {
  return {
    assetId, displayName: `${assetId}.bin`, relativeFilePath: `${assetId}.bin`,
    locationKind: "managed", managedFolderId: null, currentRevisionId: `${assetId}-revision`,
    byteSize: 1, modifiedAt: "2026-11-03T00:00:00Z", availability: "available",
    rating: 0, favorite: false, deletedAt: null, trashedFromPath: null,
    trashedFromTombstoneId: null, remainingDays: null, thumbnailStatus: null,
    thumbnailArtifactId: null, mediaType: "other", width: null, height: null, durationMs: null,
  };
}

describe("viewer navigation across asset transitions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let selected: number;
  const items = [asset("first"), asset("middle"), asset("last")];
  const visited: string[] = [];
  const api = {
    requestPreview: vi.fn(async () => ({ ok: true, value: { status: "ready", mediaType: "other" } })),
    onThumbnailEvent: () => () => undefined,
  } as unknown as WorldlineBoxLibraryApi;

  beforeEach(() => {
    vi.useFakeTimers();
    visited.length = 0;
    selected = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700,
      width: 1000, height: 700, toJSON: () => ({}),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function render() {
    root.render(createElement(AssetPreviewModal, {
      api, asset: items[selected]!, chromeIdle: true, libraryId: "test-library",
      onChromeActivity: () => undefined, onClose: () => undefined,
      onPrevious: selected > 0 ? () => navigate(-1) : undefined,
      onNext: selected < items.length - 1 ? () => navigate(1) : undefined,
    }));
  }

  function navigate(direction: number) {
    selected += direction;
    visited.push(items[selected]!.assetId);
    render();
  }

  async function settle() {
    await act(async () => { vi.advanceTimersByTime(1); });
  }

  async function pointAt(clientX: number) {
    const event = new PointerEvent("pointermove", { bubbles: true, clientX, clientY: 200 });
    Object.defineProperty(event, "movementX", { value: 10 });
    await act(async () => { window.dispatchEvent(event); });
  }

  function visibleViewer() {
    const viewer = container.querySelector('.workspace-viewer:not([aria-hidden="true"])')!;
    expect(viewer).not.toBeNull();
    return viewer;
  }

  it("keeps the approached arrow active after promotion without another pointer move", async () => {
    await act(async () => { render(); });
    await settle();
    await pointAt(990);
    expect(visibleViewer().classList.contains("is-nav-near-next")).toBe(true);
    expect((visibleViewer().querySelector(".is-prev") as HTMLButtonElement).disabled).toBe(true);
    for (const expected of ["middle", "last"]) {
      await act(async () => { (visibleViewer().querySelector(".is-next") as HTMLButtonElement).click(); });
      await settle();
      expect(visited.at(-1)).toBe(expected);
      expect(visibleViewer().classList.contains("is-nav-near-next")).toBe(true);
    }
    expect((visibleViewer().querySelector(".is-next") as HTMLButtonElement).disabled).toBe(true);
    expect((visibleViewer().querySelector(".is-prev") as HTMLButtonElement).disabled).toBe(false);
    await pointAt(10);
    await act(async () => { (visibleViewer().querySelector(".is-prev") as HTMLButtonElement).click(); });
    await settle();
    expect(visited).toEqual(["middle", "last", "middle"]);
    expect(visibleViewer().classList.contains("is-nav-near-prev")).toBe(true);
  });
});
