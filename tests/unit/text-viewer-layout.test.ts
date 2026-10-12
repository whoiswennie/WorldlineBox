import { describe, expect, it } from "vitest";

import { applyTextViewerTextareaLayout } from "../../src/renderer/text-viewer-layout";

function box(init?: {
  scrollHeight?: number;
  scrollWidth?: number;
  clientWidth?: number;
  width?: string;
}) {
  return {
    style: { height: "", width: init?.width ?? "400px" },
    scrollHeight: init?.scrollHeight ?? 80,
    scrollWidth: init?.scrollWidth ?? 900,
    parentElement: { clientWidth: init?.clientWidth ?? 320 },
  };
}

describe("applyTextViewerTextareaLayout", () => {
  it("clears inline width first when wrapping so height is measured at stage width", () => {
    const target = box({ width: "900px", scrollHeight: 240 });
    applyTextViewerTextareaLayout(target, true);
    expect(target.style.width).toBe("");
    expect(target.style.height).toBe("240px");
  });

  it("grows to the longest line when wrap is off", () => {
    const target = box({ scrollWidth: 900, clientWidth: 320, scrollHeight: 48 });
    applyTextViewerTextareaLayout(target, false);
    expect(target.style.width).toBe("900px");
    expect(target.style.height).toBe("48px");
  });
});
