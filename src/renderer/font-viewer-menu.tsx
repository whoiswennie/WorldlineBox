import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { isImeKeyboardEvent } from "./ime-safe-dismiss";
import { PortaledPopover } from "./PortaledPopover";
import {
  focusFirstRovingItem,
  handleRovingListKeyDown,
  ROVING_OPTION_SELECTOR,
} from "./roving-list-keyboard";

/**
 * Font-viewer toolbar list. Native `<select>` popups stay on the OS theme,
 * so a dark window still gets a white language list.
 */
export function FontViewerMenu({
  label,
  onChange,
  options,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { value: string; label: string }[];
  readonly value: string;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const host = hostRef.current;
      if (!host || !(event.target instanceof Element)) return;
      if (host.contains(event.target)) return;
      if (event.target.closest("[data-dimension-filter-popover]")) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeKeyboardEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    const raf = requestAnimationFrame(() => {
      const list = document.getElementById(listId);
      if (!list) return;
      const current = list.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
      if (current) current.focus();
      else focusFirstRovingItem(list, ROVING_OPTION_SELECTOR);
    });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      cancelAnimationFrame(raf);
    };
  }, [listId, open]);

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (isImeKeyboardEvent(event.nativeEvent)) return;
    const result = handleRovingListKeyDown({
      key: event.key,
      container: event.currentTarget,
      itemSelector: ROVING_OPTION_SELECTOR,
    });
    if (!result.handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (result.action === "escape") {
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  function pick(next: string) {
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== value) onChange(next);
  }

  return (
    <div className="font-viewer-menu" ref={hostRef}>
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className="font-viewer-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
        ref={triggerRef}
        type="button"
      >
        {selected?.label ?? value}
      </button>
      {open ? (
        <PortaledPopover
          anchorRef={hostRef}
          className="ui-menu-surface font-viewer-menu-list"
          id={listId}
          onKeyDown={onListKeyDown}
          role="listbox"
        >
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={option.value === value ? "is-selected" : undefined}
              key={option.value}
              onClick={() => pick(option.value)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </PortaledPopover>
      ) : null}
    </div>
  );
}
