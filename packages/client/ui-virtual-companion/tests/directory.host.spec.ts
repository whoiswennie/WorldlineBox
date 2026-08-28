import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { VirtualCompanionDirectory } from '../src/index.ts'

const roots: string[] = []
const stores: VirtualCompanionDirectory[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; store: VirtualCompanionDirectory }> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-directory-'))
  roots.push(root)
  const store = new VirtualCompanionDirectory(new Context().logger, root)
  stores.push(store)
  await store.ready
  return { root, store }
}

describe('VirtualCompanionDirectory', () => {
  it('keeps the directory snapshot small while seeding independent indexed vaults', async () => {
    const { root, store } = await fixture()
    const snapshot = store.snapshot()
    expect(snapshot.companions.map(item => item.name)).toEqual(['月见八千代', '酒寄彩叶', '辉夜'])
    expect(snapshot).toEqual({ companions: snapshot.companions, rooms: {} })
    expect(store.references.query({ scopes: ['kaguya'], query: '', tags: ['表情包'], limit: 100 }).items.length)
      .toBeGreaterThan(40)
    const favorite = store.knowledge.search(['kaguya'], 'Reply', 0, 4)[0]
    expect(favorite).toBeDefined()
    expect((await store.knowledge.read('kaguya', favorite!.path, 'full')).content)
      .toContain('music.163.com')
    expect(JSON.parse(await readFile(join(root, 'directory.json'), 'utf8'))).toMatchObject({ version: 5 })
  })

  it('creates a private sharded scope and removes it with the companion', async () => {
    const { store } = await fixture()
    const created = await store.create({
      name: '测试伙伴', handle: 'TEST', avatar: '/worldline-experience/companion.png', portrait: '/worldline-experience/companion.png', status: '在线',
      description: '测试', persona: '身份', style: '风格', speakingStyle: '语气', behaviorLogic: '逻辑',
    })
    const companion = created.companions.find(item => item.name === '测试伙伴')!
    await store.knowledge.remember(companion.id, '私有记忆', '只有自己可以读取。')
    await store.references.create({
      scope: companion.id, title: '私有声音', description: '', tags: [], transcript: '', mimeType: 'audio/mpeg',
      asset: 'data:audio/mpeg;base64,aGVsbG8=',
    })
    await store.setRoom('room', [companion.id])
    expect(store.room('room')?.participantIds).toEqual([companion.id])
    await store.remove(companion.id)
    expect(store.ownsScope(companion.id)).toBe(false)
    expect(store.knowledge.search([companion.id], '私有记忆')).toEqual([])
    expect(store.references.query({ scopes: [companion.id], query: '' }).items).toEqual([])
  })

  it('restores an edited built-in profile and replaces both private vaults with bundled originals', async () => {
    const { store } = await fixture()
    const original = store.companion('yachiyo-runami')!
    await store.update(original.id, {
      name: '被修改的八千代', handle: original.handle, avatar: original.avatar,
      portrait: original.portrait, status: original.status, description: original.description,
      persona: '用户覆盖的人设', style: original.style, speakingStyle: original.speakingStyle,
      behaviorLogic: original.behaviorLogic,
    })
    await store.knowledge.remember(original.id, '用户覆盖专属资料', '恢复时应被移除。', ['用户覆盖'])
    const customReference = await store.references.create({
      scope: original.id, title: '用户自定义恢复测试图', description: '恢复时应被移除',
      tags: ['用户覆盖', '表情包'],
      transcript: '', mimeType: 'image/png', asset: 'data:image/png;base64,aGVsbG8=',
    })

    const restored = await store.restoreBuiltIn(original.id)
    expect(restored.companions.find(item => item.id === original.id)).toMatchObject({
      name: original.name, persona: original.persona, builtIn: true, createdAt: original.createdAt,
    })
    expect(store.knowledge.search([original.id], '用户覆盖专属资料')).toEqual([])
    expect(store.knowledge.search([original.id], '朧月夜', 0, 4).length).toBeGreaterThan(0)
    expect(store.references.get(customReference.id)).toBeUndefined()
    expect(store.references.query({ scopes: [original.id], query: '', tags: ['表情包'], limit: 100 }).items.length)
      .toBeGreaterThan(0)
  })
})
