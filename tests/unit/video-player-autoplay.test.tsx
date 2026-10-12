// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/i18n", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("../../src/renderer/icon-action-attrs", () => ({
  iconActionAttrs: () => ({ "aria-label": "action" }),
}));
vi.mock("../../src/renderer/ViewerVolumeControls", () => ({
  ViewerVolumeControls: () => null,
}));
vi.mock("../../src/renderer/viewer-volume-preferences", () => ({
  applyViewerVolumeToMedia: () => undefined,
}));
vi.mock("../../src/renderer/media-seek-session", () => ({
  createMediaSeekSession: () => ({
    request: () => undefined,
    commit: () => undefined,
    cancel: () => undefined,
    onSeeked: () => undefined,
  }),
}));
vi.mock("../../src/renderer/use-viewer-zoom-pan", () => ({
  useViewerZoomPan: () => ({
    fitToWindow: () => undefined,
    measureAndFit: () => undefined,
    view: { scale: 1, x: 0, y: 0 },
    viewportPointerHandlers: {},
    viewportRef: { current: null },
  }),
}));

import { VideoPlayerControls } from "../../src/renderer/VideoPlayerControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("VideoPlayerControls autoplay after viewer navigation", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let playSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    playSpy = vi.fn(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(playSpy);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  async function renderControls(autoPlay: boolean): Promise<void> {
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root?.render(
        createElement(VideoPlayerControls, {
          autoPlay,
          muted: false,
          onError: () => undefined,
          onFullscreen: () => undefined,
          onMutedChange: () => undefined,
          onVolumeChange: () => undefined,
          src: "file:///clip.mp4",
          volume: 0.8,
        }),
      );
    });
  }

  it("starts playback when a preloaded surface is promoted", async () => {
    await renderControls(false);
    playSpy.mockClear();
    await renderControls(true);
    expect(playSpy).toHaveBeenCalled();
  });

  it("does not start playback while the surface is still preloading", async () => {
    await renderControls(false);
    expect(playSpy).not.toHaveBeenCalled();
  });
});
