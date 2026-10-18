import { describe, expect, it } from 'vitest';
import { captureLibraryWindowId } from '../../src/main/browser/capture-routing';

describe('browser capture library owner routing', () => {
  const contexts = new Map([[1, { libraryId: 'a' }], [2, { libraryId: 'b' }], [3, { libraryId: 'b' }], [4, { libraryId: 'closed-window' }]]);
  const liveWindowIds = new Set([1, 2, 3]);
  it('focuses and reveals in the matching library owner even when the browser main window shows another library', () => {
    expect(captureLibraryWindowId({ libraryId: 'b', contexts, liveWindowIds, focusedWindowId: 1, lastTargetWindowId: 3, mainWindowId: 1 })).toBe(3);
    expect(captureLibraryWindowId({ libraryId: 'b', contexts, liveWindowIds, focusedWindowId: 2, lastTargetWindowId: 3, mainWindowId: 1 })).toBe(2);
  });
  it('preserves the existing main-window current-library path', () => {
    expect(captureLibraryWindowId({ libraryId: 'a', contexts, liveWindowIds, focusedWindowId: 2, mainWindowId: 1 })).toBe(1);
  });
  it('does not offer MCP-only libraries or destroyed window contexts as capturable UI targets', () => {
    expect(captureLibraryWindowId({ libraryId: 'mcp-only', contexts, liveWindowIds, mainWindowId: 1 })).toBeNull();
    expect(captureLibraryWindowId({ libraryId: 'closed-window', contexts, liveWindowIds, focusedWindowId: 4 })).toBeNull();
  });
  it('uses another live matching owner when no preferred window owns the library', () => {
    expect(captureLibraryWindowId({ libraryId: 'b', contexts, liveWindowIds, focusedWindowId: 1, mainWindowId: 1 })).toBe(2);
  });
});
