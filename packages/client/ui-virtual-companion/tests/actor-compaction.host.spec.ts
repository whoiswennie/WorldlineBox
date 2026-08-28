import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { CompanionActorRuntime } from '../src/actor-runtime.ts'
import type { VirtualCompanion } from '../src/contracts.ts'

const MODEL = 'companion-memory-model'
const MEMORY = '青金石-417'
const FIRST_RESPONSE = '好，我已经认真记住了。'
const RECALL_RESPONSE = `当然记得，我们约定的暗号是${MEMORY}。`

const companion: VirtualCompanion = {
  id: 'memory-companion',
  name: '记忆伙伴',
  handle: 'MEMORY',
  avatar: '/avatar.png',
  portrait: '/portrait.png',
  status: '在线',
  description: '用于验证压缩后记忆连续性的伙伴',
  persona: '你只扮演记忆伙伴，并认真记住用户明确要求长期承接的信息。',
  style: '沉稳',
  speakingStyle: '简洁自然',
  behaviorLogic: '先确认事实，再准确回答',
  builtIn: false,
  createdAt: 1,
  updatedAt: 1,
}

function textOf(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') {
      return block.content.flatMap(item => item.type === 'text' ? [item.text] : [])
    }
    return []
  })).join('\n')
}

function textResponse(text: string, inputTokens: number): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Deterministic model that preserves the secret only through the compaction checkpoint. */
class MemoryAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 10_000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const input = textOf(options)
    if (options.purpose === 'compaction') {
      this.summaryRequests.push(options)
      const summary = input.includes(MEMORY)
        ? `## Critical Context\n- The room owner asked this companion to remember the secret ${MEMORY}.`
        : '## Critical Context\n- The earlier secret was not available.'
      yield* textResponse(summary, 1_000)
      return
    }

    this.conversationRequests.push(options)
    if (this.conversationRequests.length === 1) {
      // Deliberately report pressure above the lowered 3,000-token threshold.
      yield* textResponse(FIRST_RESPONSE, 6_000)
      return
    }
    const remembered = input.includes('<compacted-summary>') && input.includes(MEMORY)
    yield* textResponse(remembered ? RECALL_RESPONSE : '我想不起来那个暗号了。', 500)
  }
}

interface MutableRoom {
  sessionId: string
  participantIds: string[]
  actorSessionIds: Record<string, string>
  epoch: number
  updatedAt: number
}

type Binding =
  | { kind: 'companion'; roomSessionId: string; companionId: string; epoch: number }
  | { kind: 'narrator'; roomSessionId: string; epoch: number }

let activeContext: Context | undefined
let persistenceRoot: string | undefined

afterEach(async () => {
  await activeContext?.fiber.dispose()
  activeContext = undefined
  if (persistenceRoot !== undefined) {
    await rm(persistenceRoot, { recursive: true, force: true })
    persistenceRoot = undefined
  }
})

