import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import {
  isX11CompositorRunning,
  linuxRoundedCornersCss,
  shouldUseLinuxRoundedCorners,
} from "../../src/main/linux-window-corners";

describe("linux rounded window corners", () => {
  it("is Linux-only", () => {
    expect(shouldUseLinuxRoundedCorners("darwin", {}, () => true)).toBe(false);
    expect(shouldUseLinuxRoundedCorners("win32", {}, () => true)).toBe(false);
  });

  it("follows the compositor probe and falls back to square corners", () => {
    expect(shouldUseLinuxRoundedCorners("linux", { DISPLAY: ":0" }, () => true)).toBe(true);
    expect(shouldUseLinuxRoundedCorners("linux", { DISPLAY: ":0" }, () => false)).toBe(false);
  });

  it("honours the env override and native Wayland", () => {
    expect(shouldUseLinuxRoundedCorners("linux", { WORLDLINEBOX_LINUX_ROUNDED_CORNERS: "0" }, () => true)).toBe(false);
    expect(shouldUseLinuxRoundedCorners("linux", { WORLDLINEBOX_LINUX_ROUNDED_CORNERS: "1" }, () => false)).toBe(true);
    expect(
      shouldUseLinuxRoundedCorners("linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, () => false),
    ).toBe(true);
  });

  it("detects a compositor through the _NET_WM_CM selection owner", () => {
    const api = (owner: number) => ({
      XOpenDisplay: () => ({}),
      XDefaultScreen: () => 0,
      XInternAtom: () => 42,
      XGetSelectionOwner: () => owner,
      XCloseDisplay: () => 0,
    });
    expect(isX11CompositorRunning(api(123))).toBe(true);
    expect(isX11CompositorRunning(api(0))).toBe(false);
    expect(isX11CompositorRunning({ ...api(1), XOpenDisplay: () => null })).toBe(false);
  });

  it("emits rounded clip CSS with a square escape hatch", () => {
    const css = linuxRoundedCornersCss(8);
    expect(css).toContain("round 8px");
    expect(css).toContain("worldlinebox-window-square");
  });
});
