import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/chat/TurnNavigator.module.css', import.meta.url)),
  'utf8',
)

describe('TurnNavigator viewport placement', () => {
  it('uses the Worldline conversation geometry contract with safe fallbacks', () => {
    expect(css).toContain('var(--worldline-conversation-viewport-height, 100dvh)')
    expect(css).toContain('var(--worldline-composer-height, 152px)')
    expect(css).toContain('var(--worldline-composer-side-clearance, 16px)')
    expect(css).not.toContain('var(--dsh-')
  })
})
