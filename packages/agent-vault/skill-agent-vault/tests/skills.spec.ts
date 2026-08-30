import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import * as AgentVaultSkills from '../src/index.ts'

describe('Agent Vault methodology skills', () => {
  it('discovers nine small routers and progressively loads distinct complete workflows', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentVaultSkills)
    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => skill.name)).toEqual([
      'agent-vault-orientation', 'capability-learning', 'companion-creation', 'memory-capture', 'memory-consolidation',
      'memory-governance', 'memory-recall', 'resource-expression', 'self-development',
    ])
    const consolidation = await ctx.skills.get('memory-consolidation')
    expect(consolidation?.content).toContain('checkpoint')
    expect(consolidation?.content).toContain('Never load the whole backlog')
    const self = await ctx.skills.get('self-development')
    expect(self?.content).toContain('One argument cannot rewrite core identity')
    const creation = await ctx.skills.get('companion-creation')
    expect(creation?.content).toContain('create_virtual_companion')
    expect(creation?.content).toContain('independent, portable Agent Vault')
  })
})
