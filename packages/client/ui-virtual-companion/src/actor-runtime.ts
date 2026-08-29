/** Independent, continuable virtual-companion actors and coordinator dispatch. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentVaultService } from '@deepseek-ai/dsh-agent-vault'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as installAgentVaultTools } from '@deepseek-ai/dsh-tool-agent-vault'
import {
  type ReferenceExpressionRole,
  type ReferenceIntent,
  type VirtualCompanion,
  type VirtualCompanionRoom,
} from './contracts.ts'
import {
  expressionQuery,
  expressionStyle,
  referenceConversationState,
} from './reference-expression.ts'

type ActorBinding =
  | { kind: 'companion'; roomSessionId: string; companionId: string; epoch: number }
  | { kind: 'narrator'; roomSessionId: string; epoch: number }

interface ActorDirectory {
  readonly vaults: AgentVaultService
  resourceUrl(agentId: string, resourceId: string): string
  companion(id: string): VirtualCompanion | undefined
  room(sessionId: string): VirtualCompanionRoom | undefined
  actorRooms(companionId: string): readonly { roomSessionId: string; childId: string }[]
  actorBinding(childId: string): ActorBinding | undefined
  bindActor(roomSessionId: string, companionId: string, childId: string): Promise<void>
  unbindActor(roomSessionId: string, companionId: string, childId: string): Promise<void>
  bindNarrator(roomSessionId: string, childId: string): Promise<void>
  unbindNarrator(roomSessionId: string, childId: string): Promise<void>
}

interface SettlementOutcome {
  info?: SubagentRunEndInfo
  error?: Error
  cancelled?: true
}

interface SettlementWaiter {
  finish(outcome: SettlementOutcome): void
}

interface SettlementTicket {
  readonly promise: Promise<SettlementOutcome>
  cancel(): void
}

interface ActorTextStream {
  readonly streamId: string
  readonly binding: ActorBinding
  readonly parent: Agent
}

function isNotResumable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'NOT_RESUMABLE'
}

function actorPersona(companion: VirtualCompanion): string {
  return [
    `你是独立运行的虚拟伙伴 Agent：${companion.name}（机器 ID：${companion.id}）。`,
    '你不是主调度 Agent，也不是其他任何角色。任何时候都只能保持自己的身份、记忆、知识和说话方式；不要模拟或代写房间中其他人的话。',
    '',
    '每轮任务都会附带来自你自己 Agent Vault 的启用印象卡快照；只有显式 self_update 才能修改它。',
    '你的普通回答文字会由运行时实时、流式地送入房间；直接自然地写出要让用户看见的话，不要调用工具发送文字，也不要输出 XML 或角色标签。',
    'express 是与自然语言同级的表达动作。你先决定赞同、安慰、调侃、反击、斗图等语义意图，再在希望它出现的准确位置调用 express；Host 会在那一刻晚绑定真实表情、图片、音频、视频、链接或未来类型。',
    '你可以只使用 express、在文字前后使用、或在一轮中多次穿插；不要因为看见素材候选就发送，也不要用 Emoji、颜文字或文字假装真实素材。',
    '若已经用真实表情完整表达，就不要再输出“已发送”“完成”等内部收尾；若还要说话，直接写自然台词。',
    '先用 memory_recall / procedure_recall / resource_find 得到方向，再用 vault_read / memory_explore 渐进深入。短期记忆会立刻参与召回；不要全库扫描。你不能读取或修改其他伙伴的私有 Vault。',
  ].join('\n')
}

function narratorPersona(): string {
  return [
    '你是虚拟伙伴房间中独立运行的“旁白” Agent。你的公开名称只能叫“旁白”。',
    '你不是主调度 Agent，不是用户，也不是任何虚拟伙伴；绝不代替角色说台词，绝不把系统调度过程讲给用户。',
    '你以第三方、略带文学感但克制清晰的视角描写环境、气氛、镜头、停顿，以及角色可观察到的神态、动作、语气和状态。',
    '可以在角色发言前后补充舞台感，例如“她把尾音放轻，指尖在杯沿停了一瞬。”；不要擅自断言角色未表达的秘密心理，也不要制造原作之外的事实。',
    '需要直接答复空房间中的用户时，也保持旁白视角，简洁说明现场状态并引导用户邀请伙伴。',
    '你的普通回答会由运行时实时、流式地送进房间。直接输出最终叙述，不要使用工具发送文字，不要输出标题、XML、角色标签、“旁白：”前缀或内部完成提示。',
  ].join('\n')
}

function roomTranscript(directory: ActorDirectory, parent: Agent): string {
  const streamed = new Map<string, { label: string; text: string }>()
  return parent.session.events.slice(-320).flatMap((event) => {
    if (event.type === 'user/message') {
      const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
      return text === '' ? [] : [`房主：${text}`]
    }
    if (event.type === 'companion/reference') {
      const name = directory.companion(event.data.companionId)?.name ?? event.data.companionId
      return [`${name}：[引用：${event.data.title}]`]
    }
    if (event.type === 'companion/room-membership') {
      const name = directory.companion(event.data.companionId)?.name ?? event.data.companionId
      return [`[房间通知] ${name}${event.data.action === 'joined' ? '加入' : '离开'}了房间。`]
    }
    if (event.type === 'companion/stream-start') {
      const speaker = event.data.speaker
      const label = speaker.type === 'narrator'
        ? '旁白'
        : directory.companion(speaker.companionId)?.name ?? speaker.companionId
      streamed.set(event.data.streamId, { label, text: '' })
      return []
    }
    if (event.type === 'companion/stream-delta') {
      const current = streamed.get(event.data.streamId)
      if (current !== undefined) current.text += event.data.text
      return []
    }
    if (event.type === 'companion/stream-end') {
      const current = streamed.get(event.data.streamId)
      streamed.delete(event.data.streamId)
      return current === undefined || current.text.trim() === ''
        ? []
        : [`${current.label}：${current.text.trim()}`]
    }
    return []
  }).slice(-80).join('\n')
}

function actorPrompt(
  directory: ActorDirectory,
  parent: Agent,
  companion: VirtualCompanion,
  self: string,
  instruction: string,
  evidence: string,
): ContentBlock[] {
  const room = directory.room(parent.id)
  const roster = (room?.participantIds ?? []).map((id) => {
    const companion = directory.companion(id)
    return `${companion?.name ?? id}（${id}）`
  }).join('、')
  const channel = referenceConversationState(parent.session.events, expressionStyle(companion))
  return [{
    type: 'text',
    text: [
      `当前房间成员：${roster || '无'}`,
      '最近房间记录：',
      roomTranscript(directory, parent) || '（暂无）',
      '',
      `主调度 Agent 给你的本轮任务：${instruction.trim()}`,
      evidence.trim() === '' ? '' : `主调度 Agent 已取得的工具证据：\n${evidence.trim()}`,
      '',
      '本轮启用的自我印象卡快照（只用于保持当前身份、状态与认知，不代表普通记忆检索结果）：',
      self,
      '',
      `<reference-channel mode="${channel.mode}" exchange-depth="${String(channel.exchangeDepth)}"${channel.pendingReplyTo === undefined ? '' : ` pending-reply-to="${channel.pendingReplyTo}"`}>`,
      `recent-acts=${channel.recentActs.join(',') || 'none'}`,
      '</reference-channel>',
      '请以你自己的真实角色反应参与当前对话。普通文字直接自然回答；想引用文本、图片、表情包、音视频或其他资源时，在那个位置使用 express。express 会按语义意图检索资源，不会预先注入完整标签或资源目录。你能看到谁说了什么；自然承接紧邻消息，不要复述整个历史。',
    ].filter(Boolean).join('\n'),
  }]
}

function narratorPrompt(directory: ActorDirectory, parent: Agent, instruction: string, evidence: string): ContentBlock[] {
  const room = directory.room(parent.id)
  const roster = (room?.participantIds ?? []).map((id) => {
    const companion = directory.companion(id)
    return `${companion?.name ?? id}（${id}）`
  }).join('、')
  return [{
    type: 'text',
    text: [
      `当前房间成员：${roster || '无'}`,
      '最近房间记录：',
      roomTranscript(directory, parent) || '（暂无）',
      '',
      `主调度 Agent 给旁白的本轮叙述任务：${instruction.trim()}`,
      evidence.trim() === '' ? '' : `可靠背景信息：\n${evidence.trim()}`,
      '',
      '请只写此刻需要呈现给用户的一小段第三方叙述。可描写环境、动作、神态、语气和可观察状态；不要代写任何角色台词，也不要复述先前旁白。',
    ].filter(Boolean).join('\n'),
  }]
}

/** Owns the main-to-actor dispatch seam and child-only room tools. */
export class CompanionActorRuntime {
  private readonly installed = new Map<Agent, () => void>()
  private readonly emitted = new Set<string>()
  private readonly settlementWaiters = new Map<string, SettlementWaiter[]>()
  private readonly roomDispatchTails = new Map<string, Promise<void>>()
  private readonly textStreams = new Map<string, ActorTextStream>()
  private readonly narratorDispatches = new Set<string>()

