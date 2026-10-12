import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAppIconCandidates } from "../../src/main/app-icon-paths";

describe("resolveAppIconCandidates", () => {
  it("prefers the padded Dock PNG for macOS in development", () => {
    expect(
      resolveAppIconCandidates({
        cwd: "/workspace/WorldlineBox",
        isPackaged: false,
        platform: "darwin",
        resourcesPath: "/unused/resources",
      }),
    ).toEqual([
      path.join("/workspace/WorldlineBox", "assets/icons/app-dock.png"),
      path.join("/workspace/WorldlineBox", "assets/icons/app.png"),
    ]);
  });

  it("prefers the packaged padded Dock PNG on macOS", () => {
    expect(
      resolveAppIconCandidates({
        cwd: "/unused/project",
        isPackaged: true,
        platform: "darwin",
        resourcesPath: "/Applications/WorldlineBox.app/Contents/Resources",
      }),
    ).toEqual([
      path.join("/Applications/WorldlineBox.app/Contents/Resources", "app-dock.png"),
      path.join("/Applications/WorldlineBox.app/Contents/Resources", "app.png"),
    ]);
  });

  it("keeps Windows PNG/ICO fallback ordering", () => {
    expect(
      resolveAppIconCandidates({
        cwd: "/workspace/WorldlineBox",
        isPackaged: true,
        platform: "win32",
        resourcesPath: "C:\\WorldlineBox\\resources",
      }),
    ).toEqual([
      path.join("C:\\WorldlineBox\\resources", "app.png"),
      path.join("C:\\WorldlineBox\\resources", "app.ico"),
    ]);
  });
});
