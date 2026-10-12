// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../../src/renderer/i18n";
import { ZoomableImage } from "../../src/renderer/zoomable-preview-image";

function viewerLayer(container: HTMLElement): string | null {
  return (
    container
      .querySelector(".preview-image-viewport")
      ?.getAttribute("data-viewer-layer") ?? null
  );
}

function markImageDecoded(image: HTMLImageElement): void {
  Object.defineProperty(image, "complete", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(image, "naturalWidth", {
    configurable: true,
    get: () => 64,
  });
  Object.defineProperty(image, "naturalHeight", {
    configurable: true,
    get: () => 64,
  });
  image.decode = () => Promise.resolve();
}

describe("ZoomableImage cached load vs decode token", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let restoreImage: (() => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const proto = HTMLImageElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
    const originalSetAttribute = proto.setAttribute;
    const fireCachedLoad = (image: HTMLImageElement) => {
      markImageDecoded(image);
      image.dispatchEvent(new Event("load"));
    };
    if (descriptor?.set && descriptor.get) {
      const originalSet = descriptor.set;
      const originalGet = descriptor.get;
      Object.defineProperty(proto, "src", {
        configurable: true,
        get() {
          return originalGet.call(this);
        },
        set(value: string) {
          originalSet.call(this, value);
          fireCachedLoad(this);
        },
      });
    }
    proto.setAttribute = function setAttribute(name: string, value: string) {
      originalSetAttribute.call(this, name, value);
      if (name === "src") {
        fireCachedLoad(this);
      }
    };
    restoreImage = () => {
      if (descriptor) {
        Object.defineProperty(proto, "src", descriptor);
      }
      proto.setAttribute = originalSetAttribute;
    };
  });

  afterEach(() => {
    restoreImage?.();
    restoreImage = undefined;
    root?.unmount();
    root = undefined;
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
  });

  async function renderImage(src: string, placeholderSrc: string): Promise<void> {
    if (!container) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        createElement(LocaleProvider, {
          initialPreference: "zh-CN",
          children: createElement(ZoomableImage, {
            src,
            alt: "asset",
            placeholderSrc,
          }),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("promotes a cache-hit original after switching back to the same image", async () => {
    await renderImage("worldlinebox://source/a", "worldlinebox://preview/a");
    expect(viewerLayer(container!)).toBe("full");

    await renderImage("worldlinebox://source/b", "worldlinebox://preview/b");
    expect(viewerLayer(container!)).toBe("full");

    await renderImage("worldlinebox://source/a", "worldlinebox://preview/a");
    expect(viewerLayer(container!)).toBe("full");
  });
});
