/**
 * VIEWER-001 / WorldlineBox-bd481f: after the viewer closes, other restore loops
 * (canvas width reflow, leftover workspace viewport, virtual geometry
 * anchors) can still write scrollTop about half a second later and yank the
 * browse canvas to the top. Hold the captured offset until those loops
 * settle, and optionally spy every write so a session log names the caller.
 */

export const BROWSE_SCROLL_DEBUG = false;
const DEBUG_PREFIX = "[DEBUG-bd481f]";

export const PREVIEW_SCROLL_HOLD_MS = 1_500;

export function canvasHasPreviewScrollHold(
  canvas: {
    dataset?: { previewScrollHold?: string };
    classList?: { contains(name: string): boolean };
  } | null,
): boolean {
  if (!canvas) return false;
  return (
    canvas.dataset?.previewScrollHold === "1" ||
    Boolean(canvas.classList?.contains("is-viewing")) ||
    Boolean(canvas.classList?.contains("is-restoring"))
  );
}

export function setCanvasPreviewScrollHold(canvas: HTMLElement | null, held: boolean): void {
  if (!canvas) return;
  if (held) canvas.dataset.previewScrollHold = "1";
  else delete canvas.dataset.previewScrollHold;
}

/**
 * Focus restoration may find a card from the top virtual window while the
 * canvas is still scrolled deep. Applying that rect would jump to 0.
 */
export function shouldApplyRestoredFocusScroll(
  restoredTop: number,
  nextTop: number,
  viewportHeight: number,
): boolean {
  const view = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  return Math.abs(nextTop - restoredTop) <= view;
}

function stackHint(): string {
  const stack = new Error("browse-scroll-write").stack ?? "";
  return stack
    .split("\n")
    .slice(2, 8)
    .map((line) => line.trim())
    .join(" | ");
}

export function logBrowseScrollWrite(
  source: string,
  canvas: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight"> & {
    className?: string;
  },
  extra: Record<string, unknown> = {},
): void {
  if (!BROWSE_SCROLL_DEBUG) return;
  const extent = Math.max(0, canvas.scrollHeight - canvas.clientHeight);
  console.warn(
    `${DEBUG_PREFIX} ${source} ${JSON.stringify({
      scrollTop: Math.round(canvas.scrollTop),
      extent: Math.round(extent),
      clientHeight: Math.round(canvas.clientHeight),
      className: canvas.className ?? "",
      ...extra,
      stack: stackHint(),
    })}`,
  );
}

export function installBrowseScrollWriteSpy(canvas: HTMLElement): () => void {
  if (!BROWSE_SCROLL_DEBUG) return () => undefined;
  const element = canvas as HTMLElement & { __worldlineboxBrowseScrollSpy?: boolean };
  if (element.__worldlineboxBrowseScrollSpy) return () => undefined;
  element.__worldlineboxBrowseScrollSpy = true;

  const descriptor =
    Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") ??
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  const originalScrollTo = canvas.scrollTo.bind(canvas);

  if (descriptor?.set && descriptor.get) {
    Object.defineProperty(canvas, "scrollTop", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get!.call(canvas) as number;
      },
      set(value: number) {
        const before = descriptor.get!.call(canvas) as number;
        descriptor.set!.call(canvas, value);
        if (Math.abs(before - (descriptor.get!.call(canvas) as number)) >= 1) {
          logBrowseScrollWrite("scrollTop=", canvas, { before: Math.round(before), value: Math.round(value) });
        }
      },
    });
  }

  canvas.scrollTo = ((arg?: ScrollToOptions | number, y?: number) => {
    const before = canvas.scrollTop;
    if (typeof arg === "number") originalScrollTo(arg, y ?? 0);
    else originalScrollTo(arg ?? {});
    if (Math.abs(before - canvas.scrollTop) >= 1) {
      logBrowseScrollWrite("scrollTo", canvas, {
        before: Math.round(before),
        arg: typeof arg === "number" ? { top: y } : { top: arg?.top, left: arg?.left },
      });
    }
  }) as HTMLElement["scrollTo"];

  return () => {
    delete element.__worldlineboxBrowseScrollSpy;
    if (descriptor) Object.defineProperty(canvas, "scrollTop", descriptor);
    canvas.scrollTo = originalScrollTo;
  };
}
