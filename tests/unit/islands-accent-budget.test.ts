import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8");

/** Slice from the a27 marker so earlier mute rules cannot confuse assertions. */
const a27 = (() => {
  const idx = css.lastIndexOf("/* ==== a27:");
  expect(idx).toBeGreaterThan(0);
  return css.slice(idx);
})();

function lastAssignment(source: string, prop: string): string | null {
  const re = new RegExp(`${prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;]+);`, "g");
  const matches = [...source.matchAll(re)];
  return matches.at(-1)?.[1]?.trim() ?? null;
}

describe("islands accent budget + Codex transfer tokens (a27/a28)", () => {
  it("ships the bold a28 redesign block", () => {
    expect(css).toMatch(/\/\* ==== a28:/);
  });

  it("defines loud / soft / neutral-on accent budget tokens", () => {
    expect(lastAssignment(a27, "--island-accent-loud")).toBe("var(--ui-action-accent)");
    // a28 demotes soft accent to content secondary (accent almost only loud roles).
    expect(lastAssignment(a27, "--island-accent-soft")).toMatch(
      /var\(--ui-action-accent\)|var\(--island-accent-loud\)|var\(--ui-content-secondary\)/,
    );
    expect(lastAssignment(a27, "--island-pressed-wash")).toMatch(/ui-content-primary|white/);
  });

  it("keeps a72 softened hairlines and a custom-theme border pin", () => {
    const a72Start = a27.indexOf("/* ==== a72:");
    const customStart = a27.indexOf("/* ── a93: custom-theme islands");
    expect(a72Start).toBeGreaterThan(0);
    expect(customStart).toBeGreaterThan(a72Start);
    const design = a27.slice(a72Start, customStart);
    expect(lastAssignment(design, "--island-hairline-w")).toMatch(/^(0\.5|1)px$/);
    expect(lastAssignment(design, "--island-border")).toMatch(/6%/);
    expect(lastAssignment(design, "--island-hairline")).toMatch(/4%/);
    expect(a27.slice(customStart)).toMatch(/--island-border:\s*var\(--ui-island-border\)/);
  });

  it("defines a soft surface mix for chips and secondary plates", () => {
    expect(lastAssignment(a27, "--island-surface-soft")).toMatch(/88%|90%|94%/);
  });

  it("keeps selected card ring on loud accent (not pressed-wash)", () => {
    expect(a27).toMatch(
      /\.asset-card\.is-selected[\s\S]{0,220}border-color:\s*var\(--island-accent-loud\)/,
    );
  });

  it("keeps applied filter segments on loud accent", () => {
    expect(a27).toMatch(/\.dimension-filter-btn\.is-active[\s\S]{0,280}--island-accent-loud/);
  });

  it("routes canvas-controls pressed state through pressed-wash", () => {
    expect(a27).toMatch(/\.canvas-controls \.tool-button\[aria-pressed="true"\]/);
    expect(a27).toMatch(/var\(--island-pressed-wash\)/);
    const pressedIdx = a27.indexOf(
      '.canvas-controls .tool-button[aria-pressed="true"]',
    );
    const washIdx = a27.indexOf("var(--island-pressed-wash)", pressedIdx);
    expect(washIdx).toBeGreaterThan(pressedIdx);
    expect(washIdx - pressedIdx).toBeLessThan(900);
  });

  it("paints islands primary CTAs with content ink, not action accent fill", () => {
    expect(a27).toMatch(
      /\.empty-library \.primary-button,\s*\n\.app-shell\[data-shell-layout="islands"\] \.empty-state \.primary-button/,
    );
    const blockStart = a27.indexOf(".empty-library .primary-button,");
    const block = a27.slice(blockStart, blockStart + 700);
    expect(block).toMatch(/background:\s*var\(--ui-content-primary\)/);
    expect(block).not.toMatch(/background:\s*var\(--ui-action-accent\)/);
  });

  it("still shares one opaque --island-side for sidebar + inspector", () => {
    expect(css).toMatch(/--island-side:\s*var\(--ui-surface-pane\)/);
  });
});
