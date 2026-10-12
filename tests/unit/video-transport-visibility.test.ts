import { describe, expect, it } from "vitest";

import {
  INITIAL_VIEWER_DRAWER_STATE,
  pointerEventIsUserMove,
  pointerInVideoTransportZone,
  pointerInViewerTopZone,
  reduceViewerDrawer,
  shouldIgnoreViewerPointerMove,
  VIDEO_TRANSPORT_APPROACH_PX,
  type ViewerDrawerState,
} from "../../src/renderer/video-transport-visibility";

const bounds = {
  left: 0,
  right: 800,
  top: 0,
  bottom: 600,
  height: 600,
};

describe("pointerInVideoTransportZone", () => {
  it("is true only inside the bottom band of the viewer", () => {
    expect(pointerInVideoTransportZone(bounds, 400, 600 - VIDEO_TRANSPORT_APPROACH_PX)).toBe(true);
    expect(pointerInVideoTransportZone(bounds, 400, 200)).toBe(false);
    expect(pointerInVideoTransportZone(bounds, -1, 590)).toBe(false);
    expect(pointerInVideoTransportZone(bounds, 400, 700)).toBe(false);
  });
});

describe("pointerInViewerTopZone", () => {
  it("is true only inside the top band of the viewer", () => {
    expect(pointerInViewerTopZone(bounds, 400, VIDEO_TRANSPORT_APPROACH_PX)).toBe(true);
    expect(pointerInViewerTopZone(bounds, 400, 200)).toBe(false);
  });
});

describe("pointerEventIsUserMove", () => {
  it("rejects a stationary event from a playing video", () => {
    expect(pointerEventIsUserMove({ movementX: 0, movementY: 0 })).toBe(false);
    expect(pointerEventIsUserMove({ movementX: 4, movementY: 0 })).toBe(true);
  });
});

describe("reduceViewerDrawer", () => {
  const middle = { bottom: false, top: false };
  const bottom = { bottom: true, top: false };

  function move(
    state: ViewerDrawerState,
    input: { approach?: boolean; userMove?: boolean; ignored?: boolean; bands?: typeof middle },
  ): ViewerDrawerState {
    return reduceViewerDrawer(state, {
      type: "pointer-move",
      approach: input.approach ?? false,
      userMove: input.userMove ?? true,
      ignored: input.ignored ?? false,
      bands: input.bands ?? middle,
    });
  }

  it("closes after an asset change and ignores a stationary pointer", () => {
    const switched = reduceViewerDrawer(INITIAL_VIEWER_DRAWER_STATE, {
      type: "asset-changed",
      approach: false,
      hasPointer: true,
      bands: middle,
    });
    expect(switched.open).toBe(false);

    const parked = move(switched, { userMove: false });
    expect(parked.open).toBe(false);
    const jitter = move(parked, { ignored: true });
    expect(jitter.open).toBe(false);

    const revealed = move(jitter, { userMove: true });
    expect(revealed.open).toBe(true);
    const idle = reduceViewerDrawer(revealed, { type: "chrome-idle", approach: false });
    expect(idle.open).toBe(false);
  });

  it("opens the bar and the top toolbar only inside their bands when approach is on", () => {
    const closed = reduceViewerDrawer(INITIAL_VIEWER_DRAWER_STATE, {
      type: "asset-changed",
      approach: true,
      hasPointer: false,
      bands: middle,
    });
    expect(closed).toEqual({ open: false, toolbarNear: false, toolbarNearTop: false });

    const middleMove = move(closed, { approach: true, bands: middle });
    expect(middleMove.open).toBe(false);
    expect(middleMove.toolbarNearTop).toBe(false);

    const atBottom = move(middleMove, { approach: true, bands: bottom });
    expect(atBottom.open).toBe(true);
    expect(atBottom.toolbarNear).toBe(true);

    const left = reduceViewerDrawer(atBottom, { type: "pointer-left-window", approach: true });
    expect(left.open).toBe(false);
    const stayed = reduceViewerDrawer(atBottom, { type: "pointer-left-window", approach: false });
    expect(stayed.open).toBe(true);
  });
});

describe("shouldIgnoreViewerPointerMove", () => {
  it("ignores a stationary or sub-pixel sample and accepts a real move", () => {
    expect(shouldIgnoreViewerPointerMove({ clientX: 10, clientY: 10 }, null)).toBe(false);
    expect(shouldIgnoreViewerPointerMove({ clientX: 10, clientY: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(shouldIgnoreViewerPointerMove({ clientX: 11, clientY: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(shouldIgnoreViewerPointerMove({ clientX: 14, clientY: 10 }, { x: 10, y: 10 })).toBe(false);
  });
});
