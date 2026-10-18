import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { WorldlineBoxShellApi } from "../shared/external-url";
import {
  WINDOW_RESIZE_EDGES,
  type WindowResizeEdge,
} from "../shared/window-edge-resize";

type Props = {
  shell: WorldlineBoxShellApi | null | undefined;
};

const EDGE_CURSOR: Record<WindowResizeEdge, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/**
 * Invisible edge/corner hit targets for Linux frameless windows.
 * Prefer Main `_NET_WM_MOVERESIZE`; fall back to pointer-capture + setBounds.
 */
export function WindowEdgeResizeHandles({ shell }: Props) {
  const [maximized, setMaximized] = useState(false);
  const dragRef = useRef<{
    edge: WindowResizeEdge;
    startX: number;
    startY: number;
    startBounds: { x: number; y: number; width: number; height: number };
  } | null>(null);

  useEffect(() => {
    if (!shell?.needsClientWindowEdgeResize()) return;
    void shell.windowControl("get-state").then((result) => {
      if (result.ok) setMaximized(result.maximized);
    });
    return shell.onWindowMaximizedChanged((next) => {
      setMaximized(next);
    });
  }, [shell]);

  const onPointerDown = useCallback(
    async (edge: WindowResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
      if (!shell?.needsClientWindowEdgeResize() || maximized) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      // Capture before any await — React nulls currentTarget after the handler yields.
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.screenX;
      const startY = event.screenY;

      const started = await shell.beginWindowEdgeResize(edge);
      if (started.ok && started.mode === "native") {
        return;
      }
      if (!started.ok && started.code === "maximized") {
        return;
      }

      const boundsResult = await shell.getWindowBounds();
      if (!boundsResult.ok) return;

      dragRef.current = {
        edge,
        startX,
        startY,
        startBounds: boundsResult.bounds,
      };
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Element may have unmounted during the await.
      }
    },
    [shell, maximized],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !shell) return;
      const dx = event.screenX - drag.startX;
      const dy = event.screenY - drag.startY;
      void shell.setWindowBoundsFromEdgeDelta({
        edge: drag.edge,
        startBounds: drag.startBounds,
        dx,
        dy,
      });
    },
    [shell],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
  }, []);

  if (!shell?.needsClientWindowEdgeResize() || maximized) return null;

  return (
    <div className="window-edge-resize-layer" aria-hidden="true">
      {WINDOW_RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`window-edge-resize-handle window-edge-resize-${edge}`}
          data-edge={edge}
          style={{ cursor: EDGE_CURSOR[edge] }}
          onPointerDown={(event) => {
            void onPointerDown(edge, event);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ))}
    </div>
  );
}
