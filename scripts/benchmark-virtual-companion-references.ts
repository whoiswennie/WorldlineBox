import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import LocalAgentVaultService from '../packages/agent-vault/agent-vault-local/src/index.ts'

const requested = Number.parseInt(process.argv[2] ?? '20000', 10)
const count = Number.isFinite(requested) && requested > 0 ? requested : 20_000
const titles = [
  '被夸害羞感谢', '真不错', '好喜欢', '开心庆祝',
  '哭哭', '委屈流泪', '好气', '不要啊',
  '惊到了', '问号困惑', '偷看', '困死了',
  '喝奶茶', '晚上好', '唱歌跳舞', '温暖陪伴',
] as const
const home = await mkdtemp(join(tmpdir(), 'worldline-agent-vault-resource-benchmark-'))
const vaults = new LocalAgentVaultService(new Context(), { worldlineHome: home })
const writer = { actor: { type: 'system' as const, id: 'resource-benchmark' },
  reason: 'Build a disposable Agent Vault resource benchmark.' }

try {
  await vaults.createAgent('public', '公共 Agent Vault')
  await vaults.createAgent('stress-companion', '压力测试伙伴')
  const buildStart = performance.now()
  for (let index = 0; index < count; index += 1) {
    const title = titles[index % titles.length] ?? '日常'
    const agentId = index % 7 === 0 ? 'public' : 'stress-companion'
    await vaults.importResource(agentId, {
      preferredId: `synthetic-${String(index)}`,
      enabled: true,
      roles: ['expression'],
      title,
      description: `压力测试角色-${title}`,
      tags: [title, '表情包', '压力测试', '测试伙伴', ...(index % 3 === 0 ? ['自动扩展'] : [])],
      originalTags: [],
      transcript: '',
      mimeType: 'image/gif',
      bytes: 0,
      externalUrl: `/synthetic/${String(index)}.gif`,
      builtIn: false,
      usageCount: index % 97,
      createdAt: index,
    }, undefined, writer)
  }
  const buildMs = performance.now() - buildStart
  const queryStart = performance.now()
  for (let index = 0; index < 200; index += 1) {
    const result = await vaults.searchResources({
      agentId: index % 2 === 0 ? 'public' : 'stress-companion',
      query: '被夸害羞感谢',
      roles: ['expression'],
      limit: 5,
    })
    const first = result.items[0]
    if (first === undefined || /哭|泪|委屈|气|不要/u.test(first.title)) {
      throw new Error(`lexical mismatch at iteration ${String(index)}: ${first?.title ?? 'none'}`)
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
  vaults.close()
  await rm(home, { recursive: true, force: true })
}
