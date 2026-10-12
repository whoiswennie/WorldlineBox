/** Bottom band that slides the video transport in (VIEW-VIDEO-001). */
export const VIDEO_TRANSPORT_APPROACH_PX = 128;

/**
 * Pointer samples smaller than this are not a user move. A playing video can
 * emit pointermove at nearly the same point and was keeping the transport
 * visible after the viewed asset changed.
 */
export const VIDEO_TRANSPORT_POINTER_EPSILON_PX = 2;

export type PointerSample = {
  readonly x: number;
  readonly y: number;
};

export function shouldIgnoreViewerPointerMove(
  event: { readonly clientX: number; readonly clientY: number },
  last: PointerSample | null,
): boolean {
  if (last === null) return false;
  const dx = event.clientX - last.x;
  const dy = event.clientY - last.y;
  const epsilon = VIDEO_TRANSPORT_POINTER_EPSILON_PX;
  return dx * dx + dy * dy < epsilon * epsilon;
}

/** A playing video can emit pointermove with no movement. That is not the user. */
export function pointerEventIsUserMove(event: {
  readonly movementX?: number;
  readonly movementY?: number;
}): boolean {
  return (event.movementX ?? 0) !== 0 || (event.movementY ?? 0) !== 0;
}

export type TransportZoneBounds = {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
};

/** True when the pointer is inside the viewer and within the bottom band. */
export function pointerInVideoTransportZone(
  bounds: TransportZoneBounds,
  clientX: number,
  clientY: number,
  approachPx = VIDEO_TRANSPORT_APPROACH_PX,
): boolean {
  if (clientX < bounds.left || clientX > bounds.right) return false;
  if (clientY < bounds.top || clientY > bounds.bottom) return false;
  return bounds.height - (clientY - bounds.top) <= approachPx;
}

export type ViewerChromeBands = {
  readonly bottom: boolean;
  readonly top: boolean;
};

export type ViewerDrawerState = {
  readonly open: boolean;
  readonly toolbarNear: boolean;
  readonly toolbarNearTop: boolean;
};

/** First opened asset shows the bar. A later asset starts closed. */
export const INITIAL_VIEWER_DRAWER_STATE: ViewerDrawerState = {
  open: true,
  toolbarNear: false,
  toolbarNearTop: false,
};

export type ViewerDrawerEvent =
  | {
      readonly type: "pointer-move";
      readonly approach: boolean;
      readonly userMove: boolean;
      readonly ignored: boolean;
      readonly bands: ViewerChromeBands;
    }
  | {
      readonly type: "asset-changed";
      readonly approach: boolean;
      readonly hasPointer: boolean;
      readonly bands: ViewerChromeBands;
    }
  | { readonly type: "chrome-idle"; readonly approach: boolean }
  | { readonly type: "pointer-left-window"; readonly approach: boolean };

function drawerWithBands(bands: ViewerChromeBands): ViewerDrawerState {
  return {
    open: bands.bottom,
    toolbarNear: bands.bottom,
    toolbarNearTop: bands.top,
  };
}

function sameDrawer(left: ViewerDrawerState, right: ViewerDrawerState): boolean {
  return left.open === right.open
    && left.toolbarNear === right.toolbarNear
    && left.toolbarNearTop === right.toolbarNearTop;
}

const CLOSED_DRAWER: ViewerDrawerState = {
  open: false,
  toolbarNear: false,
  toolbarNearTop: false,
};

/**
 * Drawer visibility for the stable viewer host.
 * Switching assets closes the bar. A stationary pointermove must not open it.
 */
export function reduceViewerDrawer(
  state: ViewerDrawerState,
  event: ViewerDrawerEvent,
): ViewerDrawerState {
  switch (event.type) {
    case "pointer-move": {
      if (!event.userMove || event.ignored) return state;
      if (!event.approach) {
        return state.open ? state : { ...state, open: true };
      }
      const next = drawerWithBands(event.bands);
      return sameDrawer(state, next) ? state : next;
    }
    case "asset-changed": {
      if (!event.approach) {
        return state.open ? { ...state, open: false } : state;
      }
      if (!event.hasPointer) return CLOSED_DRAWER;
      const next = drawerWithBands(event.bands);
      return sameDrawer(state, next) ? state : next;
    }
    case "chrome-idle":
      if (event.approach || !state.open) return state;
      return { ...state, open: false };
    case "pointer-left-window":
      return event.approach ? CLOSED_DRAWER : state;
    default:
      return state;
  }
}

/** True when the pointer is inside the viewer and within the top band. */
export function pointerInViewerTopZone(
  bounds: TransportZoneBounds,
  clientX: number,
  clientY: number,
  approachPx = VIDEO_TRANSPORT_APPROACH_PX,
): boolean {
  if (clientX < bounds.left || clientX > bounds.right) return false;
  if (clientY < bounds.top || clientY > bounds.bottom) return false;
  return clientY - bounds.top <= approachPx;
}
