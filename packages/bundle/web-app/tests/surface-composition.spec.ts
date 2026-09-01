import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(resolve(
  process.cwd(),
  'packages/bundle/web-app/cordis.patch.yml',
), 'utf8')

function pluginBlock(id: string): string {
  const start = patch.indexOf(`    - id: ${id}\n`)
  if (start < 0) throw new Error(`missing shipped client plugin: ${id}`)
  const next = patch.indexOf('\n    - id: ', start + 1)
  return patch.slice(start, next < 0 ? undefined : next)
}

describe('shipped primary product surfaces', () => {
  it('keeps knowledge, virtual companion, and Worldline enabled in the formal web composition', () => {
    const companion = pluginBlock('ui-virtual-companion')
    const worldline = pluginBlock('ui-worldline')

    expect(companion).toContain("name: '@deepseek-ai/dsh-client-ui-virtual-companion'")
    expect(worldline).toContain("name: '@deepseek-ai/dsh-client-ui-worldline'")
    expect(companion).not.toContain('disabled: true')
    expect(worldline).not.toContain('disabled: true')
    expect(patch.indexOf('    - id: ui-virtual-companion\n'))
      .toBeLessThan(patch.indexOf('    - id: ui-worldline\n'))
  })
})
