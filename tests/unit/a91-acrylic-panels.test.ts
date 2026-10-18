import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/renderer/styles.css', 'utf8');

describe('a91 acrylic menus + wallpaper panels', () => {
  it('gives every menu surface (incl. the main menu) a translucent blurred fill per acrylic level', () => {
    for (const level of ['1', '2', '3']) {
      const rule = new RegExp(`:root\\[data-menu-acrylic="${level}"\\] :is\\(\\.ui-menu-surface, \\.context-menu, \\.main-menu-surface[^{]*\\{[^}]*backdrop-filter: blur\\(`);
      expect(css).toMatch(rule);
    }
  });

  it('tints all three islands with the panel opacity when the wallpaper option is on', () => {
    expect(css).toMatch(/:root\[data-bg-main-panel="on"\] \.app-shell\[data-shell-layout="islands"\] > :is\(\.navigation-pane, \.workspace, \.inspector-pane\) \{[^}]*var\(--ui-panel-opacity/);
  });
});

describe('a92 settings live preview', () => {
  it('disables scroll anchoring in settings content (slider drag jump)', () => {
    expect(css).toMatch(/\.app-settings-content,\s*\.app-settings-content \* \{\s*overflow-anchor: none;/);
  });

  it('fades the backdrop only while adjusting (a93)', () => {
    expect(css).toMatch(/\.dialog-backdrop\.app-settings-backdrop\.is-adjusting[^{]*\{[^}]*background-color: transparent;[^}]*transition-duration: 360ms;/);
    expect(css).not.toMatch(/is-live-preview/);
  });

});
