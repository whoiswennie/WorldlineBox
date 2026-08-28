/** Coordinate rectangle accepted by an Electron child WebContentsView. */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Resolve the native browser bounds for ordinary and site-requested HTML fullscreen modes. */
export function browserViewBounds(
  surface: BrowserViewBounds,
  fullscreen: boolean,
  content: Pick<BrowserViewBounds, 'width' | 'height'> | undefined,
): BrowserViewBounds {
  return fullscreen && content !== undefined
    ? { x: 0, y: 0, width: content.width, height: content.height }
    : surface
}
