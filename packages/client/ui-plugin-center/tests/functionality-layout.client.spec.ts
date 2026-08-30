import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('FunctionalityPage responsive collection layout', () => {
  it('uses three columns on wide screens, two on medium screens and one on compact screens', () => {
    const stylesheet = readFileSync(fileURLToPath(new URL(
      '../src/client/FunctionalityPage.module.css', import.meta.url,
    )), 'utf8')

    expect(stylesheet).toMatch(/\.grid\s*\{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u)
    expect(stylesheet).toMatch(/@media \(max-width: 1120px\)[\s\S]*?\.grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u)
    expect(stylesheet).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.grid \{\s*grid-template-columns: 1fr/u)
  })
})
