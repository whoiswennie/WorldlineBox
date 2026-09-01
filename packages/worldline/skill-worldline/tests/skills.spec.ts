import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { apply, WORLDLINE_SKILL_CANDIDATES, WORLDLINE_SKILLS } from '../src/index.ts'

describe('Worldline bundled skills', () => {
  it('publishes exactly the seven current workflows and loads every body', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    apply(ctx)
    const listed = await ctx.skills.list()
    expect(listed.map(item => item.name)).toEqual(WORLDLINE_SKILLS.map(item => item[0]).sort())
    expect(WORLDLINE_SKILL_CANDIDATES).toHaveLength(7)
    for (const [name] of WORLDLINE_SKILLS) {
      const skill = await ctx.skills.get(name)
      expect(skill?.content).toContain('## 权限边界')
      expect(skill?.content).toContain('## 工作步骤')
    }
  })

  it('lets a project-ranked provider replace a bundled name without compatibility branches', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    apply(ctx)
    ctx.skills.registerProvider(() => ({
      name: 'project-test',
      list: async () => [{
        ...WORLDLINE_SKILL_CANDIDATES[0],
        description: 'Project-specific authoring workflow.',
        source: 'project-worldline',
        provider: 'project-test',
        rank: 100,
        locator: 'project',
      }],
      get: async candidate => ({ ...candidate, content: 'Project workflow.' }),
    }))
    expect((await ctx.skills.get('worldline-authoring'))?.content).toBe('Project workflow.')
  })
})
