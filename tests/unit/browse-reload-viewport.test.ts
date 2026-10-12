import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  captureWorkspaceNavViewport,
  resolveWorkspaceScrollTop,
  shouldRestoreViewportAfterBrowseReload,
} from "../../src/renderer/workspace-scroll-position";

/**
 * VIEWER-001 / WorldlineBox-bd481f — session log 2026-09-16:
 * `runSearch` → `executeSearchDefinition` → `finishWorkspaceNavigation(request)`
 * with the omitted-viewport default `{ scrollTop: 0 }` wrote the canvas from
 * 4805 to 0 about one second after opening the viewer.
 *
 * A same-scope silent reload must not run `finishWorkspaceNavigation` at all:
 * the viewer-close path already restored, and a second restore about a second
 * later fights the user's next scroll.
 */
describe("silent browse reload viewport (VIEWER-001)", () => {
  const liveElement = {
    scrollTop: 4922,
    scrollHeight: 5697,
    clientHeight: 775,
  };
  const live = captureWorkspaceNavViewport(liveElement);
  const extentAfterReload = 4805;
  const omittedViewportDefault = {
    scrollTop: 0,
    scrollProgress: 0,
    scrollExtent: 0,
  };

  it("records the live deep offset from the session log", () => {
    expect(live.scrollTop).toBe(4922);
    expect(live.scrollProgress).toBeCloseTo(1, 5);
  });

  it("reproduces the jump when the omitted-viewport default is applied", () => {
    expect(resolveWorkspaceScrollTop(omittedViewportDefault, extentAfterReload)).toBe(
      0,
    );
  });

  it("keeps a deep offset when the reload finishes against the live capture", () => {
    expect(resolveWorkspaceScrollTop(live, extentAfterReload)).toBe(extentAfterReload);
  });

  it("does not restore viewport after a silent same-scope reload", () => {
    expect(shouldRestoreViewportAfterBrowseReload("silent")).toBe(false);
    expect(shouldRestoreViewportAfterBrowseReload("submit")).toBe(true);
  });

  it("wires silent runSearch to skip navigation restore", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/renderer/App.tsx"),
      "utf8",
    );
    const start = source.indexOf("async function runSearch");
    const end = source.indexOf("useEffect(() => {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toMatch(/opts\?\.silent/);
    expect(body).toMatch(/deferReveal:\s*true/);
  });

  it("gates executeSearchDefinition restore behind submit, not silent debounce", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/renderer/App.tsx"),
      "utf8",
    );
    const start = source.indexOf("async function executeSearchDefinition");
    const end = source.indexOf("async function runSearch", start);
    const body = source.slice(start, end);
    expect(body).toMatch(
      /shouldRestoreViewportAfterBrowseReload\(\s*request\.deferReveal \? "silent" : "submit"/,
    );
  });
});
