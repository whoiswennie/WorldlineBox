import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeConflictError, KnowledgeVault } from '../src/knowledge-vault.ts'

const roots: string[] = []
const vaults: KnowledgeVault[] = []

afterEach(async () => {
  for (const vault of vaults.splice(0)) vault.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; vault: KnowledgeVault }> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-knowledge-'))
  roots.push(root)
  const vault = new KnowledgeVault(root)
  vaults.push(vault)
  await vault.initialize(['companion-one', 'companion-two'])
  return { root, vault }
}

describe('KnowledgeVault', () => {
  it('keeps Markdown authoritative and discloses metadata before full content', async () => {
    const { root, vault } = await fixture()
    const page = await vault.remember('public', '月光协议', '## 规则\n\n所有 Agent 都能读取。', ['共享', '协议'])

    expect(vault.search(['public'], '月光')).toMatchObject([{ scope: 'public', path: page.path }])
    expect(vault.search(['companion-one'], '月光')).toEqual([])
    expect((await vault.read('public', page.path, 'top')).view).toBe('top')
    expect((await vault.read('public', page.path, 'section', '规则')).content).toContain('所有 Agent')
    expect(await readFile(join(root, 'public', page.path), 'utf8')).toContain('# 月光协议')
    expect(vault.tree('public', 'pages')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'directory', name: 'synthesis' }),
    ]))
  })

  it('prevents stale autosaves and supports links, moves, trash, and scope isolation', async () => {
    const { root, vault } = await fixture()
    const target = await vault.create('companion-one', 'pages/concepts', '目标')
    const source = await vault.write('companion-one', 'pages/source.md', [
      '---', 'title: "来源"', 'tags: ["test"]', 'sources: ["user"]', '---', '',
      '# 来源', '', '连接 [[pages/concepts/目标]]。', '',
    ].join('\n'), '')
    expect(vault.backlinks('companion-one', target.path)).toMatchObject([{ path: source.path }])
    await expect(vault.write('companion-one', source.path, '# 冲突\n', 'stale'))
      .rejects.toBeInstanceOf(KnowledgeConflictError)

    const moved = await vault.move('companion-one', source.path, 'pages/source-moved.md', source.revision)
    expect(moved.path).toBe('pages/source-moved.md')
    await vault.trash('companion-one', moved.path, moved.revision)
    await expect(vault.read('companion-one', moved.path, 'full')).rejects.toThrow(/not found/u)
    expect(vault.search(['companion-two'], '目标')).toEqual([])
    expect(await readFile(join(root, 'companions', 'co', 'companion-one', 'AGENTS.md'), 'utf8'))
      .toContain('progressive disclosure')
  })

  it('discovers a compact relevant manifest through exact aliases and lexical FTS without embeddings', async () => {
    const { vault } = await fixture()
    const named = await vault.remember(
      'companion-one',
      '纳西妲角色设定',
      '生日是 10 月 27 日，重要关系是大慈树王。',
      ['纳西妲', '小吉祥草王'],
    )
    await vault.remember('companion-one', '烘焙备忘', '低筋面粉与黄油比例。', ['甜点'])

    expect(vault.discover(['companion-one'], '请介绍一下小吉祥草王，尤其是她的生日。', 3))
      .toMatchObject([{
        path: named.path,
        confidence: 'high',
        reasons: ['exact-tag-alias'],
        matchedTerms: ['小吉祥草王'],
      }])
    expect(vault.discover(['companion-two'], '小吉祥草王的生日', 3)).toEqual([])
    expect(vault.discover(['companion-one'], '帮我查看天气', 3)).toEqual([])
  })
})
