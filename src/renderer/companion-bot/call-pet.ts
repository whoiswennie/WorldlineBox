import { createContext, useCallback, useContext, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { CALL_PET_AVATAR_EDGE, CALL_PET_AVATAR_SIZE, CALL_PET_DOCK_INSET, CALL_PET_MAX_HEIGHT, CALL_PET_MAX_WIDTH, CALL_PET_WINDOW, type CallPetApi, type CallPetRect } from '../../shared/companion-call-window';

export const BotCallDocument = createContext<Document | undefined>(undefined);
export const BotMeetingSession = createContext<string | undefined>(undefined);
export const useBotMeetingSession = () => useContext(BotMeetingSession);
export const useBotCallDocument = () => useContext(BotCallDocument) ?? document;

function copyCallStyles(target: Document): void {
  target.documentElement.lang = document.documentElement.lang;
  target.documentElement.dataset.theme = document.documentElement.dataset.theme ?? '';
  target.documentElement.classList.add('bot-call-pet-document');
  target.documentElement.style.setProperty('--bot-call-pet-max-width', CALL_PET_MAX_WIDTH + 'px');
  target.documentElement.style.setProperty('--bot-call-pet-max-height', CALL_PET_MAX_HEIGHT + 'px');
  target.documentElement.style.setProperty('--bot-call-compact-avatar-size', CALL_PET_AVATAR_SIZE + 'px');
  target.documentElement.style.setProperty('--bot-call-compact-edge', CALL_PET_AVATAR_EDGE + 'px');
  target.documentElement.style.setProperty('--bot-call-pet-dock-inset', CALL_PET_DOCK_INSET + 'px');
  const base = target.createElement('base'); base.href = document.baseURI;
  target.head.append(base);
  for (const style of document.head.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]')) {
    const copy = target.importNode(style, true);
    if (style instanceof HTMLLinkElement) copy.setAttribute('href', style.href);
    target.head.append(copy);
  }
}

const petSurfaces = [
  '.bot-call-portrait-frame', '.bot-call-portrait h2', '.bot-call-loading', '.bot-call-notice',
  '.bot-call-bubble', '.bot-call-pet-progress', '.bot-call-review', '.bot-call-input-entry', '.bot-push-to-talk-status',
  // The expanded dock paints one panel across the status row and composer.
  '.bot-call-dock:not(.is-collapsed)',
  '.bot-call-pet-options', '.bot-call-interaction-panel', '.bot-topic-picker',
  '.bot-desktop-capture-panel', '.bot-desktop-capture-status', '.bot-presence-status', '.bot-presence-error',
  '.bot-context-panel', '.bot-expression-picker', '.bot-voice-panel', '.bot-diagnostic-dialog[open]', '.bot-call-send-error', '.bot-apps-picker', '.bot-video-login[open]',
].join(',');

function trackPetLayout(pet: Window, name: string, host: HTMLElement, api: CallPetApi) {
  const observed = new Set<HTMLElement>();
  let frame = 0, previous = '';
  const measure = () => {
    frame = 0;
    if (host.ownerDocument !== pet.document) return;
    const overlay = host.querySelector('.bot-call-overlay.is-desktop-pet');
    if (!overlay || pet.getComputedStyle(overlay).position !== 'fixed') return;
    const width = pet.innerWidth, height = pet.innerHeight;
    const rects: CallPetRect[] = [];
    const surfaces = new Set(host.querySelectorAll<HTMLElement>(petSurfaces));
    for (const node of observed) if (!surfaces.has(node)) { resize.unobserve(node); observed.delete(node); }
    const add = ({ x, y, width, height }: CallPetRect, margin: number, circular?: boolean) => {
      if (width > 0 && height > 0) rects.push({ x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin, circular });
    };
    for (const node of surfaces) {
      if (!observed.has(node)) { resize.observe(node); observed.add(node); }
      const circular = node.matches('.bot-call-compact-anchor');
      const margin = circular || node.matches('.bot-call-portrait-frame,.bot-call-portrait h2') ? 0 : 7;
      add(node.getBoundingClientRect(), margin, circular);
    }
    const figure = host.querySelector<HTMLElement>('.bot-call-live2d:not([hidden])');
    const bounds = figure?.dataset.petFigure?.split(',').map(Number);
    if (figure && bounds?.length === 4 && bounds.every(Number.isFinite)) {
      const canvas = figure.getBoundingClientRect();
      const [x, y, w, h] = bounds as [number, number, number, number];
      const left = Math.max(0, x), top = Math.max(0, y);
      add({ x: canvas.x + left, y: canvas.y + top, width: Math.min(canvas.width, x + w) - left, height: Math.min(canvas.height, y + h) - top }, 12);
    }
    if (!rects.length) return;
    const anchorRevision = overlay.classList.contains('is-pet-compact')
      ? Number(pet.document.documentElement.dataset.callPetAnchorRevision ?? 0) : undefined;
    const key = JSON.stringify([width, height, rects, anchorRevision]);
    if (key === previous) return;
    previous = key;
    api.command({ type: 'layout', name, width, height, rects, anchorRevision });
  };
  const schedule = () => { if (!frame && !pet.closed) frame = pet.requestAnimationFrame(measure); };
  const resize = new ResizeObserver(schedule);
  const mutation = new MutationObserver(schedule);
  mutation.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'data-pet-figure'] });
  mutation.observe(pet.document.documentElement, { attributes: true, attributeFilter: ['data-call-pet-anchor-revision'] });
  resize.observe(pet.document.documentElement);
  pet.addEventListener('resize', schedule);
  pet.document.head.addEventListener('load', schedule, true);
  measure();
  return () => {
    if (!pet.closed) {
      pet.cancelAnimationFrame(frame);
      pet.removeEventListener('resize', schedule);
      pet.document.head.removeEventListener('load', schedule, true);
    }
    resize.disconnect();
    mutation.disconnect();
  };
}

