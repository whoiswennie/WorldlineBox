import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(
  new URL('../src/client/AccountSettings.module.css', import.meta.url),
), 'utf8')

describe('account settings feedback layout', () => {
  it('floats save and error feedback without moving the profile card', () => {
    const feedback = /\.notice,\s*\.error\s*\{([^}]*)\}/s.exec(css)?.[1] ?? ''
    expect(feedback).toContain('position: fixed')
    expect(feedback).toContain('bottom: 52px')
    expect(feedback).toContain('margin: 0')
  })
})
