// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../src/renderer/ViewerVolumeControls", () => ({ ViewerVolumeControls: () => null }));
vi.mock("../../src/renderer/use-viewer-zoom-pan", () => ({
  useViewerZoomPan: () => ({
    fitToWindow: () => undefined,
    measureAndFit: () => undefined,
    view: { scale: 1, x: 0, y: 0 },
    viewportPointerHandlers: {},
    viewportRef: { current: null },
  }),
}));

import { AudioPlayerControls } from "../../src/renderer/AudioPlayerControls";
import { VideoPlayerControls } from "../../src/renderer/VideoPlayerControls";
import type { ViewerPlaybackHandle } from "../../src/renderer/video-player-controls";
import { saveVideoSeekJumpPreferences } from "../../src/renderer/video-seek-jump-preferences";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["video", "audio"] as const)("%s viewer playback integration", (kind) => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderPlayer() {
    const playbackHandleRef = createRef<ViewerPlaybackHandle>();
    const props = {
      autoPlay: false,
      muted: false,
      onError: () => undefined,
      onFullscreen: () => undefined,
      onMutedChange: () => undefined,
      onVolumeChange: () => undefined,
      playbackHandleRef,
      src: `file:///sample.${kind === "video" ? "mp4" : "mp3"}`,
      volume: 0.8,
    };
    await act(async () => root.render(kind === "video"
      ? createElement(VideoPlayerControls, props)
      : createElement(AudioPlayerControls, props)));
    const media = container.querySelector(kind)! as HTMLMediaElement;
    const seeks: number[] = [];
    // The decoder still reports the old time while the commanded seek is in flight.
    Object.defineProperties(media, {
      currentTime: { configurable: true, get: () => 10, set: (time: number) => seeks.push(time) },
      duration: { configurable: true, get: () => 200 },
      readyState: { configurable: true, get: () => 4 },
      seeking: { configurable: true, get: () => false },
    });
    return { media, seeks, playbackHandleRef };
  }

  async function key(type: string, repeat = false, target: EventTarget = window) {
    const event = new KeyboardEvent(type, {
      key: "ArrowRight", code: "ArrowRight", ctrlKey: true,
      repeat, bubbles: true, cancelable: true,
    });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  }

  it("accumulates held Ctrl+Arrow jumps while the decoder lags and stops after key release", async () => {
    saveVideoSeekJumpPreferences({ version: 1, mode: "time", seconds: 3, percent: 5 });
    const { seeks } = await renderPlayer();
    expect((await key("keydown")).defaultPrevented).toBe(true);
    await key("keydown", true);
    await key("keydown", true);
    expect(seeks).toEqual([13, 16, 19]);
    await key("keyup");
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(seeks).toEqual([13, 16, 19]);
  });

  it("shares percent settings between keyboard, wheel and the playback menu handle", async () => {
    saveVideoSeekJumpPreferences({ version: 1, mode: "percent", seconds: 3, percent: 10 });
    const { seeks, playbackHandleRef } = await renderPlayer();
    await key("keydown");
    expect(seeks).toEqual([30]);
    await key("keyup");
    await act(async () => { vi.advanceTimersByTime(1300); });
    // A menu row explicitly selects its unit, independently of the current keyboard mode.
    await act(async () => { playbackHandleRef.current?.seekBy(1, "time"); });
    expect(seeks.at(-1)).toBe(13);
    const track = container.querySelector('[role="slider"]')!;
    expect(track).not.toBeNull();
    await act(async () => {
      track.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true }));
      vi.advanceTimersByTime(20);
    });
    expect(seeks.at(-1)).toBe(30);
  });

  it("leaves the configured keys to focused text inputs", async () => {
    const { seeks } = await renderPlayer();
    const input = document.createElement("input");
    container.append(input);
    input.focus();
    expect((await key("keydown", false, input)).defaultPrevented).toBe(false);
    expect(seeks).toEqual([]);
  });
});
