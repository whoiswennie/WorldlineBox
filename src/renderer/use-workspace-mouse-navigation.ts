/**
 * Window-level mouse back/forward for workspace history (WorldlineBox-1xmk).
 *
 * Mirrors toolbar back/forward; preview close is delegated to the callbacks.
 */

import { useEffect } from "react";

import {
  isWorkspaceMouseSideButton,
  resolveWorkspaceMouseNavAction,
} from "./workspace-mouse-navigation";

export type UseWorkspaceMouseNavigationArgs = {
  readonly enabled: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
};

export function useWorkspaceMouseNavigation(
  args: UseWorkspaceMouseNavigationArgs,
): void {
  const { enabled, onBack, onForward } = args;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!enabled) return;
      const action = resolveWorkspaceMouseNavAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "back") onBack();
      else onForward();
    };
    const preventBrowserHistory = (event: MouseEvent) => {
      if (isWorkspaceMouseSideButton(event.button)) event.preventDefault();
    };

    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("mousedown", preventBrowserHistory, { capture: true });
    window.addEventListener("mouseup", preventBrowserHistory, { capture: true });
    window.addEventListener("auxclick", preventBrowserHistory, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("mousedown", preventBrowserHistory, { capture: true });
      window.removeEventListener("mouseup", preventBrowserHistory, { capture: true });
      window.removeEventListener("auxclick", preventBrowserHistory, { capture: true });
    };
  }, [enabled, onBack, onForward]);
}
