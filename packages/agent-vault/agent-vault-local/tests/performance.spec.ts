import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import LocalAgentVaultService from '../src/index.ts'

const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

describe('Agent Vault scale profile', () => {
  it('rebuilds a large file-native corpus and keeps bounded lexical recall interactive', async () => {
    const count = Number(process.env['WORLDLINE_VAULT_PERF_DOCUMENTS'] ?? 10_000)
    const home = await mkdtemp(join(tmpdir(), 'worldline-vault-perf-')); roots.push(home)
    const vault = new LocalAgentVaultService(new Context(), { worldlineHome: home })
    try {
      await vault.createAgent('scale-agent', '规模测试'); vault.close()
      const target = join(home, 'agents', 'v1', 'sc', 'scale-agent', 'memory', 'long', 'corpus')
      await mkdir(target, { recursive: true })
      for (let offset = 0; offset < count; offset += 250) {
        await Promise.all(Array.from({ length: Math.min(250, count - offset) }, (_, at) => {
          const index = offset + at
          return writeFile(join(target, `${String(index).padStart(6, '0')}.md`), [
            '---', `title: "课程知识 ${String(index)}"`,
            `tags: ["课程", "专题-${String(index % 97)}"]`,
            `summary: "第 ${String(index)} 条标准化课程知识。"`, 'aliases: ["学习材料"]',
            'sources: ["synthetic-scale-fixture"]', '---', '', `# 课程知识 ${String(index)}`, '',
            index === count - 1 ? '独特检索标记：星海分镜蓝图。' : `普通正文 ${String(index)}`, '',
          ].join('\n'))
        }))
      }
      const rebuildStarted = performance.now(); await vault.rebuildIndex('scale-agent')
      const rebuildMs = performance.now() - rebuildStarted
      const recallStarted = performance.now()
      const recallCpuStarted = process.cpuUsage()
      const result = await vault.recall({ agentId: 'scale-agent', domain: 'memory', query: '星海分镜蓝图',
        budget: { maxResults: 5, maxChars: 4_000, maxMillis: 500 } })
      const recallCpu = process.cpuUsage(recallCpuStarted)
      const recallCpuMs = (recallCpu.user + recallCpu.system) / 1_000
      const recallMs = performance.now() - recallStarted
      expect(result.cards[0]?.title).toBe(`课程知识 ${String(count - 1)}`)
      expect(recallCpuMs).toBeLessThan(500)
      expect(recallMs).toBeLessThan(2_000)
      expect(rebuildMs).toBeLessThan(120_000)
    } finally {
      vault.close()
    }
  }, 150_000)
})
