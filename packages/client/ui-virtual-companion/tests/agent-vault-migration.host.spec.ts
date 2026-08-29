import { Context } from '@deepseek-ai/cordis'
import LocalAgentVaultService from '@deepseek-ai/dsh-agent-vault-local'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyCompanions } from '../src/agent-vault-migration.ts'
import type { VirtualCompanion } from '../src/contracts.ts'
import { ReferenceVault } from '../src/reference-vault.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const companion = (now = Date.now()): VirtualCompanion => ({
  id: 'test-companion', name: '测试伙伴', handle: 'TEST · 伙伴', avatar: '/avatar.png',
  portrait: '/portrait.png', status: '正在学习', description: '迁移资料', persona: '核心身份',
  style: '温和谨慎', speakingStyle: '简洁', behaviorLogic: '先验证再回答', builtIn: false,
  createdAt: now, updatedAt: now,
})

describe('legacy Agent Vault migration', () => {
  it('backs up exact sources and idempotently preserves documents, resource ids, bytes, and self', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-vault-migration-')); roots.push(root)
    const legacy = join(root, 'companions'); const home = join(root, 'next'); const backup = join(root, 'backups')
    const privateRoot = join(legacy, 'knowledge-vaults', 'companions', 'te', 'test-companion', 'pages')
    const publicRoot = join(legacy, 'knowledge-vaults', 'public', 'pages')
    await Promise.all([mkdir(privateRoot, { recursive: true }), mkdir(publicRoot, { recursive: true })])
    await writeFile(join(legacy, 'directory.json'), '{"version":5}\n')
    await writeFile(join(privateRoot, 'memory.md'), '# 共同回忆\n\n第一次见面。\n')
    await writeFile(join(publicRoot, 'guide.md'), '# 公共指南\n')
    const references = new ReferenceVault(join(legacy, 'reference-vault')); await references.initialize()
    await references.seed({ id: 'builtin-expression-1', scope: 'test-companion', enabled: true,
      title: '打招呼', description: '开心打招呼', tags: ['表情包', '问候'], transcript: '',
      mimeType: 'image/gif', bytes: 0, source: { type: 'builtin', url: '/meme.gif' }, builtIn: true,
      usageCount: 7, createdAt: 1, updatedAt: 2 })
    const uploaded = await references.createUpload({ scope: 'test-companion', title: '自定义',
      description: '用户资源', tags: ['自定义'], mimeType: 'image/png', asset: '' },
    new Uint8Array([1, 2, 3, 4]), 'image/png')
    references.close()
    const ctx = new Context(); const vaults = new LocalAgentVaultService(ctx, { worldlineHome: home })
    try {
      const first = await migrateLegacyCompanions({ legacyRoot: legacy, backupRoot: backup,
        profiles: [companion()], vaults })
      expect(first?.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'public', documents: 1 }),
        expect.objectContaining({ id: 'test-companion', documents: 1, resources: 2 }),
      ]))
      expect(await vaults.read('test-companion', 'vault://memory/long/legacy/pages/memory.md', 'full'))
        .toMatchObject({ title: '共同回忆' })
      expect((await vaults.read('test-companion', 'vault://memory/long/migrations/legacy-v1.md', 'full')).content)
        .not.toContain(root.replaceAll('\\', '/'))
      expect((await vaults.inspectSelf('test-companion')).compiled).toContain('温和谨慎')
      expect((await vaults.resource('test-companion', 'builtin-expression-1')).usageCount).toBe(7)
      const content = await vaults.resourceContent('test-companion', uploaded.id)
      expect(content.type).toBe('file')
      if (content.type === 'file') expect([...await readFile(content.path)]).toEqual([1, 2, 3, 4])
      expect(await migrateLegacyCompanions({ legacyRoot: legacy, backupRoot: backup,
        profiles: [companion()], vaults })).toBeUndefined()
      expect(first?.sourceFiles).toBeGreaterThan(3)
      expect(first?.sourceSha256).toMatch(/^[a-f\d]{64}$/u)
    } finally { vaults.close() }
  })
})
