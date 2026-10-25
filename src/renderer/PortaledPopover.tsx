/**
 * Portals dimension/toolbar popovers to document.body so they escape the
 * workspace stacking context (z-index:0 + isolation) and are not painted
 * under the inspector/navigation panes (MENU-015 / WorldlineBox-iihv).
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createShellPortal } from "./ui/ShellStyleScope";

import { layerCssVar, type UiLayerName } from "./ui/foundation";
import { PopoverSurface, type PopoverSurfaceProps } from "./ui/patterns";
import {
  placeOverlayInViewport,
  readOverlayViewport,
  type PlacedOverlay,
} from "./place-overlay";

type PortaledPopoverLayer = Extract<UiLayerName, "popover" | "modal" | "tooltip">;

type PopoverPlacement = PlacedOverlay & {
  readonly inModal: boolean;
};

export type PortaledPopoverProps = PopoverSurfaceProps & {
  /** Element that owns the popover (usually the dimension button host). */
  readonly anchorRef: RefObject<HTMLElement | null>;
  /** Prefer right-align when the panel would overflow the viewport. */
  readonly preferRight?: boolean;
  /**
   * Named stacking layer. Defaults to popover (filters/toolbars).
   * Anchors inside a dialog automatically use its overlay layer, retaining
   * DOM order above the dialog while leaving the window caption above both.
   */
  readonly layer?: PortaledPopoverLayer;
};

export function PortaledPopover({
  anchorRef,
  preferRight = false,
  layer = "popover",
  className,
  style,
  children,
  ...rest
}: PortaledPopoverProps): ReactNode {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const surface = surfaceRef.current;
      if (!anchor || !surface) return;
      const rect = anchor.getBoundingClientRect();
      const placed = placeOverlayInViewport({
        anchor: rect,
        size: { width: surface.offsetWidth, height: surface.offsetHeight },
        viewport: readOverlayViewport(),
        align: preferRight ? "end" : "start",
      });
      const next: PopoverPlacement = {
        ...placed,
        inModal: anchor.closest('[role="dialog"]') != null,
      };
      setPlacement((current) => (
        current
        && current.left === next.left
        && current.top === next.top
        && current.maxWidth === next.maxWidth
        && current.maxHeight === next.maxHeight
        && current.side === next.side
        && current.inModal === next.inModal
          ? current
          : next
      ));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, preferRight]);

  if (typeof document === "undefined") return null;

  return createShellPortal(
    <PopoverSurface
      {...rest}
      className={className}
      data-dimension-filter-popover=""
      data-modal-popover={placement?.inModal || undefined}
      ref={surfaceRef}
      style={{
        ...style,
        position: "fixed",
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        right: "auto",
        maxWidth: placement?.maxWidth,
        maxHeight: placement?.maxHeight,
        overflowY: "auto",
        visibility: placement ? "visible" : "hidden",
        zIndex: placement?.inModal ? "var(--ui-layer-modal-backdrop)" : layerCssVar(layer),
      }}
    >
      {children}
    </PopoverSurface>,
    document.body,
  );
}
