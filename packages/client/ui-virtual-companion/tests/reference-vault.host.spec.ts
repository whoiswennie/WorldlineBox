import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ReferenceVault } from '../src/reference-vault.ts'
import { expressionQuery } from '../src/reference-expression.ts'

const roots: string[] = []
const vaults: ReferenceVault[] = []
afterEach(async () => {
  for (const vault of vaults.splice(0)) vault.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<ReferenceVault> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-reference-'))
  roots.push(root)
  const vault = new ReferenceVault(root)
  vaults.push(vault)
  await vault.initialize()
  return vault
}

describe('ReferenceVault', () => {
  it('folds legacy metadata into tags and leaves only the latest storage schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-reference-upgrade-'))
    roots.push(root)
    const legacy = new DatabaseSync(join(root, 'references.sqlite'))
    legacy.exec(`
      CREATE TABLE reference_assets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,tags TEXT NOT NULL,mood TEXT NOT NULL,intent TEXT NOT NULL,topics TEXT NOT NULL,characters TEXT NOT NULL,language TEXT NOT NULL,transcript TEXT NOT NULL,mime_type TEXT NOT NULL,bytes INTEGER NOT NULL,duration_ms INTEGER,source TEXT NOT NULL,built_in INTEGER NOT NULL,usage_count INTEGER NOT NULL,last_used_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      INSERT INTO reference_assets VALUES('legacy-1','public','meme','旧图','旧说明','["旧标签"]','开心','庆祝','["主题"]','["角色"]','zh-CN','','image/gif',0,NULL,'{"type":"builtin","url":"/legacy.gif"}',0,0,NULL,1,1);
    `)
    legacy.close()
    const vault = new ReferenceVault(root)
    vaults.push(vault)
    await vault.initialize()

    expect(vault.get('legacy-1')?.tags).toEqual(expect.arrayContaining([
      '旧标签', '开心', '庆祝', '主题', '角色', '表情包', '图片', 'gif',
    ]))
    const verify = new DatabaseSync(join(root, 'references.sqlite'))
    const columns = verify.prepare('PRAGMA table_info(reference_assets)').all()
      .map(row => String((row as Record<string, unknown>)['name']))
    verify.close()
    expect(columns).toEqual([
      'id', 'scope', 'enabled', 'title', 'description', 'tags', 'transcript', 'mime_type', 'bytes',
      'duration_ms', 'source', 'built_in', 'usage_count', 'last_used_at', 'created_at', 'updated_at',
    ])
  })

  it('keeps disabled resources manageable while removing them from Agent discovery', async () => {
    const vault = await fixture()
    const asset = await vault.create({
      scope: 'public', title: '暂停使用的庆祝视频', description: '开心时播放',
      tags: ['视频', '庆祝', '临时'], transcript: '', mimeType: 'video/mp4',
      asset: 'https://example.com/paused.mp4',
    })

    expect(asset.enabled).toBe(true)
    const disabled = await vault.setEnabled(asset.id, false)
    expect(disabled.enabled).toBe(false)
    expect(vault.get(asset.id)?.enabled).toBe(false)
    expect(vault.query({ scopes: ['public'], query: '庆祝', tags: ['视频'] }).items).toEqual([])
    expect(vault.tagCatalog(['public'])).toEqual([])
    expect(vault.query({
      scopes: ['public'], query: '庆祝', tags: ['视频'], includeDisabled: true,
    }).items).toMatchObject([{ id: asset.id, enabled: false }])
    expect(vault.query({
      scopes: ['public'], query: '', includeDisabled: true, enabled: false,
    }).items).toMatchObject([{ id: asset.id, enabled: false }])
    expect(vault.tagCatalog(['public'], 48, true)).toEqual(expect.arrayContaining([
      { tag: '视频', count: 1 }, { tag: '庆祝', count: 1 },
    ]))

    await vault.setEnabled(asset.id, true)
    expect(vault.react({ scopes: ['public'], query: '庆祝', tags: ['视频'] })?.id).toBe(asset.id)
  })

  it('retrieves every resource through open tags and natural text without fixed categories', async () => {
    const vault = await fixture()
    const happy = await vault.createUpload({
      scope: 'public', title: '庆祝成功', description: '开心地为朋友欢呼',
      tags: ['朋友', '高兴', '庆祝', '表情包'], transcript: '', mimeType: 'image/png',
      asset: '',
    }, Buffer.from('hello'), 'image/png')
    await vault.create({
      scope: 'companion-one', title: '晚上好', description: '仅自己的问候声音',
      tags: ['问候'], transcript: '晚上好', mimeType: 'audio/mpeg',
      asset: 'data:audio/mpeg;base64,aGVsbG8=',
    })

    expect(vault.query({ scopes: ['public'], query: '高兴', tags: ['表情包'] }).items)
      .toMatchObject([{ id: happy.id }])
    expect(vault.query({ scopes: ['public'], query: '私密' }).items).toEqual([])
    expect(vault.query({ scopes: ['companion-one'], query: '', tags: ['问候'] }).items)
      .toMatchObject([{ mimeType: 'audio/mpeg' }])
    expect(vault.tagCatalog(['public'])).toEqual(expect.arrayContaining([
      { tag: '表情包', count: 1 }, { tag: '图片', count: 1 },
    ]))
    expect((await vault.blob(happy.id))?.data.toString()).toBe('hello')
  })

  it('updates metadata transactionally and protects built-in references', async () => {
    const vault = await fixture()
    const created = await vault.create({
      scope: 'public', title: '资料', description: '', tags: [],
      transcript: '', mimeType: '', asset: 'https://example.com',
    })
    const updated = await vault.update(created.id, {
      scope: 'public', title: '新资料', description: '可检索说明', tags: ['文档'],
      transcript: '', mimeType: '', asset: '',
    })
    expect(updated.source).toEqual(created.source)
    expect(vault.query({ scopes: ['public'], query: '可检索' }).items[0]?.title).toBe('新资料')
    await vault.remove(created.id)
    expect(vault.get(created.id)).toBeUndefined()
  })

  it('accepts an extension MIME without adding another storage category', async () => {
    const vault = await fixture()
    const created = await vault.create({
      scope: 'public', title: '画布', description: '', tags: ['画布', '用户'],
      transcript: '可检索转写', mimeType: 'application/vnd.worldline.canvas+json',
      asset: 'https://example.com/canvas.json', durationMs: 1_250,
    })
    expect(created.mimeType).toBe('application/vnd.worldline.canvas+json')
    expect(vault.query({ scopes: ['public'], query: '可检索转写', tags: ['画布'] }).items)
      .toMatchObject([{ id: created.id, durationMs: 1_250 }])
  })

  it('late-binds a video from a conversational expression without exposing its file path', async () => {
    const vault = await fixture()
    const data = Buffer.from('video-bytes')
    const video = await vault.createUpload({
      scope: 'public', title: '孤高曼波',
      description: '开心庆祝、好耶或者气氛热烈时播放', tags: ['庆祝', '开心'],
      transcript: '', mimeType: 'video/mp4', asset: '',
    }, data, 'video/mp4')
    const query = expressionQuery({
      act: '庆祝', role: 'amplify-text', intensity: 2,
      preferredTags: ['视频', '庆祝'], query: '一起庆祝成功',
    }, '终于做完了，大家都很开心')

    const selected = vault.react({ scopes: ['public'], query, tags: ['视频', '庆祝'] })
    expect(selected).toMatchObject({ id: video.id, mimeType: 'video/mp4' })
    expect((await vault.blob(video.id))?.data).toEqual(data)
    expect(vault.url(video)).toBe(`/api/virtual-companions/reference/blob/${video.id}`)
  })

  it('writes uploads incrementally and exposes file metadata for range streaming', async () => {
    const vault = await fixture()
    const chunk = Buffer.alloc(256 * 1_024, 7)
    let yielded = 0
    async function* stream(): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 17; index += 1) {
        yielded += 1
        yield chunk
      }
    }
    const expectedBytes = chunk.byteLength * 17
    const asset = await vault.createUploadStream({
      scope: 'public', title: '长视频流', description: '', tags: ['视频', '压力测试'],
      transcript: '', mimeType: 'video/mp4', asset: '',
    }, stream(), 'video/mp4', expectedBytes)

    expect(yielded).toBe(17)
    expect(asset.bytes).toBe(expectedBytes)
    expect(vault.blobInfo(asset.id)).toMatchObject({
      bytes: expectedBytes,
      mimeType: 'video/mp4',
    })
  })
})
