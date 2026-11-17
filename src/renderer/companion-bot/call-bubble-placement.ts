type Edges = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

const gap = 12;
const maxWidth = 360;
const maxHeight = 210;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

interface BubblePlacement {
  direction: 'left' | 'right' | 'up' | 'down' | 'none';
  width: number;
  height: number;
  x: number;
  centerY?: number;
  top?: number;
  bottom?: number;
}

function placeBubble(safe: Edges, head: Edges | undefined, measure: (width: number) => number): BubblePlacement {
  const width = safe.right - safe.left, height = safe.bottom - safe.top;
  const w = Math.min(maxWidth, width);
  if (!head) return { direction: 'none', width: w, height: Math.min(maxHeight, height), x: safe.left + (width - w) / 2, top: safe.top };
  const left = clamp(head.left - gap, safe.left, safe.right) - safe.left;
  const right = safe.right - clamp(head.right + gap, safe.left, safe.right);
  const side = Math.max(left, right);
  const above = clamp(head.top - gap, safe.top, safe.bottom) - safe.top;
  const below = safe.bottom - clamp(head.bottom + gap, safe.top, safe.bottom);
  const x = clamp((head.left + head.right - w) / 2, safe.left, safe.right - w);
  const candidates: BubblePlacement[] = [];
  if (side >= 220) {
    const sideWidth = Math.min(maxWidth, side);
    candidates.push({ direction: right >= left ? 'left' : 'right', width: sideWidth, height: Math.min(maxHeight, height),
      x: right >= left ? safe.right - right : safe.left + left - sideWidth, centerY: (head.top + head.bottom) / 2 });
  }
  candidates.push(
    { direction: 'down', width: w, height: Math.min(maxHeight, above), x, bottom: safe.top + above },
    { direction: 'up', width: w, height: Math.min(maxHeight, below), x, top: safe.bottom - below },
  );
  const readable = candidates.find(candidate => candidate.height > 0 && candidate.height >= measure(candidate.width));
  if (readable) return readable;
  const roomiest = candidates.reduce((best, candidate) => candidate.height > best.height ? candidate : best);
  if (roomiest.height >= 96) return roomiest;
  // A close-up can fill the frame. In that case keep a readable card near the lower edge.
  return { direction: 'none', width: w, height: Math.min(maxHeight, height), x, top: head.bottom + gap };
}

export function observeCallBubble(node: HTMLElement, scene: HTMLElement) {
  const shell = scene.closest('.bot-call-window');
  const dock = shell?.querySelector('.bot-call-dock');
  const header = shell?.querySelector('.bot-call-header');
  const view = node.ownerDocument.defaultView;
  let frameRequest: number | undefined;
  const position = () => {
    const frame = scene.getBoundingClientRect();
    if (frame.width < 1 || frame.height < 1) return;
    const padding = Math.min(gap, frame.width / 4, frame.height / 4);
    const top = Math.max(padding, (header?.getBoundingClientRect().bottom ?? frame.top) - frame.top + padding);
    const progress = scene.querySelector('.bot-call-pet-progress');
    const bottom = Math.max(top, Math.min(frame.bottom, dock?.getBoundingClientRect().top ?? frame.bottom,
      progress?.getBoundingClientRect().top ?? frame.bottom) - frame.top - padding);
    const live = scene.querySelector<HTMLElement>('.bot-call-live2d');
    const bounds = live?.dataset.petHead?.split(',').map(Number);
    let head: Edges | undefined;
    if (live && bounds?.length === 4 && bounds.every(Number.isFinite)) {
      const [x, y, width, height] = bounds as [number, number, number, number];
      const canvas = live.getBoundingClientRect(), left = canvas.left - frame.left + x, top = canvas.top - frame.top + y;
      head = { left, top, right: left + width, bottom: top + height };
    } else {
      const portrait = scene.querySelector('.bot-call-portrait-frame')?.getBoundingClientRect();
      if (portrait) head = { left: portrait.left - frame.left, top: portrait.top - frame.top,
        right: portrait.right - frame.left, bottom: portrait.bottom - frame.top };
    }
    const card = node.querySelector<HTMLElement>('.bot-call-bubble');
    const caption = card?.querySelector<HTMLElement>('.bot-call-bubble-text');
    const cardScroll = card?.scrollTop ?? 0, captionScroll = caption?.scrollTop ?? 0;
    const measured = new Map<number, number>();
    const placed = placeBubble({ left: padding, top, right: frame.width - padding, bottom }, head, width => {
      const existing = measured.get(width);
      if (existing !== undefined) return existing;
      node.style.width = width + 'px';
      node.style.maxHeight = 'none';
      const height = node.offsetHeight;
      measured.set(width, height);
      return height;
    });
    node.dataset.bubbleTail = placed.direction;
    node.style.left = placed.x + 'px';
    node.style.width = placed.width + 'px';
    node.style.maxHeight = placed.height + 'px';
    const height = node.offsetHeight;
    if (card && cardScroll) card.scrollTop = cardScroll;
    if (caption && captionScroll) caption.scrollTop = captionScroll;
    const tailCenter = card ? card.offsetTop + card.offsetHeight / 2 : height / 2;
    node.style.setProperty('--bot-call-tail-center', Math.max(0, tailCenter - 5) + 'px');
    const center = placed.centerY;
    const topAnchor = center === undefined ? placed.top : center - tailCenter;
    node.style.top = topAnchor === undefined ? 'auto' : clamp(topAnchor, top, Math.max(top, bottom - height)) + 'px';
    node.style.bottom = placed.bottom === undefined ? 'auto' : frame.height - placed.bottom + 'px';
  };
  const schedule = () => {
    if (frameRequest !== undefined || !view) return;
    frameRequest = view.requestAnimationFrame(() => { frameRequest = undefined; position(); });
  };
  const resize = new ResizeObserver(schedule);
  for (const target of [node, scene, dock, header]) if (target) resize.observe(target);
  const figures = new MutationObserver(schedule);
  figures.observe(scene, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-pet-head'] });
  position();
  return () => {
    if (frameRequest !== undefined) view?.cancelAnimationFrame(frameRequest);
    resize.disconnect();
    figures.disconnect();
  };
}