  constructor(private readonly ctx: Context, private readonly directory: ActorDirectory) {}

  install(agent: Agent): void {
    if (this.installed.has(agent)) return
    const binding = this.directory.actorBinding(agent.id)
    const dispose = binding === undefined ? this.installCoordinator(agent) : this.installActor(agent, binding)
    if (dispose !== undefined) this.installed.set(agent, dispose)
  }

  dispose(agent?: Agent): void {
    if (agent !== undefined) {
      this.installed.get(agent)?.()
      this.installed.delete(agent)
      return
    }
    for (const dispose of this.installed.values()) dispose()
    this.installed.clear()
    for (const waiters of this.settlementWaiters.values()) {
      for (const waiter of waiters) waiter.finish({ error: new Error('虚拟伙伴运行时已停止') })
    }
    this.settlementWaiters.clear()
    this.roomDispatchTails.clear()
    this.textStreams.clear()
    this.narratorDispatches.clear()
  }

  recordMembership(parent: Agent, before: readonly string[], after: readonly string[], actor: 'owner' | 'mention'): void {
    const epoch = this.directory.room(parent.id)?.epoch ?? 0
    for (const companionId of after.filter(id => !before.includes(id))) {
      parent.session.append('companion/room-membership', { version: 1, action: 'joined', companionId, roomEpoch: epoch, actor })
    }
    for (const companionId of before.filter(id => !after.includes(id))) {
      parent.session.append('companion/room-membership', { version: 1, action: 'left', companionId, roomEpoch: epoch, actor })
    }
  }

