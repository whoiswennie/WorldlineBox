import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/AuthOverlay.module.css', import.meta.url)),
  'utf8',
)

describe('AuthOverlay.module.css isolation', () => {
  it('does not leak the authentication SVG reset into the application shell', () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
      .flatMap(([, group = '']) => group.split(','))
      .map(selector => selector.trim())

    expect(selectors).not.toContain('svg')
    expect(selectors).not.toContain('form > label')
    expect(selectors).toContain('.overlay svg')
    expect(selectors).toContain('.overlay form > label')
  })
})
