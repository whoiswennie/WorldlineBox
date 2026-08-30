import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentVaultError } from '@deepseek-ai/dsh-agent-vault'
import LocalAgentVaultService from '../src/index.ts'

const roots: string[] = []
const services: LocalAgentVaultService[] = []

const user = (revision?: string) => ({
  actor: { type: 'user' as const, id: 'user-1' }, reason: 'test edit',
  ...(revision === undefined ? {} : { expectedRevision: revision }),
})
const agent = { actor: { type: 'agent' as const, id: 'test-agent' }, reason: 'remember user request' }

async function service(): Promise<{ vault: LocalAgentVaultService; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'worldline-agent-vault-'))
  roots.push(home)
  const vault = new LocalAgentVaultService(new Context(), { worldlineHome: home })
  services.push(vault)
  return { vault, home }
}

afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local Agent Vault', () => {
  it('creates one portable Vault and keeps ordinary recall outside self', async () => {
    const { vault } = await service()
    await vault.createAgent('yachiyo-runami', '月见八千代')
    const self = await vault.inspectSelf('yachiyo-runami')
    expect(self.modules.map(module => module.id)).toContain('appearance')
    expect(self.compiled).toContain('月见八千代')
    expect((await vault.read('yachiyo-runami', 'vault://memory/long/index.md')).content)
      .toContain('此目录由该伙伴的 Agent Vault 独立管理')
    expect((await vault.read('yachiyo-runami', 'vault://procedures/cards/index.md')).content)
      .toContain('仅在真实执行测试通过后')

    await vault.captureMemory({ agentId: 'yachiyo-runami', title: '最喜欢的歌',
      content: '八千代最喜欢《朧月夜》的天幻翻唱版。', tags: ['音乐', '朧月夜'], aliases: ['喜欢的歌曲'] }, agent)
    const recalled = await vault.recall({ agentId: 'yachiyo-runami', domain: 'memory', query: '八千代喜欢的歌 朧月夜' })
    expect(recalled.cards[0]).toMatchObject({ title: '最喜欢的歌', domain: 'memory' })
    expect(recalled.cards.every(card => card.domain === 'memory')).toBe(true)
    expect(recalled.elapsedMs).toBeLessThan(200)
  })

  it('enforces self proposal mode, user locks, freezes, and revisions at commit time', async () => {
    const { vault } = await service()
    await vault.createAgent('guarded', '受保护伙伴')
    const persona = (await vault.inspectSelf('guarded')).modules.find(module => module.id === 'persona')!
    await expect(vault.updateSelf('guarded', { ...persona, summary: '被 Agent 擅自修改' }, agent))
      .rejects.toMatchObject({ code: 'DOMAIN_READONLY' })
    const emotion = (await vault.inspectSelf('guarded')).modules.find(module => module.id === 'emotion')!
    expect((await vault.updateSelf('guarded', { ...emotion, summary: '有一点开心' }, agent)).summary)
      .toBe('有一点开心')
    const interests = (await vault.inspectSelf('guarded')).modules.find(module => module.id === 'interests')!
    await expect(vault.updateSelf('guarded', { ...interests, summary: '突然完全改变兴趣' }, agent))
      .rejects.toMatchObject({ code: 'DOMAIN_READONLY' })
    const updated = await vault.updateSelf('guarded', { ...persona, summary: '温和而谨慎', locked: true }, user(persona.revision))
    expect(updated.summary).toBe('温和而谨慎')

    const policy = await vault.policy('guarded')
    await vault.setPolicy('guarded', { ...policy, fullyFrozen: true }, user())
    await expect(vault.captureMemory({ agentId: 'guarded', title: '冻结后', content: '不应写入' }, agent))
      .rejects.toMatchObject({ code: 'VAULT_READONLY' })
    await vault.setPolicy('guarded', { ...policy, fullyFrozen: false }, user())
    const document = await vault.captureMemory({ agentId: 'guarded', title: '可写', content: '恢复写入' }, agent)
    await expect(vault.write('guarded', document.uri, `${document.content}\n冲突`, user('stale')))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  })

  it('rejects path escapes and cross-domain moves', async () => {
    const { vault } = await service()
    await vault.createAgent('paths', '路径测试')
    await expect(vault.read('paths', 'vault://memory/../self/identity.md'))
      .rejects.toMatchObject({ code: 'INVALID_URI' })
    const memory = await vault.captureMemory({ agentId: 'paths', title: '一条记忆', content: '内容' }, agent)
    await expect(vault.move('paths', memory.uri, 'vault://self/stolen.md', user(memory.revision)))
      .rejects.toMatchObject({ code: 'DOMAIN_VIOLATION' })
  })

  it('creates, copies, and moves document directories as portable Vault entries', async () => {
    const { vault } = await service()
    await vault.createAgent('file-manager', '文件管理器')
    const folder = await vault.createDirectory(
      'file-manager', 'vault://memory/long/projects', user(),
    )
    expect(folder).toMatchObject({ kind: 'directory', name: 'projects' })
    const document = await vault.write('file-manager', 'vault://memory/long/projects/plan.md',
      '# 计划\n', user())
    await vault.copy('file-manager', 'vault://memory/long/projects',
      'vault://memory/long/projects-copy', user())
    expect((await vault.read('file-manager', 'vault://memory/long/projects-copy/plan.md')).content)
      .toBe('# 计划\n')
    const moved = await vault.move('file-manager', 'vault://memory/long/projects-copy',
      'vault://memory/long/archive', user())
    expect(moved).toMatchObject({ kind: 'directory', name: 'archive' })
    await expect(vault.read('file-manager', 'vault://memory/long/projects-copy/plan.md'))
      .rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' })
    await expect(vault.copy('file-manager', document.uri,
      'vault://procedures/cards/plan.md', user(document.revision)))
      .rejects.toMatchObject({ code: 'DOMAIN_VIOLATION' })
  })

  it('indexes direct user editor writes through the filesystem watcher', async () => {
    const { vault, home } = await service()
    await vault.createAgent('editor', '编辑器伙伴')
    const file = join(home, 'agents', 'v1', 'ed', 'editor', 'memory', 'long', 'manual.md')
    await writeFile(file, '---\ntitle: "人工编辑知识"\ntags: ["用户编辑"]\nsummary: "保存后应同步索引"\n---\n\n# 人工编辑知识\n\n编辑器直接保存。\n', 'utf8')
    await expect.poll(async () => (await vault.recall({ agentId: 'editor', domain: 'memory', query: '人工编辑知识' })).cards.length,
      { timeout: 3_000, interval: 50 }).toBe(1)
  })

  it('projects self Markdown body edits directly and emits a live filesystem change', async () => {
    const { vault, home } = await service()
    await vault.createAgent('live-card', '实时伙伴')
    const changes: Array<{ agentId: string; paths: readonly string[] }> = []
    const release = vault.subscribeChanges((change) => { changes.push(change) })
    const file = join(home, 'agents', 'v1', 'li', 'live-card', 'self', 'appearance.md')
    await writeFile(file, [
      '---', 'id: "appearance"', 'title: "旧形象标题"', 'enabled: true',
      'autonomous: false', 'locked: true', 'stability: core',
      'summary: "旧 frontmatter 摘要"', 'details: ["旧 frontmatter 详情"]', '---', '',
      '# 实时形象', '', '正文中的最新形象摘要。', '', '- 正文中的最新形象详情', '',
    ].join('\n'), 'utf8')

    await expect.poll(() => changes.some(change => change.agentId === 'live-card'
      && change.paths.includes('self/appearance.md')), { timeout: 3_000, interval: 25 }).toBe(true)
    const appearance = (await vault.inspectSelf('live-card')).modules.find(module => module.id === 'appearance')
    expect(appearance).toMatchObject({
      title: '实时形象', summary: '正文中的最新形象摘要。', details: ['正文中的最新形象详情'],
    })
    release()
  })

  it('keeps unindented legacy bullet continuations out of the identity title projection', async () => {
    const { vault, home } = await service()
    await vault.createAgent('legacy-identity', '旧格式伙伴')
    const file = join(home, 'agents', 'v1', 'le', 'legacy-identity', 'self', 'identity.md')
    await writeFile(file, [
      '---', 'id: "identity"', 'title: "核心身份"', 'enabled: true',
      'autonomous: false', 'locked: true', 'stability: core', '---', '',
      '# 核心身份', '', '旧格式伙伴（LEGACY · 完整身份标题）', '',
      '- 第一条资料。',
      '- 第二条资料第一行。',
      '第二条资料的旧格式续行。',
      '第二条资料的更多内容。', '',
    ].join('\n'), 'utf8')

    const identity = (await vault.inspectSelf('legacy-identity')).modules
      .find(module => module.id === 'identity')
    expect(identity).toMatchObject({
      summary: '旧格式伙伴（LEGACY · 完整身份标题）',
      details: ['第一条资料。', '第二条资料第一行。\n第二条资料的旧格式续行。\n第二条资料的更多内容。'],
    })
  })

  it('moves bounded consolidation batches with resumable checkpoints', async () => {
    const { vault } = await service()
    await vault.createAgent('student', '学习者')
    for (let index = 0; index < 7; index++) {
      await vault.captureMemory({ agentId: 'student', title: `知识 ${index}`, content: `批量内容 ${index}` }, agent)
    }
    await vault.recall({ agentId: 'student', domain: 'memory', query: '批量内容 6' })
    await vault.recall({ agentId: 'student', domain: 'memory', query: '批量内容 6' })
    const job = await vault.queueConsolidation('student', 'short', 'medium', agent)
    const first = await vault.runConsolidation(job.id, 3)
    expect(first).toMatchObject({ status: 'paused', processed: 3, total: 7 })
    const second = await vault.runConsolidation(job.id, 3)
    expect(second).toMatchObject({ status: 'paused', processed: 6 })
    const final = await vault.runConsolidation(job.id, 3)
    expect(final).toMatchObject({ status: 'completed', processed: 7 })
    expect((await vault.recall({ agentId: 'student', domain: 'memory', stage: 'medium', query: '批量内容 6' })).cards[0]?.title).toBe('知识 6')
    const common = (await vault.inspectSelf('student')).modules.find(module => module.id === 'common-memory')
    expect(common?.summary).toMatch(/阶段性整理/u)
    expect(common?.details.join('\n')).toContain('memory/medium')
  })

  it('round-trips resources and documents to a different Agent id without absolute paths', async () => {
    const { vault, home } = await service()
    await vault.createAgent('source-agent', '来源伙伴')
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    const resource = await vault.importResource('source-agent', {
      enabled: true, roles: ['expression'], title: '肯定', description: '用于表达肯定',
      tags: ['表情包', '肯定'], originalTags: ['肯定'], transcript: '', mimeType: 'image/gif',
      bytes: bytes.byteLength, builtIn: false,
    }, bytes, user())
    expect((await vault.searchResources({ agentId: 'source-agent', query: '肯定', roles: ['expression'] })).items[0]?.id).toBe(resource.id)
    expect(await vault.resourceContent('source-agent', resource.id)).toMatchObject({ type: 'file', bytes: 5 })
    const updated = await vault.updateResource('source-agent', resource.id, { title: '非常肯定' },
      user(resource.revision))
    expect(updated.title).toBe('非常肯定')

    const packageFile = join(home, 'exports', 'source.wvault')
    const exported = await vault.exportAgent('source-agent', packageFile, false)
    expect(exported.resources).toBe(1)
    const imported = await vault.importAgent(packageFile, 'copied-agent')
    expect(imported.agentId).toBe('copied-agent')
    expect((await vault.searchResources({ agentId: 'copied-agent', query: '肯定' })).items[0]).toMatchObject({ agentId: 'copied-agent', title: '非常肯定' })
    const manifest = await readFile(join(home, 'agents', 'v1', 'co', 'copied-agent', 'manifest.yml'), 'utf8')
    expect(manifest).not.toContain(home)
    const copied = await vault.resource('copied-agent', resource.id)
    await vault.removeResource('copied-agent', copied.id, user(copied.revision))
    await expect(vault.resource('copied-agent', copied.id)).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' })
  })

  it('uses roles as exact filters without letting a common role drown the lexical query', async () => {
    const { vault } = await service()
    await vault.createAgent('resource-ranking', '资源排序')
    const draft = (title: string) => ({ enabled: true, roles: ['expression'] as const, title,
      description: title, tags: ['表情包'], originalTags: [] as string[], transcript: '',
      mimeType: 'image/gif', bytes: 0, externalUrl: `/fixtures/${title}.gif`, builtIn: false })
    const target = await vault.importResource('resource-ranking', draft('被夸害羞感谢'), undefined, user())
    await vault.importResource('resource-ranking', draft('好气'), undefined, user())
    const result = await vault.searchResources({ agentId: 'resource-ranking', query: '被夸害羞感谢',
      roles: ['expression'], limit: 5 })
    expect(result.items[0]?.id).toBe(target.id)
  })

  it('lists, restores, permanently deletes, and empties complete Vault trash entries', async () => {
    const { vault } = await service()
    await vault.createAgent('recoverable', '可恢复伙伴')
    await vault.captureMemory({ agentId: 'recoverable', title: '保留的记忆', content: '完整恢复。' }, user())
    const avatar = Uint8Array.from([137, 80, 78, 71])
    await vault.importResource('recoverable', {
      preferredId: 'profile-appearance', enabled: true, roles: ['appearance'], title: '角色头像',
      description: '', tags: ['头像'], originalTags: [], transcript: '', mimeType: 'image/png',
      bytes: avatar.byteLength, builtIn: false,
    }, avatar, user())
    await vault.removeAgent('recoverable', user())

    const [removed] = await vault.listTrash()
    expect(removed).toMatchObject({
      agentId: 'recoverable', name: '可恢复伙伴', restorable: true, hasAvatar: true,
    })
    expect(await vault.trashAppearanceContent(removed!.id)).toMatchObject({
      type: 'file', mimeType: 'image/png', bytes: avatar.byteLength,
    })
    await vault.restoreTrash(removed!.id)
    expect((await vault.recall({ agentId: 'recoverable', domain: 'memory', query: '完整恢复' })).cards[0])
      .toMatchObject({ title: '保留的记忆' })
    expect(await vault.listTrash()).toEqual([])

    await vault.removeAgent('recoverable', user())
    const [blocked] = await vault.listTrash()
    await vault.createAgent('recoverable', '同 ID 新伙伴')
    expect((await vault.listTrash())[0]?.restorable).toBe(false)
    await expect(vault.restoreTrash(blocked!.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await vault.deleteTrash(blocked!.id)
    expect(await vault.listTrash()).toEqual([])

    await vault.createAgent('trash-a', '回收 A')
    await vault.createAgent('trash-b', '回收 B')
    await vault.removeAgent('trash-a', user())
    await vault.removeAgent('trash-b', user())
    expect(await vault.emptyTrash()).toBe(2)
    expect(await vault.listTrash()).toEqual([])
  })

  it('uses stable machine-readable errors', () => {
    const error = new AgentVaultError('test', 'DOMAIN_VIOLATION')
    expect(error).toMatchObject({ name: 'AgentVaultError', code: 'DOMAIN_VIOLATION' })
  })
})
