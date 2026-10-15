import { expect, it } from 'vitest';
import { layoutWorldLabels } from '../../src/renderer/companions/world/world-label-layout';

it('keeps a close group readable without changing physical anchors or depending on input ordering', () => {
  const labels = [0, 1, 2, 3].map(index => ({ id: String(index), x: 420 + index * 22, y: 360 + index * 13, width: 180, height: 50 }));
  const placed = layoutWorldLabels(labels, 1200, 800);
  expect(layoutWorldLabels([...labels].reverse(), 1200, 800)).toEqual(placed);
  for (let index = 0; index < placed.length; index++) {
    const label = placed[index]!, anchor = labels.find(item => item.id === label.id)!;
    expect([label.anchorX, label.anchorY]).toEqual([anchor.x, anchor.y]);
    expect(label.x - label.width / 2).toBeGreaterThanOrEqual(0); expect(label.x + label.width / 2).toBeLessThanOrEqual(1200);
    for (const prior of placed.slice(0, index)) expect(Math.abs(label.x - prior.x) >= (label.width + prior.width) / 2 + 8
      || label.y <= prior.y - prior.height - 8 || prior.y <= label.y - label.height - 8).toBe(true);
  }
});