export function useCallPet(onModeChange?: (active: boolean, returning?: boolean) => void) {
  const api = (window as Window & { worldlinebox?: { companionCallPet?: CallPetApi } }).worldlinebox?.companionCallPet;
  const [host] = useState(() => document.createElement('div'));
  const [pet, setPet] = useState<Window>();
  const active = useRef<{ window: Window; name: string }>(undefined);
  const [surface, setSurface] = useState(document);
  const moveHome = useCallback(() => {
    document.body.append(host);
    active.current = undefined;
    setPet(undefined);
    setSurface(document);
  }, [host]);
  const returnToScene = useCallback(() => {
    moveHome();
    onModeChange?.(false, true);
  }, [moveHome, onModeChange]);
  const onNativeClose = useEffectEvent((name: string) => {
    if (active.current?.name === name) returnToScene();
  });
  useLayoutEffect(() => {
    // The portal can already be in the child when React reconnects effects.
    const child = active.current?.window;
    if (!host.isConnected) (child?.closed === false ? child.document : document).body.append(host);
    const off = api?.onClosed(name => onNativeClose(name));
    const offAnchor = api?.onAnchorChanged((name, anchor, revision) => {
      const child = active.current;
      if (child?.name !== name || child.window.closed) return;
      const root = child.window.document.documentElement;
      root.style.setProperty('--bot-call-anchor-x', anchor.x + 'px');
      root.style.setProperty('--bot-call-anchor-y', anchor.y + 'px');
      root.dataset.callPetSide = anchor.side;
      root.dataset.callPetEdge = anchor.edge;
      root.toggleAttribute('data-call-pet-stacked', anchor.stacked);
      root.dataset.callPetAnchorRevision = String(revision);
    });
    return () => {
      off?.();
      offAnchor?.();
      if (active.current) api?.command({ type: 'close', name: active.current.name });
      host.remove();
    };
  }, [api, host]);
  useLayoutEffect(() => {
    const name = active.current?.name;
    if (!pet || pet.closed || !name || !api) return;
    const target = pet.document;
    let drag: { pointer: number; x: number; y: number; clickTarget: HTMLElement | null; moved: boolean } | undefined;
    let suppressClick: HTMLElement | null = null;
    const start = (event: PointerEvent) => {
      const grip = (event.target as Element | null)?.closest<HTMLElement>('[data-pet-drag]');
      if (!grip || event.button !== 0 || drag) return;
      const clickTarget = grip.matches('button') ? grip : null;
      if (!clickTarget) event.preventDefault();
      suppressClick = null;
      drag = { pointer: event.pointerId, x: event.screenX, y: event.screenY, clickTarget, moved: false };
      grip.setPointerCapture(event.pointerId);
      api.command({ type: 'drag-start', x: event.screenX, y: event.screenY });
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      if (drag.clickTarget && !drag.moved && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < 5) return;
      drag.moved = true;
      api.command({ type: 'drag-move', x: event.screenX, y: event.screenY });
    };
    const stop = () => {
      if (!drag) return;
      suppressClick = drag.moved ? drag.clickTarget : null;
      drag = undefined;
      api.command('drag-end');
    };
    const end = (event: PointerEvent) => { if (event.pointerId === drag?.pointer) stop(); };
    const click = (event: MouseEvent) => {
      if (event.detail && suppressClick?.contains(event.target as Node | null)) {
        event.stopPropagation(); event.preventDefault(); suppressClick = null;
      }
    };
    const endings = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
    target.addEventListener('pointerdown', start);
    target.addEventListener('pointermove', move);
    target.addEventListener('click', click, true);
    for (const type of endings) target.addEventListener(type, end);
    pet.addEventListener('blur', stop);
    const stopLayout = trackPetLayout(pet, name, host, api);
    return () => {
      stopLayout();
      target.removeEventListener('pointerdown', start);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('click', click, true);
      for (const type of endings) target.removeEventListener(type, end);
      if (!pet.closed) pet.removeEventListener('blur', stop);
      stop();
    };
  }, [api, host, pet]);
  const toggle = () => {
    if (!api?.supported) return false;
    if (active.current) {
      const name = active.current.name;
      returnToScene(); api.command({ type: 'return', name }); return true;
    }
    const name = `${CALL_PET_WINDOW}:${crypto.randomUUID()}`;
    const child = window.open('about:blank', name);
    if (!child) return false;
    try {
      copyCallStyles(child.document);
      child.document.body.append(host);
      active.current = { window: child, name };
      setSurface(child.document); setPet(child);
      onModeChange?.(true);
      return true;
    } catch {
      moveHome(); api.command({ type: 'close', name }); return false;
    }
  };
  return { host, pet: !!pet && surface !== document, surface, supported: !!api?.supported, toggle };
}
