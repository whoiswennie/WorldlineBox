/** Keep a floating surface inside the window instead of letting an edge clip it. */

export const OVERLAY_VIEWPORT_MARGIN = 8;

export interface OverlayAnchor {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface OverlaySize {
  readonly width: number;
  readonly height: number;
}

export interface OverlayViewport {
  readonly width: number;
  readonly height: number;
}

export interface PlacedOverlay {
  readonly left: number;
  readonly top: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly side: "above" | "below";
}

export function placeOverlayInViewport(input: {
  readonly anchor: OverlayAnchor;
  readonly size: OverlaySize;
  readonly viewport: OverlayViewport;
  readonly gap?: number;
  readonly margin?: number;
  /** Horizontal alignment of the overlay against the anchor. */
  readonly align?: "start" | "center" | "end";
  /** Preferred vertical side. The other side is used when this one cannot fit. */
  readonly prefer?: "above" | "below";
}): PlacedOverlay {
  const gap = input.gap ?? 6;
  const margin = input.margin ?? OVERLAY_VIEWPORT_MARGIN;
  const align = input.align ?? "start";
  const prefer = input.prefer ?? "below";
  const { anchor, size, viewport } = input;
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const width = Math.min(Math.max(0, size.width), maxWidth);
  const height = Math.min(Math.max(0, size.height), maxHeight);
  const spaceBelow = Math.max(0, viewport.height - margin - (anchor.bottom + gap));
  const spaceAbove = Math.max(0, anchor.top - gap - margin);
  const fitsBelow = height <= spaceBelow;
  const fitsAbove = height <= spaceAbove;
  const side = chooseSide(prefer, fitsBelow, fitsAbove, spaceBelow, spaceAbove);
  let top = side === "below" ? anchor.bottom + gap : anchor.top - gap - height;
  top = clamp(top, margin, Math.max(margin, viewport.height - margin - height));
  const unclampedLeft = align === "center"
    ? anchor.left + anchor.width / 2 - width / 2
    : align === "end"
      ? anchor.right - width
      : anchor.left;
  const left = clamp(
    unclampedLeft,
    margin,
    Math.max(margin, viewport.width - margin - width),
  );
  return { left, top, maxWidth, maxHeight, side };
}

function chooseSide(
  prefer: "above" | "below",
  fitsBelow: boolean,
  fitsAbove: boolean,
  spaceBelow: number,
  spaceAbove: number,
): "above" | "below" {
  if (prefer === "below" && fitsBelow) return "below";
  if (prefer === "above" && fitsAbove) return "above";
  if (fitsBelow && !fitsAbove) return "below";
  if (fitsAbove && !fitsBelow) return "above";
  if (spaceAbove === spaceBelow) return prefer;
  return spaceAbove > spaceBelow ? "above" : "below";
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export function readOverlayViewport(): OverlayViewport {
  return {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  };
}