describe('virtual companion continuable child compaction', () => {
  it('keeps role memory and continues normally after automatic context compaction', async () => {
    const ctx = new Context()
    activeContext = ctx
    await mountAgentLoopTestDependencies(ctx)
    persistenceRoot = await mkdtemp(join(tmpdir(), 'worldline-companion-compaction-'))
    await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    const adapter = new MemoryAdapter()
    ctx.llm.registerAdapter([MODEL], adapter)
    await ctx.plugin(BasicCompactionEngine, {
      thresholdRatio: 0.3,
      retainTokens: 128,
      maxTokens: 256,
      compactionRetries: 0,
    })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentFork, { providerName: 'fork' })

    const parent = ctx.agentLoop.create(SessionId('companion-compaction-room'), {
      provider: MODEL,
      model: MODEL,
    })
    const room: MutableRoom = {
      sessionId: parent.id,
      participantIds: [companion.id],
      actorSessionIds: {},
      epoch: 1,
      updatedAt: 1,
    }
    const bindings = new Map<string, Binding>()
    const directory = {
      knowledge: {
        tree: () => [],
        search: () => [],
        read: async () => undefined,
        remember: async () => ({ scope: companion.id, path: '', revision: '', title: '' }),
        audit: () => ({}),
      },
      references: {
        react: () => undefined,
        url: () => '',
        markUsed: () => undefined,
        tagCatalog: () => [],
      },
      companion: (id: string) => id === companion.id ? companion : undefined,
      room: (id: string) => id === room.sessionId ? room : undefined,
      actorBinding: (id: string) => bindings.get(id),
      bindActor: async (_roomId: string, companionId: string, childId: string) => {
        room.actorSessionIds = { ...room.actorSessionIds, [companionId]: childId }
        bindings.set(childId, {
          kind: 'companion',
          roomSessionId: room.sessionId,
          companionId,
          epoch: room.epoch,
        })
      },
      unbindActor: async (_roomId: string, companionId: string, childId: string) => {
        if (room.actorSessionIds[companionId] !== childId) return
        room.actorSessionIds = Object.fromEntries(
          Object.entries(room.actorSessionIds).filter(([id]) => id !== companionId),
        )
        bindings.delete(childId)
      },
      bindNarrator: async () => undefined,
      unbindNarrator: async () => undefined,
    }
    const runtime = new CompanionActorRuntime(ctx, directory as never)
    runtime.install(parent)
    ctx.on('agent/created', ({ agent }) => { runtime.install(agent) })
    ctx.on('session/event', (session, event) => { runtime.handleActorEvent(session, event) })
    ctx.on('subagent/end', (info) => { runtime.handleSettled(info) })
    // A continuable child settlement notifies its parent. Keep the coordinator
    // parked so the deterministic adapter is consumed only by the companion.
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === parent) return { kind: 'reject' as const }
      return next()
    })

    const dispatch = parent.ctx.tools.get('dispatch_companion', parent)
    if (dispatch === undefined) throw new Error('dispatch_companion was not installed')
    const signal = new AbortController().signal
    const first = await dispatch.execute({
      companion_id: companion.id,
      instruction: `请记住我们的暗号是${MEMORY}。${'填充旧对话。'.repeat(1_500)}`,
      evidence: '',
    }, { agent: parent, signal } as never) as { actor_session_id: string }

    await vi.waitFor(() => {
      expect(ctx.agents.get(SessionId(first.actor_session_id))).toBeUndefined()
    })

    const second = await dispatch.execute({
      companion_id: companion.id,
      instruction: '还记得我们刚才约定的暗号吗？只回答暗号。',
      evidence: '',
    }, { agent: parent, signal } as never) as { actor_session_id: string }

    await vi.waitFor(() => {
      expect(ctx.agents.get(SessionId(second.actor_session_id))).toBeUndefined()
    })
    const persisted = await ctx.sessionPersistence.load(SessionId(second.actor_session_id))
    const summaries = persisted.events.filter(event => event.type === 'compaction/summary')
    const visibleText = parent.session.events
      .filter((event): event is SessionEvent<'companion/stream-delta'> =>
        event.type === 'companion/stream-delta')
      .map(event => event.data.text)
      .join('')

    expect(second.actor_session_id).toBe(first.actor_session_id)
    expect(adapter.summaryRequests).toHaveLength(1)
    expect(textOf(adapter.summaryRequests[0]!)).toContain(MEMORY)
    expect(summaries).toHaveLength(1)
    expect(JSON.stringify(summaries[0]!.data.summary)).toContain(MEMORY)
    expect(adapter.conversationRequests).toHaveLength(2)
    expect(textOf(adapter.conversationRequests[1]!)).toContain('<compacted-summary>')
    expect(textOf(adapter.conversationRequests[1]!)).toContain(MEMORY)
    expect(textOf(adapter.conversationRequests[1]!)).not.toContain('填充旧对话')
    expect(visibleText).toContain(FIRST_RESPONSE)
    expect(visibleText).toContain(RECALL_RESPONSE)

    runtime.dispose()
  }, 20_000)
})
