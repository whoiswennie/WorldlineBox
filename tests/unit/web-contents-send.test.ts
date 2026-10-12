import { describe, expect, it, vi } from "vitest";

import { sendToLiveWebContents } from "../../src/main/web-contents-send";

describe("sendToLiveWebContents", () => {
  it("does not send after the contents are destroyed", () => {
    const send = vi.fn();
    expect(sendToLiveWebContents(
      { isDestroyed: () => true, send },
      "shell.window.focus",
      { focused: true },
    )).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a disposed render-frame send instead of throwing", () => {
    const send = vi.fn(() => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    });
    expect(sendToLiveWebContents(
      { isDestroyed: () => false, send },
      "shell.window.focus",
      { focused: false },
    )).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends when the frame is still live", () => {
    const send = vi.fn();
    expect(sendToLiveWebContents(
      { isDestroyed: () => false, send },
      "shell.window.focus",
      { focused: true },
    )).toBe(true);
    expect(send).toHaveBeenCalledWith("shell.window.focus", { focused: true });
  });
});
