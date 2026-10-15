export interface WorldLabelAnchor { id: string; x: number; y: number; width: number; height: number }
export interface WorldLabelPlacement extends WorldLabelAnchor { anchorX: number; anchorY: number }

/** Small deterministic screen-space packing; sizes are supplied by ResizeObserver. */
export function layoutWorldLabels(labels: WorldLabelAnchor[], width: number, height: number): WorldLabelPlacement[] {
  const placed: WorldLabelPlacement[] = [];
  const overlaps = (a: WorldLabelAnchor, b: WorldLabelAnchor) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 8
    && a.y > b.y - b.height - 8 && b.y > a.y - a.height - 8;
  for (const label of [...labels].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))) {
    let best: WorldLabelAnchor | undefined, fallback: WorldLabelAnchor | undefined, bestScore = Infinity;
    for (let row = 0; row < 12 && !best; row++) for (const column of [0, -1, 1, -2, 2, -3, 3]) {
      const x = Math.max(label.width / 2 + 10, Math.min(width - label.width / 2 - 10, label.x + column * (label.width + 12) / 2));
      const y = Math.max(label.height + 10, Math.min(height - 10, label.y - row * (label.height + 12)));
      const candidate = { ...label, x, y }, collisions = placed.filter(item => overlaps(candidate, item)).length;
      const score = collisions * 1_000_000 + Math.abs(x - label.x) + Math.abs(y - label.y) * 1.15;
      if (score < bestScore) { fallback = candidate; bestScore = score; }
      if (!collisions) { best = candidate; break; }
    }
    placed.push({ ...(best ?? fallback ?? label), anchorX: label.x, anchorY: label.y });
  }
  return placed;
}
