import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import { CALL_PET_MAX_HEIGHT, CALL_PET_MAX_WIDTH, CALL_PET_WINDOW, type CallPetApi, type CallPetRect } from '../../shared/companion-call-window';

export const BotCallDocument = createContext<Document | undefined>(undefined);
export const useBotCallDocument = () => useContext(BotCallDocument) ?? document;

function copyCallStyles(target: Document): void {
  target.documentElement.lang = document.documentElement.lang;
  target.documentElement.dataset.theme = document.documentElement.dataset.theme ?? '';
  target.documentElement.classList.add('bot-call-pet-document');
  target.documentElement.style.setProperty('--bot-call-pet-max-width', CALL_PET_MAX_WIDTH + 'px');
  target.documentElement.style.setProperty('--bot-call-pet-max-height', CALL_PET_MAX_HEIGHT + 'px');
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
  '.bot-call-bubble', '.bot-call-progress', '.bot-call-topics', '.bot-call-composer-host',
  '.bot-call-pet-options', '.bot-call-chat:not([hidden])', '.bot-topic-picker',
  '.bot-context-panel', '.bot-expression-picker', '.bot-voice-panel',
].join(',');

function trackPetLayout(pet: Window, host: HTMLElement, api: CallPetApi) {
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
    const add = ({ x, y, width, height }: CallPetRect, margin: number) => {
      if (width > 0 && height > 0) rects.push({ x: x - margin, y: y - margin, width: width + 2 * margin, height: height + 2 * margin });
    };
    for (const node of surfaces) {
      if (!observed.has(node)) { resize.observe(node); observed.add(node); }
      add(node.getBoundingClientRect(), node.matches('.bot-call-portrait-frame,.bot-call-portrait h2') ? 0 : 7);
    }
    const figure = host.querySelector<HTMLElement>('.bot-call-live2d');
    const bounds = figure?.dataset.petFigure?.split(',').map(Number);
    if (figure && bounds?.length === 4 && bounds.every(Number.isFinite)) {
      const canvas = figure.getBoundingClientRect();
      const [x, y, w, h] = bounds as [number, number, number, number];
      const left = Math.max(0, x), top = Math.max(0, y);
      add({ x: canvas.x + left, y: canvas.y + top, width: Math.min(canvas.width, x + w) - left, height: Math.min(canvas.height, y + h) - top }, 12);
    }
    if (!rects.length) return;
    const key = JSON.stringify([width, height, rects]);
    if (key === previous) return;
    previous = key;
    api.command({ type: 'layout', width, height, rects });
  };
  const schedule = () => { if (!frame && !pet.closed) frame = pet.requestAnimationFrame(measure); };
  const resize = new ResizeObserver(schedule);
  const mutation = new MutationObserver(schedule);
  mutation.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-pet-figure'] });
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
  const active = useRef<Window>(undefined);
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
  useLayoutEffect(() => {
    // The portal can already be in the child when React reconnects effects.
    if (!host.isConnected) (active.current?.closed === false ? active.current.document : document).body.append(host);
    const off = api?.onClosed(() => { if (active.current?.closed) returnToScene(); });
    return () => {
      off?.();
      if (active.current) api?.command('close');
      host.remove();
    };
  }, [api, host, returnToScene]);
  useLayoutEffect(() => {
    if (!pet || pet.closed || !api) return;
    const target = pet.document;
    let pointer: number | undefined;
    const start = (event: PointerEvent) => {
      const grip = (event.target as Element | null)?.closest<HTMLElement>('[data-pet-drag]');
      if (!grip || event.button !== 0 || pointer !== undefined) return;
      event.preventDefault();
      pointer = event.pointerId;
      grip.setPointerCapture(pointer);
      api.command({ type: 'drag-start', x: event.screenX, y: event.screenY });
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointer) api.command({ type: 'drag-move', x: event.screenX, y: event.screenY });
    };
    const stop = () => { if (pointer !== undefined) { pointer = undefined; api.command('drag-end'); } };
    const end = (event: PointerEvent) => { if (event.pointerId === pointer) stop(); };
    const endings = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
    target.addEventListener('pointerdown', start);
    target.addEventListener('pointermove', move);
    for (const type of endings) target.addEventListener(type, end);
    pet.addEventListener('blur', stop);
    const stopLayout = trackPetLayout(pet, host, api);
    return () => {
      stopLayout();
      target.removeEventListener('pointerdown', start);
      target.removeEventListener('pointermove', move);
      for (const type of endings) target.removeEventListener(type, end);
      if (!pet.closed) pet.removeEventListener('blur', stop);
      stop();
    };
  }, [api, host, pet]);
  const toggle = () => {
    if (!api?.supported) return false;
    if (active.current) {
      returnToScene(); api.command('return'); return true;
    }
    const child = window.open('about:blank', CALL_PET_WINDOW);
    if (!child) return false;
    try {
      copyCallStyles(child.document);
      child.document.body.append(host);
      active.current = child;
      setSurface(child.document); setPet(child);
      onModeChange?.(true);
      return true;
    } catch {
      moveHome(); api.command('close'); return false;
    }
  };
  return { host, pet: !!pet && surface !== document, surface, supported: !!api?.supported, toggle };
}