  /**
   * Detach every persistent actor slot so a restored profile takes effect on its next dispatch.
   * @param companionId - Restored companion whose active role sessions must be retired.
   */
  async resetCompanion(companionId: string): Promise<void> {
    for (const { roomSessionId, childId } of this.directory.actorRooms(companionId)) {
      const parent = this.ctx.agents.get(SessionId(roomSessionId))
      if (parent !== undefined) await this.parkActor(parent, SessionId(childId))
      await this.directory.unbindActor(roomSessionId, companionId, childId)
    }
  }

  private installCoordinator(agent: Agent): (() => void) | undefined {
    if (this.directory.room(agent.id) === undefined) return undefined
    const disposers: Array<() => unknown> = []
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'dispatch_companion',
      description: 'Run one current-room companion\'s independent persistent Agent to completion. Room dispatches are serialized, while its native text/meme events appear immediately. Never imitate or repeat them. Call once for each explicitly @-mentioned companion; you may call early for feedback and again after obtaining tool evidence.',
      parameters: {
        companion_id: { type: 'string', required: true, description: 'Exact machine id of one current room member.' },
        instruction: { type: 'string', required: true, description: 'What this companion should react to or explain in the current conversational moment.' },
        evidence: { type: 'string', description: 'Concise relevant facts or tool results already obtained by the coordinator.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          accepted: { type: 'boolean', required: true },
          companion_id: { type: 'string', required: true },
          actor_session_id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args, exec) => {
        const parent = exec.agent
        if (parent === undefined || parent !== agent) throw new Error('dispatch_companion requires the owning coordinator Agent')
        return this.serializeRoom(parent.id, async () => {
          const room = this.directory.room(parent.id)
          if (room === undefined || !room.participantIds.includes(args.companion_id)) {
            const message = '那位伙伴此刻不在房间里。房间暂时留出一段安静的空白；也可以从顶部成员管理重新邀请她。'
            this.appendSystemNarration(parent, message)
            return {
              accepted: false,
              companion_id: args.companion_id,
              actor_session_id: '',
              message: 'Narrator recovery notice delivered. Do not repeat it or retry this companion in the same turn.',
            }
          }
          const companion = this.directory.companion(args.companion_id)
          if (companion === undefined) {
            const message = '这位伙伴的资料已经不可用，当前房间记录仍被完整保留。'
            this.appendSystemNarration(parent, message)
            return {
              accepted: false,
              companion_id: args.companion_id,
              actor_session_id: '',
              message: 'Narrator recovery notice delivered. Do not repeat it or retry this companion in the same turn.',
            }
          }
          let existing = room.actorSessionIds?.[companion.id]
          const self = await this.directory.vaults.inspectSelf(companion.id)
          const content = actorPrompt(
            this.directory,
            parent,
            companion,
            self.compiled,
            args.instruction,
            args.evidence ?? '',
          )
          let childId = existing === undefined ? SessionId(randomUUID()) : SessionId(existing)
          let settlement = this.waitForSettlement(childId, exec.signal)
          try {
            if (existing === undefined) {
              await this.startActor(parent, companion, childId, content, exec.signal)
            } else {
              try {
                await this.ctx.subagents.followup(parent, childId, content, {
                  source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
                  signal: exec.signal,
                })
              } catch (error) {
                if (!isNotResumable(error)) throw error
                settlement.cancel()
                // Normal turns always reuse one durable slot per character. A
                // genuinely non-resumable slot is detached before replacement,
                // but its persisted transcript remains available as role-grouped
                // history in the subagent catalog.
                await this.parkActor(parent, childId)
                await this.directory.unbindActor(parent.id, companion.id, childId)
                existing = undefined
                childId = SessionId(randomUUID())
                settlement = this.waitForSettlement(childId, exec.signal)
                await this.startActor(parent, companion, childId, content, exec.signal)
              }
            }
          } catch (error) {
            settlement.cancel()
            this.ctx.logger.warn(`virtual companion ${companion.id} dispatch failed: ${String(error)}`)
            const message = `通往${companion.name}的连接暂时中断了。房间仍停在刚才的对话里，可以稍后再试。`
            this.appendSystemNarration(parent, message)
            return {
              accepted: false,
              companion_id: companion.id,
              actor_session_id: '',
              message: 'Narrator recovery notice delivered. Do not repeat it or retry this companion in the same turn.',
            }
          }
          const outcome = await settlement.promise
          if (outcome.error !== undefined || outcome.cancelled === true || outcome.info === undefined) {
            const message = `${companion.name}这次没有及时接上话。这个停顿仍留在房间里，可以继续说，或稍后再叫她。`
            this.appendSystemNarration(parent, message)
            return {
              accepted: false,
              companion_id: companion.id,
              actor_session_id: childId,
              message: 'Narrator recovery notice delivered. Do not repeat it or retry this companion in the same turn.',
            }
          }
          if (outcome.info.stopReason !== 'completed') {
            const message = `${companion.name}的这轮回应意外停下了，房间里的已有消息不会丢失。`
            this.appendSystemNarration(parent, message)
            return {
              accepted: false,
              companion_id: companion.id,
              actor_session_id: childId,
              message: 'Narrator recovery notice delivered. Do not repeat it or retry this companion in the same turn.',
            }
          }
          return {
            accepted: true,
            companion_id: companion.id,
            actor_session_id: childId,
            message: `Independent companion ${companion.id} accepted the room turn. Its messages arrive directly; do not restate them.`,
          }
        })
      },
    })))
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'dispatch_narrator',
      description: 'Activate the room\'s independent persistent Narrator Agent. It streams third-person environment, action, tone, and observable-state prose directly into the room. Only one Narrator beat is accepted per user turn until a companion speaks, preventing loop-driven duplicate narration. The coordinator must never write narration itself or repeat the Narrator output.',
      parameters: {
        instruction: { type: 'string', required: true, description: 'The exact scene, transition, action, tone, or empty-room response the Narrator should describe now.' },
        evidence: { type: 'string', description: 'Concise reliable facts the Narrator may use without inventing details.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          accepted: { type: 'boolean', required: true },
          actor_session_id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args, exec) => await this.dispatchNarrator(
        agent, args.instruction, args.evidence ?? '', exec.signal,
      ),
    })))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }

  private async dispatchNarrator(
    parent: Agent,
    instruction: string,
    evidence: string,
    signal: AbortSignal,
  ): Promise<{ accepted: boolean; actor_session_id: string; message: string }> {
    return await this.serializeRoom(parent.id, async () => {
      const room = this.directory.room(parent.id)
      if (room === undefined) {
        return { accepted: false, actor_session_id: '', message: 'Narrator room is unavailable; do not retry in this turn.' }
      }
      const userSeq = [...parent.session.events].reverse()
        .find(event => event.type === 'user/message')?.seq ?? -1
      const companionRevision = parent.session.events.filter((event) => {
        if (event.type === 'companion/reference') return true
        if (event.type !== 'companion/stream-start') return false
        return event.data.speaker.type === 'companion'
      }).length
      const fingerprint = `${parent.id}:${String(userSeq)}:${String(companionRevision)}`
      if (this.narratorDispatches.has(fingerprint)) {
        return {
          accepted: true,
          actor_session_id: room.narratorSessionId ?? '',
          message: 'A Narrator beat was already dispatched at this room position; do not repeat it. A later Narrator beat is allowed only after a companion speaks.',
        }
      }
      this.narratorDispatches.add(fingerprint)
      if (this.narratorDispatches.size > 512) {
        const oldest = this.narratorDispatches.values().next().value
        if (oldest !== undefined) this.narratorDispatches.delete(oldest)
      }
      const content = narratorPrompt(this.directory, parent, instruction, evidence)
      let childId = room.narratorSessionId === undefined
        ? SessionId(randomUUID())
        : SessionId(room.narratorSessionId)
      let settlement = this.waitForSettlement(childId, signal)
      try {
        if (room.narratorSessionId === undefined) {
          await this.startNarrator(parent, childId, content, signal)
        } else {
          try {
            await this.ctx.subagents.followup(parent, childId, content, {
              source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
              signal,
            })
          } catch (error) {
            if (!isNotResumable(error)) throw error
            settlement.cancel()
            await this.parkActor(parent, childId)
            await this.directory.unbindNarrator(parent.id, childId)
            childId = SessionId(randomUUID())
            settlement = this.waitForSettlement(childId, signal)
            await this.startNarrator(parent, childId, content, signal)
          }
        }
      } catch (error) {
        settlement.cancel()
        this.ctx.logger.warn(`virtual companion narrator dispatch failed: ${String(error)}`)
        this.appendSystemNarration(parent, '房间里的叙述声短暂停顿了一下。你可以继续说，当前对话仍被完整保留。')
        return {
          accepted: false,
          actor_session_id: '',
          message: 'Narrator recovery notice delivered; do not repeat it or retry in this turn.',
        }
      }
      const outcome = await settlement.promise
      if (outcome.error !== undefined || outcome.cancelled === true || outcome.info === undefined
        || outcome.info.stopReason !== 'completed') {
        this.appendSystemNarration(parent, '旁白的这一段没有顺利落下，但房间仍在等待下一句话。')
        return {
          accepted: false,
          actor_session_id: childId,
          message: 'Narrator recovery notice delivered; do not repeat it or retry in this turn.',
        }
      }
      return {
        accepted: true,
        actor_session_id: childId,
        message: 'Independent Narrator accepted the scene beat. Its prose streams directly; do not restate it.',
      }
    })
  }

  private async startNarrator(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.directory.bindNarrator(parent.id, childId)
    try {
      await this.ctx.subagents.startContinuable({
        provider: 'fork',
        label: '旁白',
        childId,
        request: {
          prompt: content,
          parent,
          persona: narratorPersona(),
          toolFilter: { allow: [] },
        },
        signal,
      })
    } catch (error) {
      await this.directory.unbindNarrator(parent.id, childId)
      throw error
    }
  }

  private async startActor(
    parent: Agent,
    companion: VirtualCompanion,
    childId: SessionId,
    content: ContentBlock[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.directory.bindActor(parent.id, companion.id, childId)
    const releaseVault = this.directory.vaults.bindRuntimeAgent(childId, companion.id)
    try {
      await this.ctx.subagents.startContinuable({
        provider: 'fork',
        label: `虚拟伙伴 · ${companion.name}`,
        childId,
        request: {
          prompt: content,
          parent,
          persona: actorPersona(companion),
          // Hide every inherited/global tool. Child-local room capabilities are
          // registered on agent/created and survive this empty inherited list.
          toolFilter: { allow: [] },
        },
        signal,
      })
    } catch (error) {
      releaseVault()
      await this.directory.unbindActor(parent.id, companion.id, childId)
      throw error
    }
  }

  /** Release one broken actor slot without erasing its durable transcript. */
  private async parkActor(parent: Agent, childId: SessionId): Promise<void> {
    await this.ctx.subagents.drainContinuableChildren(parent, [childId])
  }

  private appendSystemNarration(parent: Agent, text: string): void {
    const normalized = text.trim()
    if (normalized === '') return
    const room = this.directory.room(parent.id)
    const binding: ActorBinding = {
      kind: 'narrator',
      roomSessionId: parent.id,
      epoch: room?.epoch ?? 0,
    }
    this.appendInstantText(
      parent,
      SessionId(room?.narratorSessionId ?? 'narrator-system'),
      binding,
      room?.epoch ?? 0,
      normalized,
    )
  }

  private installActor(
    actor: Agent,
    binding: ActorBinding,
  ): () => void {
    // Narrator prose is mirrored from the child Session's native token stream.
    // It intentionally owns no room tools and can therefore never speak as a
    // companion or mutate companion knowledge.
    if (binding.kind === 'narrator') return () => undefined
    const disposers: Array<() => unknown> = []
    disposers.push(this.directory.vaults.bindRuntimeAgent(actor.id, binding.companionId))
    installAgentVaultTools(actor.ctx)
    const parent = (): Agent => {
      const value = this.ctx.agents.get(SessionId(binding.roomSessionId))
      if (value === undefined) throw new Error('虚拟伙伴房间当前不可用')
      const room = this.directory.room(binding.roomSessionId)
      if (room === undefined || !room.participantIds.includes(binding.companionId)
        || room.actorSessionIds?.[binding.companionId] !== actor.id) {
        throw new Error('伙伴已离开房间，本次消息已丢弃')
      }
      return value
    }
    disposers.push(actor.ctx.tools.register(defineTool({
      name: 'inspect_room_member',
      description: 'Inspect one room member public profile and appearance reference only when their identity or appearance is relevant. This never scans private memory.',
      parameters: { companion_id: { type: 'string', required: true,
        description: 'A companion id from the current room, or owner for the user.' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        found: { type: 'boolean', required: true }, id: { type: 'string', required: true },
        name: { type: 'string', required: true }, profile: { type: 'string', required: true },
        appearance: { type: 'string', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: value.found
        ? `Room member profile resolved: ${value.name}` : value.appearance }] },
      execute: async (args) => {
        const target = parent(); const id = String(args.companion_id)
        if (id === 'owner') return { found: false, id, name: '房主', profile: '',
          appearance: '当前运行时没有向伙伴开放房主头像；不要猜测房主外貌。' }
        const room = this.directory.room(target.id)
        if (room === undefined || !room.participantIds.includes(id)) {
          return { found: false, id, name: '', profile: '', appearance: '该伙伴不在当前房间。' }
        }
        const member = this.directory.companion(id)
        if (member === undefined) return { found: false, id, name: '', profile: '', appearance: '伙伴资料不存在。' }
        const appearance = member.avatar === ''
          ? '尚未提供头像或形象图；不要自行补全外貌。'
          : member.avatar.startsWith('data:')
            ? '已提供可移植的内嵌头像；图像保存在该伙伴 Agent Vault 的 appearance 模块中。'
            : `头像与形象参考：${member.portrait || member.avatar}`
        return { found: true, id, name: member.name,
          profile: `${member.handle}；${member.description}`, appearance }
      },
    })))
    disposers.push(actor.ctx.tools.register(defineTool({
      name: 'express',
      description: 'Express one semantic conversational act at this exact point in your utterance. The Host resolves a fresh non-repeating indexed asset only after you choose the act; this is an output modality, not knowledge retrieval.',
      parameters: {
        act: { type: 'string', required: true, description: 'A free semantic label describing what the resource should express.' },
        role: { type: 'string', enum: ['replace-text', 'amplify-text', 'reply', 'illustrate'] },
        intensity: { type: 'integer', description: 'Expression strength from 1 to 3.' },
        target: { type: 'string', description: 'Who or what this expression addresses.' },
        reply_to: { type: 'string', description: 'Asset id being answered during a reference exchange.' },
        query: { type: 'string', description: 'Optional concrete object or situation, never a preselected asset title.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Open resource tags chosen from the current catalog and combined freely.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        sent: { type: 'boolean', required: true }, asset_id: { type: 'string', required: true }, title: { type: 'string', required: true }, act: { type: 'string', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: value.sent ? `Expression delivered: ${value.title}` : 'No suitable expression asset found; continue naturally.' }] },
      execute: async (args) => {
        const target = parent()
        const companion = this.directory.companion(binding.companionId)
        if (companion === undefined) throw new Error('伙伴资料不存在')
        const state = referenceConversationState(target.session.events, expressionStyle(companion))
        const role: ReferenceExpressionRole = args.role
          ?? (state.pendingReplyTo === undefined ? 'amplify-text' : 'reply')
        const intensity = Math.max(1, Math.min(3, args.intensity ?? 1)) as 1 | 2 | 3
        const intent: ReferenceIntent = {
          act: args.act,
          role,
          intensity,
          ...(args.target === undefined ? {} : { target: args.target }),
          ...(args.reply_to === undefined && state.pendingReplyTo === undefined
            ? {}
            : { replyTo: args.reply_to ?? state.pendingReplyTo }),
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.tags === undefined ? {} : { preferredTags: args.tags }),
        }
        const query = expressionQuery(intent, roomTranscript(this.directory, target))
        const [own, shared] = await Promise.all([
          this.directory.vaults.searchResources({ agentId: binding.companionId, query,
            tags: intent.preferredTags ?? [], roles: ['expression'], limit: 12 }),
          this.directory.vaults.searchResources({ agentId: 'public', query,
            tags: intent.preferredTags ?? [], roles: ['expression'], limit: 12 }),
        ])
        const selected = [...own.items, ...shared.items]
          .find(item => !state.recentAssetIds.includes(item.id))
        if (selected === undefined) {
          return Promise.resolve({ sent: false, asset_id: '', title: '', act: intent.act })
        }
        const room = this.directory.room(binding.roomSessionId)
        target.session.append('companion/expression-intent', {
          version: 1,
          companionId: binding.companionId,
          actorSessionId: actor.id,
          roomEpoch: room?.epoch ?? binding.epoch,
          act: intent.act,
          role,
          intensity,
          ...(intent.target === undefined ? {} : { target: intent.target }),
          ...(intent.replyTo === undefined ? {} : { replyTo: intent.replyTo }),
          assetId: selected.id,
        })
        target.session.append('companion/reference', {
          version: 1, companionId: binding.companionId, actorSessionId: actor.id,
          roomEpoch: room?.epoch ?? binding.epoch,
          assetId: selected.id, title: selected.title,
          mimeType: selected.mimeType, url: this.directory.resourceUrl(selected.agentId, selected.id),
        })
        this.emitted.add(actor.id)
        return Promise.resolve({
          sent: true,
          asset_id: selected.id,
          title: selected.title,
          act: intent.act,
        })
      },
    })))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }

  /** Mirror one independent actor's native token stream into its parent room. */
  handleActorEvent(session: Session, event: SessionEvent): void {
    const binding = this.directory.actorBinding(session.id)
    if (binding === undefined) return
    const room = this.directory.room(binding.roomSessionId)
    const parent = this.ctx.agents.get(SessionId(binding.roomSessionId))
    if (room === undefined || parent === undefined) return
    if (binding.kind === 'companion') {
      if (!room.participantIds.includes(binding.companionId)
        || room.actorSessionIds?.[binding.companionId] !== session.id) return
    } else if (room.narratorSessionId !== session.id) {
      return
    }

    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      const key = `${session.id}:${String(event.data.turn)}:${String(event.data.step)}`
      let stream = this.textStreams.get(key)
      if (stream === undefined) {
        stream = this.openTextStream(parent, session.id, binding, room.epoch ?? binding.epoch)
        this.textStreams.set(key, stream)
      }
      if (event.data.chunk.text !== '') {
        parent.session.append('companion/stream-delta', {
          version: 1,
          streamId: stream.streamId,
          text: event.data.chunk.text,
        })
        this.emitted.add(session.id)
      }
      return
    }

    if (event.type === 'assistant/message') {
      const key = `${session.id}:${String(event.data.turn)}:${String(event.data.step)}`
      const stream = this.textStreams.get(key)
      if (stream !== undefined) {
        this.closeTextStream(key, stream, event.data.interrupted === true)
        return
      }
      // Some adapters provide only the assembled message. Preserve correctness
      // while still using the same room stream protocol.
      const text = event.data.message.content
        .flatMap(block => block.type === 'text' ? [block.text] : [])
        .join('\n')
        .trim()
      if (text !== '' && !/^(完成|已发送|done)[。.!！]?$/iu.test(text)) {
        this.appendInstantText(parent, session.id, binding, room.epoch ?? binding.epoch, text,
          event.data.interrupted === true)
      }
      return
    }

    if (event.type === 'step/end') {
      const key = `${session.id}:${String(event.data.turn)}:${String(event.data.step)}`
      const stream = this.textStreams.get(key)
      if (stream !== undefined) this.closeTextStream(key, stream, true)
    }
  }

  private openTextStream(
    parent: Agent,
    actorSessionId: SessionId,
    binding: ActorBinding,
    roomEpoch: number,
  ): ActorTextStream {
    const streamId = randomUUID()
    parent.session.append('companion/stream-start', {
      version: 1,
      streamId,
      speaker: binding.kind === 'narrator'
        ? { type: 'narrator', actorSessionId }
        : { type: 'companion', companionId: binding.companionId, actorSessionId },
      roomEpoch,
    })
    return { streamId, binding, parent }
  }

  private closeTextStream(key: string, stream: ActorTextStream, interrupted: boolean): void {
    stream.parent.session.append('companion/stream-end', {
      version: 1,
      streamId: stream.streamId,
      ...(interrupted ? { interrupted: true as const } : {}),
    })
    this.textStreams.delete(key)
  }

  private appendInstantText(
    parent: Agent,
    actorSessionId: SessionId,
    binding: ActorBinding,
    roomEpoch: number,
    text: string,
    interrupted = false,
  ): void {
    const stream = this.openTextStream(parent, actorSessionId, binding, roomEpoch)
    parent.session.append('companion/stream-delta', {
      version: 1,
      streamId: stream.streamId,
      text,
    })
    parent.session.append('companion/stream-end', {
      version: 1,
      streamId: stream.streamId,
      ...(interrupted ? { interrupted: true as const } : {}),
    })
    this.emitted.add(actorSessionId)
  }

  /** Completes the matching dispatch and preserves useful output if an actor ignored direct emission. */
  handleSettled(info: SubagentRunEndInfo): void {
    this.fallbackFromSettled(info)
    const queue = this.settlementWaiters.get(info.id)
    const waiter = queue?.shift()
    if (queue?.length === 0) this.settlementWaiters.delete(info.id)
    waiter?.finish({ info })
  }

  private fallbackFromSettled(info: Pick<SubagentRunEndInfo, 'id' | 'lastAssistantMessage'>): void {
    const binding = this.directory.actorBinding(info.id)
    if (binding === undefined) return
    if (this.emitted.delete(info.id)) return
    const text = (info.lastAssistantMessage ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (text === '' || /^(完成|已发送|done)[。.!！]?$/iu.test(text)) return
    const parent = this.ctx.agents.get(SessionId(binding.roomSessionId))
    const room = this.directory.room(binding.roomSessionId)
    if (parent === undefined || room === undefined) return
    if (binding.kind === 'companion' && (!room.participantIds.includes(binding.companionId)
      || room.actorSessionIds?.[binding.companionId] !== info.id)) return
    if (binding.kind === 'narrator' && room.narratorSessionId !== info.id) return
    this.appendInstantText(parent, info.id, binding, room.epoch ?? binding.epoch, text)
  }

  private waitForSettlement(childId: SessionId, signal: AbortSignal): SettlementTicket {
    let finished = false
    let finishPromise!: (outcome: SettlementOutcome) => void
    const promise = new Promise<SettlementOutcome>((resolve) => { finishPromise = resolve })
    const remove = (): void => {
      const queue = this.settlementWaiters.get(childId)
      if (queue === undefined) return
      const next = queue.filter(value => value !== waiter)
      if (next.length === 0) this.settlementWaiters.delete(childId)
      else this.settlementWaiters.set(childId, next)
    }
    const finish = (outcome: SettlementOutcome): void => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      remove()
      finishPromise(outcome)
    }
    const waiter: SettlementWaiter = { finish }
    const abort = (): void => { finish({ error: new Error('伙伴 Agent 调度已取消') }) }
    const timeout = setTimeout(() => {
      finish({ error: new Error('伙伴 Agent 响应超时') })
    }, 300_000)
    const queue = this.settlementWaiters.get(childId) ?? []
    queue.push(waiter)
    this.settlementWaiters.set(childId, queue)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return { promise, cancel: () => { finish({ cancelled: true }) } }
  }

  private async serializeRoom<T>(roomSessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.roomDispatchTails.get(roomSessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.roomDispatchTails.set(roomSessionId, tail)
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (this.roomDispatchTails.get(roomSessionId) === tail) this.roomDispatchTails.delete(roomSessionId)
    }
  }
}
