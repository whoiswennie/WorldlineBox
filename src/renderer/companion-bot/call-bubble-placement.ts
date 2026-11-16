type Edges = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

const gap = 12;
const maxWidth = 360;
const maxHeight = 210;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function placeBubble(safe: Edges, head?: Edges) {
  const width = safe.right - safe.left, height = safe.bottom - safe.top;
  const left = head ? clamp(head.left - gap, safe.left, safe.right) - safe.left : 0;
  const right = head ? safe.right - clamp(head.right + gap, safe.left, safe.right) : 0;
  const side = Math.max(left, right);
  if (head && side >= 220 && height >= 70) {
    const w = Math.min(maxWidth, side), h = Math.min(maxHeight, height);
    return { direction: right >= left ? 'left' : 'right', width: w, height: h,
      x: right >= left ? safe.right - right : safe.left + left - w,
      centerY: (head.top + head.bottom) / 2 };
  }
  const above = head ? clamp(head.top - gap, safe.top, safe.bottom) - safe.top : height;
  const below = head ? safe.bottom - clamp(head.bottom + gap, safe.top, safe.bottom) : 0;
  const w = Math.min(maxWidth, width);
  const x = clamp(head ? (head.left + head.right - w) / 2 : safe.left + (width - w) / 2, safe.left, safe.right - w);
  const readableHeight = Math.min(64, height * .4);
  if (above >= readableHeight) {
    return { direction: 'down', width: w, height: Math.min(maxHeight, above), x, bottom: safe.top + above };
  }
  if (below >= readableHeight) {
    return { direction: 'up', width: w, height: Math.min(maxHeight, below), x, top: safe.bottom - below };
  }
  // At close zoom the figure can fill the scene. Keep the bubble near the lower edge, away from the face.
  return { direction: 'none', width: w, height: Math.min(140, height * .55), x,
    top: head ? head.bottom + gap : safe.top };
}

export function observeCallBubble(node: HTMLElement, scene: HTMLElement) {
  const shell = scene.closest('.bot-call-window');
  const dock = shell?.querySelector('.bot-call-dock');
  const header = shell?.querySelector('.bot-call-header');
  const position = () => {
    const frame = scene.getBoundingClientRect();
    if (frame.width < 1 || frame.height < 1) return;
    const padding = Math.min(gap, frame.width / 4, frame.height / 4);
    const top = Math.max(padding, (header?.getBoundingClientRect().bottom ?? frame.top) - frame.top + padding);
    const bottom = Math.max(top, Math.min(frame.bottom, dock?.getBoundingClientRect().top ?? frame.bottom) - frame.top - padding);
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
    const placed = placeBubble({ left: padding, top, right: frame.width - padding, bottom }, head);
    node.dataset.bubbleTail = placed.direction;
    node.style.left = placed.x + 'px';
    node.style.width = placed.width + 'px';
    node.style.maxHeight = placed.height + 'px';
    const height = node.offsetHeight;
    const card = node.querySelector<HTMLElement>('.bot-call-bubble');
    const tailCenter = card ? card.offsetTop + card.offsetHeight / 2 : height / 2;
    node.style.setProperty('--bot-call-tail-center', Math.max(0, tailCenter - 5) + 'px');
    const center = placed.centerY;
    const topAnchor = center === undefined ? placed.top : center - tailCenter;
    node.style.top = topAnchor === undefined ? 'auto' : clamp(topAnchor, top, Math.max(top, bottom - height)) + 'px';
    node.style.bottom = placed.bottom === undefined ? 'auto' : frame.height - placed.bottom + 'px';
  };
  const resize = new ResizeObserver(position);
  for (const target of [node, scene, dock, header]) if (target) resize.observe(target);
  const figures = new MutationObserver(position);
  figures.observe(scene, { subtree: true, attributes: true, attributeFilter: ['data-pet-head'] });
  position();
  return () => { resize.disconnect(); figures.disconnect(); };
}
