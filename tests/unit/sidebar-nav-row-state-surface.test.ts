import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../../src/renderer/styles.css"), "utf8");

function lastIndex(pattern: RegExp): number {
  const matches = [...css.matchAll(pattern)];
  expect(matches.length, `missing CSS rule: ${pattern}`).toBeGreaterThan(0);
  return matches.at(-1)!.index!;
}

// 用户反馈（2026-10-17）：侧栏里「选中」与「悬停」的高亮都比「当前浏览文件夹」短
// 一条，一个文件夹既被选中又在浏览时看不出选中，且选中态不要描边。
// 根因是状态底色画在不同元素上：.is-active 画在行容器 .nav-tree-row（含展开箭头
// 列），多选/悬停画在内层按钮 .nav-row（被箭头列 + 层级缩进往里推）。
// 文件夹与合集行共用同一个 NavRow，因此这里锁住的是整条侧栏的约定：
// 同一条行只有一条高亮矩形，且按钮不自己画底色。
describe("sidebar nav row states share one highlight rectangle", () => {
  it("defines the selected wash once on the pane so row and tree-row agree", () => {
    expect(css).toMatch(/\.navigation-pane \{\s*--nav-selected-wash:[^;]+;\s*\}/);
    expect(css).toMatch(
      /\.nav-row\.is-multi-selected \{\s*background: var\(--nav-selected-wash\);\s*color: var\(--text\);\s*\}/,
    );
  });

  it("paints the selection with a background only, without an outline", () => {
    const base = /\.nav-row\.is-multi-selected \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(base).not.toMatch(/box-shadow/);
    const islands =
      /\.app-shell\[data-shell-layout="islands"\] \.nav-tree-row:has\(> \.nav-row\.is-multi-selected\) \{[^}]*\}/
        .exec(css)?.[0] ?? "";
    expect(islands).toMatch(/background: var\(--nav-selected-wash\);/);
    expect(islands).not.toMatch(/box-shadow/);
  });

  it("paints hover on the tree row instead of the inner button", () => {
    expect(css).toMatch(
      /\.app-shell\[data-shell-layout="islands"\] \.nav-tree-row:has\(> \.nav-row:hover:not\(:disabled\):not\(\.is-active\):not\(\.is-multi-selected\):not\(\.is-drop-target\)\) \{\s*background: color-mix\(/,
    );
  });

  it("keeps the asset drop target on the same rectangle", () => {
    expect(css).toMatch(
      /\.app-shell\[data-shell-layout="islands"\] \.nav-tree-row:has\(> \.nav-row\.is-drop-target\) \{\s*background: color-mix\(/,
    );
  });

  it("leaves the inner button unpainted so no second narrower highlight shows", () => {
    expect(css).toMatch(
      /\.app-shell\[data-shell-layout="islands"\] \.nav-tree-row > \.nav-row:hover:not\(:disabled\)[^{]*\{\s*background: transparent;\s*box-shadow: none;\s*\}/,
    );
    for (const state of ["is-active", "is-multi-selected", "is-drop-target"]) {
      expect(css).toMatch(
        new RegExp(
          String.raw`\.app-shell\[data-shell-layout="islands"\] \.nav-tree-row > \.nav-row\.${state}[^{]*\{\s*background: transparent;`,
        ),
      );
    }
  });

  it("lets a row that is both browsed and selected keep the selected treatment", () => {
    // 选中态规则必须排在「当前浏览」的 tree-row 底色之后，否则中性 wash 会把它盖掉。
    const activeIndex = lastIndex(
      /\.app-shell\[data-shell-layout="islands"\] \.nav-row\.is-active,\s*\.app-shell\[data-shell-layout="islands"\] \.nav-row\[aria-current="page"\],\s*\.app-shell\[data-shell-layout="islands"\] \.nav-tree-row:has\(> \.nav-row\.is-active\) \{\s*background: var\(--island-select\);/g,
    );
    const selectedIndex = lastIndex(
      /\.app-shell\[data-shell-layout="islands"\] \.nav-tree-row:has\(> \.nav-row\.is-multi-selected\) \{\s*background: var\(--nav-selected-wash\);/g,
    );
    expect(selectedIndex).toBeGreaterThan(activeIndex);
  });
});
