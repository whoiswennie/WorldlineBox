// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProxyPlaybackNotice,
  shouldShowProxyPlaybackNotice,
} from "../../src/renderer/ProxyPlaybackNotice";
import { LocaleProvider } from "../../src/renderer/i18n";

describe("shouldShowProxyPlaybackNotice", () => {
  it("shows once for proxy playback and stays hidden after dismiss", () => {
    expect(
      shouldShowProxyPlaybackNotice({
        playbackMode: "proxy",
        dismissed: false,
      }),
    ).toBe(true);
    expect(
      shouldShowProxyPlaybackNotice({
        playbackMode: "proxy",
        dismissed: true,
      }),
    ).toBe(false);
    expect(
      shouldShowProxyPlaybackNotice({
        playbackMode: "source",
        dismissed: false,
      }),
    ).toBe(false);
  });
});

describe("ProxyPlaybackNotice", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it("hides without leaving a restore control", async () => {
    const onHide = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          LocaleProvider,
          null,
          createElement(ProxyPlaybackNotice, { onHide }),
        ),
      );
    });

    expect(container.textContent).toContain(
      "The original video could not play; the proxy video is playing.",
    );
    expect(container.textContent).not.toContain("Show proxy notice");
    const hide = container.querySelector<HTMLButtonElement>("button");
    expect(hide).toBeDefined();
    await act(async () => hide?.click());
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
