import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ReferenceAsset } from '../packages/client/ui-virtual-companion/src/contracts.ts'
import { ReferenceVault } from '../packages/client/ui-virtual-companion/src/reference-vault.ts'

const requested = Number.parseInt(process.argv[2] ?? '20000', 10)
const count = Number.isFinite(requested) && requested > 0 ? requested : 20_000
const titles = [
  '被夸害羞感谢', '真不错', '好喜欢', '开心庆祝',
  '哭哭', '委屈流泪', '好气', '不要啊',
  '惊到了', '问号困惑', '偷看', '困死了',
  '喝奶茶', '晚上好', '唱歌跳舞', '温暖陪伴',
] as const
const root = await mkdtemp(join(tmpdir(), 'worldline-reference-benchmark-'))
const vault = new ReferenceVault(root)

try {
  await vault.initialize()
  const buildStart = performance.now()
  for (let index = 0; index < count; index += 1) {
    const title = titles[index % titles.length] ?? '日常'
    const asset: ReferenceAsset = {
      id: `synthetic-${String(index)}`,
      scope: index % 8 === 0 ? 'public' : 'stress-companion',
      enabled: true,
      title,
      description: `压力测试角色-${title}`,
      tags: [title, '表情包', '压力测试', '测试伙伴', ...(index % 3 === 0 ? ['自动扩展'] : [])],
      transcript: '',
      mimeType: 'image/gif',
      bytes: 0,
      source: { type: 'builtin', url: `/synthetic/${String(index)}.gif` },
      builtIn: false,
      usageCount: index % 97,
      createdAt: index,
      updatedAt: index,
    }
    await vault.seed(asset)
  }
  const buildMs = performance.now() - buildStart
  const queryStart = performance.now()
  for (let index = 0; index < 200; index += 1) {
    const result = vault.react({
      scopes: ['public', 'stress-companion'],
      query: '被夸害羞感谢',
      excludeIds: index % 2 === 0 ? ['synthetic-0'] : [],
    })
    if (result === undefined || /哭|泪|委屈|气|不要/u.test(result.title)) {
      throw new Error(`semantic mismatch at iteration ${String(index)}: ${result?.title ?? 'none'}`)
    }
  }
  const queryMs = performance.now() - queryStart

  console.log(JSON.stringify({
    entries: count,
    indexBuildMs: Math.round(buildMs),
    queries: 200,
    totalQueryMs: Math.round(queryMs),
    averageQueryMs: Number((queryMs / 200).toFixed(3)),
    heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1_048_576),
  }))
} finally {
  vault.close()
  await rm(root, { recursive: true, force: true })
}
