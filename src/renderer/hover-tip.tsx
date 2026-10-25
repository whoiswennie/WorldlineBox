import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { isImeKeyboardEvent } from './ime-safe-dismiss';
import { placeOverlayInViewport, readOverlayViewport } from './place-overlay';

/** Quiet delay before a hover tip appears (REQ-SHELL-013 follow-up). */
export const HOVER_TIP_SHOW_DELAY_MS = 420;

type TipAnchor = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
};

type TipState = {
  readonly id?: string;
  readonly text: string;
  readonly anchor: TipAnchor;
  readonly variant: "default" | "search-syntax";
};

type TipBox = {
  readonly left: number;
  readonly top: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
};

function renderSearchSyntaxTip(text: string): ReactNode {
  return text.split('\n').map((line, lineIndex) => (
    <span className="search-syntax-tip-line" key={`${lineIndex}:${line}`}>
      {line.split(/(\*\*[^*]+\*\*)/u).map((part, partIndex) => {
        const isEmphasis = part.startsWith('**') && part.endsWith('**');
        return isEmphasis ? (
          <strong key={`${partIndex}:${part}`}>{part.slice(2, -2)}</strong>
        ) : (
          <Fragment key={`${partIndex}:${part}`}>{part}</Fragment>
        );
      })}
    </span>
  ));
}

/**
 * Document-level hover tip host. Mount once near the app root. Any element
 * with `data-hover-tip` participates; the tip renders into `document.body`
 * at the same stacking tier as context menus (styles.css `.hover-tip`).
 */
export function HoverTipHost() {
  const [tip, setTip] = useState<TipState | null>(null);
  const [box, setBox] = useState<TipBox | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const activeElRef = useRef<Element | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      activeElRef.current = null;
      setTip(null);
    };

    const scheduleShow = (el: Element) => {
      const text = el.getAttribute('data-hover-tip')?.trim();
      if (!text) {
        hide();
        return;
      }
      if (activeElRef.current === el) return;
      clearTimer();
      activeElRef.current = el;
      setTip(null);
      const id = el.getAttribute('data-hover-tip-id') ?? undefined;
      showTimerRef.current = window.setTimeout(() => {
        if (activeElRef.current !== el) return;
        const rect = el.getBoundingClientRect();
        const variant =
          el.getAttribute('data-hover-tip-variant') === 'search-syntax'
            ? 'search-syntax'
            : 'default';
        setBox(null);
        setTip({
          id,
          text,
          anchor: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          variant,
        });
        showTimerRef.current = null;
      }, HOVER_TIP_SHOW_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest('[data-hover-tip]');
      if (!el || !(el instanceof Element)) {
        if (activeElRef.current) hide();
        return;
      }
      scheduleShow(el);
    };

    const onPointerOut = (event: PointerEvent) => {
      const related = event.relatedTarget;
      if (
        related instanceof Element &&
        activeElRef.current?.contains(related)
      ) {
        return;
      }
      const leaving = event.target;
      if (
        leaving instanceof Element &&
        activeElRef.current &&
        (leaving === activeElRef.current ||
          activeElRef.current.contains(leaving))
      ) {
        hide();
      }
    };

    const onPointerDown = () => hide();
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest('[data-hover-tip]');
      if (el instanceof Element) scheduleShow(el);
    };
    const onFocusOut = (event: FocusEvent) => {
      const related = event.relatedTarget;
      if (
        related instanceof Element &&
        activeElRef.current?.contains(related)
      ) {
        return;
      }
      const leaving = event.target;
      if (
        leaving instanceof Element &&
        activeElRef.current &&
        (leaving === activeElRef.current || activeElRef.current.contains(leaving))
      ) {
        hide();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape') hide();
    };
    const onScroll = () => hide();

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', hide);

    return () => {
      clearTimer();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip) return;
    const measure = () => {
      const node = tipRef.current;
      if (!node) return;
      const placed = placeOverlayInViewport({
        anchor: tip.anchor,
        size: { width: node.offsetWidth, height: node.offsetHeight },
        viewport: readOverlayViewport(),
        align: 'center',
      });
      setBox((current) => (
        current
        && current.left === placed.left
        && current.top === placed.top
        && current.maxWidth === placed.maxWidth
        && current.maxHeight === placed.maxHeight
          ? current
          : placed
      ));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tip]);

  if (!tip || typeof document === 'undefined') return null;

  const style: CSSProperties = box
    ? {
        left: box.left,
        top: box.top,
        maxHeight: box.maxHeight,
        visibility: 'visible',
      }
    : { left: 0, top: 0, visibility: 'hidden' };

  return createPortal(
    <div
      className={`hover-tip${tip.variant === 'search-syntax' ? ' is-search-syntax' : ''}`}
      id={tip.id}
      ref={tipRef}
      role="tooltip"
      style={style}
    >
      {tip.variant === 'search-syntax'
        ? renderSearchSyntaxTip(tip.text)
        : tip.text}
    </div>,
    document.body,
  );
}
