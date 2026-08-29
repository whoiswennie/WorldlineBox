import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAgentVaultService from '@deepseek-ai/dsh-agent-vault-local'
import { VirtualCompanionDirectory } from '../src/index.ts'

const roots: string[] = []
const stores: VirtualCompanionDirectory[] = []
const vaultServices: LocalAgentVaultService[] = []
const user = { actor: { type: 'user' as const, id: 'directory-test' }, reason: 'test fixture' }

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const vault of vaultServices.splice(0)) vault.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string
  legacy: string
  store: VirtualCompanionDirectory
  vaults: LocalAgentVaultService }> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-directory-'))
  roots.push(root)
  const legacy = join(root, 'companions')
  const vaults = new LocalAgentVaultService(new Context(), { worldlineHome: root })
  vaultServices.push(vaults)
  const store = new VirtualCompanionDirectory(new Context().logger, legacy, vaults)
  stores.push(store)
  await store.ready
  return { root, legacy, store, vaults }
}

describe('VirtualCompanionDirectory', { timeout: 30_000 }, () => {
  it('keeps the directory snapshot small while seeding one unified Agent Vault per companion', async () => {
    const { legacy, store, vaults } = await fixture()
    const snapshot = store.snapshot()
    expect(snapshot.companions.map(item => item.name)).toEqual(['月见八千代', '酒寄彩叶', '辉夜'])
    expect(snapshot).toEqual({ companions: snapshot.companions, rooms: {} })
    expect((await vaults.searchResources({ agentId: 'kaguya', query: '', tags: ['表情包'],
      includeDisabled: true, limit: 100 })).items.length).toBeGreaterThan(40)
    const favorite = (await vaults.recall({ agentId: 'kaguya', domain: 'memory', query: 'Reply',
      budget: { maxResults: 4 } })).cards[0]
    expect(favorite).toBeDefined()
    expect((await vaults.read('kaguya', favorite!.uri, 'full')).content).toContain('music.163.com')
    expect(JSON.parse(await readFile(join(legacy, 'directory.json'), 'utf8'))).toMatchObject({ version: 5 })
  })

  it('creates a private Vault and leaves a legacy migration source untouched on removal', async () => {
    const { legacy, store, vaults } = await fixture()
    const marker = join(legacy, 'legacy-resource-marker.txt')
    await writeFile(marker, 'preserve me', 'utf8')
    const created = await store.create({
      name: '测试伙伴', handle: 'TEST', avatar: '/worldline-experience/companion.png', portrait: '/worldline-experience/companion.png', status: '在线',
      description: '测试', persona: '身份', style: '风格', speakingStyle: '语气', behaviorLogic: '逻辑',
    })
    const companion = created.companions.find(item => item.name === '测试伙伴')!
    await vaults.captureMemory({ agentId: companion.id, title: '私有记忆', content: '只有自己可以读取。' }, user)
    await vaults.importResource(companion.id, { enabled: true, roles: ['expression'], title: '私有声音',
      description: '', tags: [], originalTags: [], transcript: '', mimeType: 'audio/mpeg', bytes: 5,
      builtIn: false }, Uint8Array.from([1, 2, 3, 4, 5]), user)
    await store.setRoom('room', [companion.id])
    expect(store.room('room')?.participantIds).toEqual([companion.id])
    await store.remove(companion.id)
    expect(store.ownsScope(companion.id)).toBe(false)
    await expect(vaults.manifest(companion.id)).rejects.toMatchObject({ code: 'VAULT_NOT_FOUND' })
    expect(await readFile(marker, 'utf8')).toBe('preserve me')
  })

  it('restores an edited built-in profile and replaces its private Vault with bundled originals', async () => {
    const { store, vaults } = await fixture()
    const original = store.companion('yachiyo-runami')!
    await store.update(original.id, {
      name: '被修改的八千代', handle: original.handle, avatar: original.avatar,
      portrait: original.portrait, status: original.status, description: original.description,
      persona: '用户覆盖的人设', style: original.style, speakingStyle: original.speakingStyle,
      behaviorLogic: original.behaviorLogic,
    })
    await vaults.captureMemory({ agentId: original.id, title: '用户覆盖专属资料', content: '恢复时应被移除。',
      tags: ['用户覆盖'] }, user)
    const customReference = await vaults.importResource(original.id, { enabled: true,
      roles: ['expression'], title: '用户自定义恢复测试图', description: '恢复时应被移除',
      tags: ['用户覆盖', '表情包'], originalTags: ['用户覆盖'], transcript: '', mimeType: 'image/png',
      bytes: 5, builtIn: false }, Uint8Array.from([1, 2, 3, 4, 5]), user)

    const restored = await store.restoreBuiltIn(original.id)
    expect(restored.companions.find(item => item.id === original.id)).toMatchObject({
      name: original.name, persona: original.persona, builtIn: true, createdAt: original.createdAt,
    })
    expect((await vaults.recall({ agentId: original.id, domain: 'memory', query: '用户覆盖专属资料' }))
      .cards.some(card => card.title === '用户覆盖专属资料')).toBe(false)
    expect((await vaults.recall({ agentId: original.id, domain: 'memory', query: '朧月夜' })).cards.length).toBeGreaterThan(0)
    await expect(vaults.resource(original.id, customReference.id)).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' })
    expect((await vaults.searchResources({ agentId: original.id, query: '', tags: ['表情包'],
      includeDisabled: true, limit: 100 })).items.length).toBeGreaterThan(0)
  })
})
