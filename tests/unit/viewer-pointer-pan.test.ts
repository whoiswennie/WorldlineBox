import { describe, expect, it } from 'vitest';

import { isViewerPanPointerButton } from '../../src/renderer/viewer-pointer-pan';

describe('isViewerPanPointerButton (WorldlineBox-16cd1e)', () => {
  it('accepts left and middle mouse buttons so either can drag the view', () => {
    expect(isViewerPanPointerButton(0)).toBe(true);
    expect(isViewerPanPointerButton(1)).toBe(true);
  });

  it('rejects the right button so the context menu still owns that click', () => {
    expect(isViewerPanPointerButton(2)).toBe(false);
  });

  it('rejects other pointer buttons', () => {
    expect(isViewerPanPointerButton(3)).toBe(false);
    expect(isViewerPanPointerButton(4)).toBe(false);
  });
});
