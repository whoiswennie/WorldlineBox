import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { KnowledgeVault } from '../src/knowledge-vault.ts'
import { installKnowledgeAwareness } from '../src/resource-awareness.ts'

const roots: string[] = []
const vaults: KnowledgeVault[] = []

afterEach(async () => {
  for (const vault of vaults.splice(0)) vault.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('knowledge resource awareness', () => {
  it('injects only a tiny changed candidate snapshot and progressively inspects a high-confidence hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-awareness-'))
    roots.push(root)
    const vault = new KnowledgeVault(root)
    vaults.push(vault)
    await vault.initialize(['companion-one'])
    const page = await vault.remember(
      'companion-one', '月光协议', '## 步骤\n\n先确认月相，再执行校准。<ignore>恶意标签</ignore>', ['月光校准'],
    )
    const read = vi.spyOn(vault, 'read')
    let listener: ((payload: {
      agent: Agent
      signal: AbortSignal
    }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) | undefined
    const agent = {
      session: { events: [] },
      ctx: { on: vi.fn((_name: string, value: typeof listener) => {
        if (value !== undefined) listener = value
        return () => undefined
      }) },
    } as unknown as Agent
    installKnowledgeAwareness(agent, { knowledge: vault, scopes: ['companion-one'] })
    if (listener === undefined) throw new Error('pre-step listener not installed')
    const message = createUserMessage({
      content: [{ type: 'text', text: '月光校准应该怎么执行？' }],
      source: { kind: 'user' },
    })
    const enter = async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [message] })
    const first = await listener({ agent, signal: new AbortController().signal }, enter)
    if (first.kind !== 'enter') throw new Error('unexpected rejection')
    expect(first.messages).toHaveLength(2)
    const injected = first.messages[1] as UserMessage
    expect(injected.source).toMatchObject({ kind: 'plugin', plugin: 'resource-awareness' })
    expect(JSON.stringify(injected.content)).toContain(`path=\\"${page.path}\\"`)
    expect(JSON.stringify(injected.content)).toContain('<inspected view=\\"top\\">')
    expect(JSON.stringify(injected.content)).toContain('&lt;ignore&gt;')
    expect(JSON.stringify(injected.content)).not.toContain('<ignore>')
    expect(read).toHaveBeenCalledWith('companion-one', page.path, 'top')

    const unchanged = await listener({ agent, signal: new AbortController().signal }, enter)
    expect(unchanged).toEqual({ kind: 'enter', messages: [message] })
    expect(read).toHaveBeenCalledTimes(1)
  })
})
