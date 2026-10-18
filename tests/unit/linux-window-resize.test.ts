import { describe, expect, it, vi } from "vitest";

import { applyWindowBoundsFromEdgeDelta } from "../../src/main/linux-window-resize";
import {
  parseWindowEdgeResizeRequest,
  parseWindowResizeEdge,
  parseWindowSetBoundsRequest,
} from "../../src/shared/window-edge-resize";

describe("window-edge-resize shared parsers", () => {
  it("accepts edges and rejects junk", () => {
    expect(parseWindowResizeEdge("se")).toBe("se");
    expect(parseWindowResizeEdge("xx")).toBeNull();
    expect(parseWindowEdgeResizeRequest({ edge: "e" })).toEqual({ edge: "e" });
    expect(parseWindowEdgeResizeRequest({ edge: "nope" })).toBeNull();
  });

  it("parses setBounds fallback payloads", () => {
    const parsed = parseWindowSetBoundsRequest({
      edge: "se",
      startBounds: { x: 10, y: 20, width: 1200, height: 800 },
      dx: 40,
      dy: 30,
    });
    expect(parsed?.edge).toBe("se");
    expect(parsed?.dx).toBe(40);
  });
});

describe("applyWindowBoundsFromEdgeDelta", () => {
  it("grows from the south-east corner", () => {
    const setBounds = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getMinimumSize: () => [1040, 680],
      setBounds,
    };
    const result = applyWindowBoundsFromEdgeDelta({
      window: window as never,
      edge: "se",
      startBounds: { x: 100, y: 50, width: 1200, height: 800 },
      dx: 40,
      dy: 20,
    });
    expect(result).toEqual({ ok: true });
    expect(setBounds).toHaveBeenCalledWith({
      x: 100,
      y: 50,
      width: 1240,
      height: 820,
    });
  });

  it("moves origin when resizing from the north-west", () => {
    const setBounds = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getMinimumSize: () => [1040, 680],
      setBounds,
    };
    applyWindowBoundsFromEdgeDelta({
      window: window as never,
      edge: "nw",
      startBounds: { x: 100, y: 50, width: 1200, height: 800 },
      dx: -30,
      dy: -20,
    });
    expect(setBounds).toHaveBeenCalledWith({
      x: 70,
      y: 30,
      width: 1230,
      height: 820,
    });
  });

  it("clamps to minimum size", () => {
    const setBounds = vi.fn();
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getMinimumSize: () => [1040, 680],
      setBounds,
    };
    applyWindowBoundsFromEdgeDelta({
      window: window as never,
      edge: "se",
      startBounds: { x: 0, y: 0, width: 1100, height: 700 },
      dx: -200,
      dy: -100,
    });
    expect(setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 1040,
      height: 680,
    });
  });
});
