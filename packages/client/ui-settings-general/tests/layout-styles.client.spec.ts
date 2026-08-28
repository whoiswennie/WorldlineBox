/** Settings dialog overflow and responsive-layout stylesheet contracts. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function css(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const shell = css('../src/client/SettingsRoot.module.css')
const action = css('../src/client/SettingsDocumentAction.module.css')
const appFrame = css('../../ui-layout/src/client/AppFrame.module.css')
const selectorRows = [
  css('../../ui-agent-preset/src/client/AgentPresetRow.module.css'),
  css('../../ui-permission-presets/src/client/PermissionRow.module.css'),
  css('../../ui-conversation/src/client/settings/EnterBehaviorRow.module.css'),
]

describe('Settings workspace-page layout styles', () => {
  it('contains horizontal overflow at the scrolling content boundary', () => {
    expect(shell).toMatch(/\.options\s*\{[^}]*min-width:\s*0;/s)
    expect(shell).toMatch(/\.options\s*\{[^}]*overflow-x:\s*hidden;/s)
    expect(shell).toMatch(/\.overlay\s*\{[^}]*top:\s*52px;[^}]*bottom:\s*28px;[^}]*left:\s*60px;/s)
    expect(shell).toMatch(/\.overlay\s*\{[^}]*z-index:\s*20;/s)
    expect(appFrame).toMatch(/\.topbar\s*\{[^}]*z-index:\s*30;/s)
    expect(shell).toMatch(/\.panel\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s)
  })

  it('keeps header actions and selectors from collapsing into single-character columns', () => {
    expect(appFrame).not.toMatch(/\.rail(?:Primary|Bottom) button/)
    expect(appFrame).toMatch(/\.railBottom > button\s*\{/)
    expect(action).toMatch(/\.action\s*\{[^}]*flex:\s*none;/s)
    expect(action).toMatch(/\.action > button\s*\{[^}]*white-space:\s*nowrap;/s)
    for (const row of selectorRows) {
      expect(row).toMatch(/\.selector\s*\{[^}]*flex:\s*none;/s)
      expect(row).toMatch(/\.selector\s*\{[^}]*white-space:\s*nowrap;/s)
    }
  })

  it('stacks setting rows and compacts the navigation on narrow viewports', () => {
    expect(shell).toContain('@media (max-width: 640px)')
    for (const row of selectorRows) {
      expect(row).toContain('@media (max-width: 640px)')
      expect(row).toMatch(/flex-direction:\s*column;/)
    }
  })
})
