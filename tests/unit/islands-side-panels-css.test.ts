import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8");

describe("islands side panels share one surface", () => {
  it("derives --island-side from the theme profile pane token", () => {
    expect(css).toMatch(/--island-side:\s*var\(--ui-surface-pane\)/);
  });

  it("paints sidebar and inspector with the same token, opaque, as the last word", () => {
    const rule =
      /\.app-shell\[data-shell-layout="islands"\] > \.navigation-pane,\s*\.app-shell\[data-shell-layout="islands"\] > \.inspector-pane \{\s*background: var\(--island-side\);\s*backdrop-filter: none;/g;
    const matches = [...css.matchAll(rule)];
    expect(matches.length).toBeGreaterThan(0);
    const last = matches.at(-1)!.index!;
    // No later islands rule may repaint either panel's background.
    const tail = css.slice(last + matches.at(-1)![0].length);
    expect(tail).not.toMatch(/> \.(navigation|inspector)-pane[^{]*\{[^}]*background(-color)?:/);
  });
});
