import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalAgentVaultService from '@deepseek-ai/dsh-agent-vault-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as VaultTools from '../src/index.ts'

const signal = new AbortController().signal

describe('Agent Vault tools', () => {
  it('uses Host runtime binding, saves immediately, recalls, and refuses a self path through general update', async () => {
    const home = await mkdtemp(join(tmpdir(), 'worldline-vault-tools-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const vault = new LocalAgentVaultService(ctx, { worldlineHome: home })
    try {
      await vault.createAgent('private-mind', '私有心智')
      const session = Session.create(SessionId('runtime-session'))
      const agent = { id: session.id, session, options: {} } as Agent
      vault.bindRuntimeAgent(agent.id, 'private-mind')
      VaultTools.apply(ctx)

      const remembered = await ctx.tools.execute({ signal, agent, callId: CallId('remember'), name: 'memory_remember',
        arguments: { title: '连环漫画经验', content: '先写分镜，再保持角色一致性。', tags: ['漫画', '分镜'] } })
      expect(remembered.isError).toBe(false)
      const recalled = await ctx.tools.execute({ signal, agent, callId: CallId('recall'), name: 'memory_recall',
        arguments: { query: '画漫画 分镜' } })
      expect(recalled.isError).toBe(false)
      expect(JSON.stringify(recalled.value)).toContain('连环漫画经验')

      const memory = JSON.parse(typeof remembered.value === 'string'
        ? remembered.value : JSON.stringify(remembered.value)) as { uri: string }
      const resolved = await ctx.tools.execute({ signal, agent, callId: CallId('resolve'),
        name: 'vault_resolve_path', arguments: { uri: memory.uri, mode: 'write', reason: 'external editor test' } })
      expect(resolved.isError).toBe(false)
      const lease = JSON.parse(typeof resolved.value === 'string'
        ? resolved.value : JSON.stringify(resolved.value)) as { path: string; leaseId: string }
      await writeFile(lease.path, `${await readFile(lease.path, 'utf8')}\n外部工具补充：保持角色服装一致。\n`, 'utf8')
      const reconciled = await ctx.tools.execute({ signal, agent, callId: CallId('reconcile'),
        name: 'vault_reconcile', arguments: { lease_id: lease.leaseId } })
      expect(reconciled.isError).toBe(false)
      expect((await vault.recall({ agentId: 'private-mind', domain: 'memory', query: '角色服装一致' }))
        .cards.some(card => card.title === '连环漫画经验')).toBe(true)

      const denied = await ctx.tools.execute({ signal, agent, callId: CallId('deny'), name: 'vault_update',
        arguments: { uri: 'vault://self/persona.md', content: '# 坏修改', reason: 'ordinary collision' } })
      expect(denied.isError).toBe(true)
      expect(denied.content[0]).toMatchObject({ type: 'text' })
    } finally {
      vault.close()
      await rm(home, { recursive: true, force: true })
    }
  })
})
