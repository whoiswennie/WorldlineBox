import { Context } from '@deepseek-ai/cordis'
import LocalAgentVaultService from '@deepseek-ai/dsh-agent-vault-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditVault, vaultBacklinks } from '../src/index.ts'

const roots: string[] = []
const services: LocalAgentVaultService[] = []
const user = { actor: { type: 'user' as const, id: 'audit-user' }, reason: 'audit fixture' }

afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Agent Vault Wiki health adapter', () => {
  it('resolves backlinks and reports broken links, orphans, and missing provenance', async () => {
    const home = await mkdtemp(join(tmpdir(), 'worldline-vault-audit-'))
    roots.push(home)
    const vault = new LocalAgentVaultService(new Context(), { worldlineHome: home })
    services.push(vault)
    await vault.createAgent('audited', '审计伙伴')
    const page = (title: string, sources: readonly string[], body: string): string => [
      '---', `title: ${JSON.stringify(title)}`, 'tags: []', `summary: ${JSON.stringify(title)}`,
      `sources: ${JSON.stringify(sources)}`, '---', '', `# ${title}`, '', body, '',
    ].join('\n')
    await vault.write('audited', 'vault://memory/long/target.md', page('目标', ['user://conversation/1'], '可靠知识。'), user)
    await vault.write('audited', 'vault://memory/long/source.md', page('来源页', [], '参见 [[memory/long/target]] 和 [[missing/page]]。'), user)
    await vault.write('audited', 'vault://procedures/cards/orphan.md', page('孤立能力', ['test://case/1'], '尚未建立链接。'), user)

    expect(await vaultBacklinks(vault, 'audited', 'memory/long/target.md'))
      .toEqual([expect.objectContaining({ path: 'memory/long/source.md', title: '来源页' })])
    const audit = await auditVault(vault, 'audited')
    expect(audit.brokenLinks).toContainEqual({ source: 'memory/long/source.md', target: 'missing/page' })
    expect(audit.missingSources).toContain('memory/long/source.md')
    expect(audit.orphaned).toContain('procedures/cards/orphan')
  })
})
