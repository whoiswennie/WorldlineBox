import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Controls whose changes are previewed live on the app behind Settings.
 * While one of these is being adjusted, the modal backdrop fades its dim and
 * blur away so the real result is visible (a93).
 */
export const APPEARANCE_CONTROL_SELECTOR = [
  'input[type="range"]',
  'input[type="color"]',
  '[role="slider"]',
  '[role="radio"]',
  '[role="switch"]',
  ".elevation-pad",
  ".app-settings-theme-profile",
].join(", ");

/** Delay before the backdrop fades back in after the last interaction. */
export const APPEARANCE_ADJUST_SETTLE_MS = 1200;

export function isAppearanceControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(APPEARANCE_CONTROL_SELECTOR) !== null;
}

/**
 * Returns `[adjusting, handlers]`; spread the handlers onto the element that
 * contains the controls. `enabled` limits it to appearance-type pages.
 */
export function useAppearanceAdjusting(enabled: boolean) {
  const [adjusting, setAdjusting] = useState(false);
  const timer = useRef<number | null>(null);
  const pointerActive = useRef(false);

  // Disabling the page must drop the preview immediately. Reset during render
  // so the returned flag matches `enabled` without a setState-in-effect.
  if (!enabled && adjusting) setAdjusting(false);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const settle = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!pointerActive.current) setAdjusting(false);
    }, APPEARANCE_ADJUST_SETTLE_MS);
  }, []);
  const start = useCallback(() => {
    clear();
    setAdjusting(true);
  }, []);

  useEffect(() => {
    if (!enabled) {
      clear();
      pointerActive.current = false;
      return undefined;
    }
    const onUp = () => {
      if (!pointerActive.current) return;
      pointerActive.current = false;
      settle();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      clear();
    };
  }, [enabled, settle]);

  const handlers = {
    onPointerDownCapture: (event: { target: EventTarget | null }) => {
      if (!enabled || !isAppearanceControl(event.target)) return;
      pointerActive.current = true;
      start();
    },
    onInputCapture: (event: { target: EventTarget | null }) => {
      if (!enabled || !isAppearanceControl(event.target)) return;
      start();
      if (!pointerActive.current) settle();
    },
    onKeyDownCapture: (event: { target: EventTarget | null; key: string }) => {
      if (!enabled || !isAppearanceControl(event.target)) return;
      if (!/^(Arrow|Home$|End$|Page)/u.test(event.key)) return;
      start();
      settle();
    },
  };

  return [adjusting, handlers] as const;
}
