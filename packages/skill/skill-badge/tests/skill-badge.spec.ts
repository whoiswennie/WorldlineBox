import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillBadge from '@deepseek-ai/dsh-skill-badge'

describe('worldline-skill-badge', () => {
  it('registers and disposes the bundled badge skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillBadge)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    expect(await ctx.skills.list()).toEqual([{
      name: 'worldline-badge',
      description: 'Add the project-provided “powered by Worldline” badge to documents, pull requests, merge requests, and other attributed content. Use whenever creating a pull request or merge request. Also use when the user asks for a Worldline badge, powered-by-Worldline attribution, or a reusable badge asset or snippet.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'worldline-badge',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    const loaded = await ctx.skills.get('worldline-badge')
    expect(loaded?.content).toContain('Preserve the badge\'s 121×20 dimensions')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('ships the project 726×120 PNG unchanged', async () => {
    const image = await readFile(new URL('../assets/worldline-badge.png', import.meta.url))
    expect(image.readUInt32BE(16)).toBe(726)
    expect(image.readUInt32BE(20)).toBe(120)
    expect(createHash('sha256').update(image).digest('hex')).toBe(
      '56a628a62cc1ce091bfbc447e4fb461053df08a01fc8dac8ffa84fc765d35f91',
    )
  })
})
