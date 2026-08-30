/** Independent, continuable virtual-companion actors and coordinator dispatch. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentVaultService, VaultResource } from '@deepseek-ai/dsh-agent-vault'
import type {} from '@deepseek-ai/dsh-account-profile'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
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
  rankExpressionCandidates,
  referenceConversationState,
} from './reference-expression.ts'

type ActorBinding =
  | { kind: 'companion'; roomSessionId: string; companionId: string; epoch: number }
  | { kind: 'narrator'; roomSessionId: string; epoch: number }

interface ActorDirectory {
  readonly vaults: AgentVaultService
  resourceUrl(agentId: string, resourceId: string): string
  appearance(companionId: string): Promise<{ resource: VaultResource; hostPath?: string } | undefined>
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

interface TrustedImageValue {
  readonly path: string
  readonly image: {
    readonly attachmentId: string
    readonly mediaType: ImageMediaType
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' as const, required: true },
    mediaType: { type: 'string' as const, required: true,
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' as const, required: true },
    width: { type: 'integer' as const, required: true },
    height: { type: 'integer' as const, required: true },
    name: { type: 'string' as const },
  },
} as const

function imageMediaType(path: string, declared?: string): ImageMediaType | undefined {
  if (declared === 'image/png' || declared === 'image/jpeg'
    || declared === 'image/webp' || declared === 'image/gif') return declared
  const extension = extname(path).toLocaleLowerCase('en-US')
  return extension === '.png' ? 'image/png'
    : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
      : extension === '.webp' ? 'image/webp'
        : extension === '.gif' ? 'image/gif' : undefined
}

async function trustedImage(ctx: Context, path: string, declared?: string): Promise<TrustedImageValue | undefined> {
  const attachments = ctx.get('attachments')
  const mediaType = imageMediaType(path, declared)
  if (attachments === undefined || mediaType === undefined
    || !attachments.imageLimits.mediaTypes.includes(mediaType)) return undefined
  const data = await readFile(path)
  const reference = await attachments.saveImage({ data, mediaType, name: basename(path) })
  return { path, image: {
    attachmentId: reference.attachmentId,
    mediaType: reference.mediaType,
    bytes: reference.bytes,
    width: reference.width,
    height: reference.height,
    ...(reference.name === undefined ? {} : { name: reference.name }),
  } }
}

function imageReference(value: TrustedImageValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(value.attachmentId), mediaType: value.mediaType,
    bytes: value.bytes, width: value.width, height: value.height,
    ...(value.name === undefined ? {} : { name: value.name }),
  }
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
    '你拥有确定的自身形象资源。用户询问你的外观时，先调用 inspect_self_appearance 取得真实图像再描述；用户要求发送你的形象图时，调用 show_self_appearance，绝不能用普通表情包替代。',
    '引用资源与自然语言是同级的表达动作，包括图片、GIF、视频、音频、文本、外链和未来扩展的 MIME 类型，不等同于表情包。需要挑选时，先用 expression_search 取得至多 5 个候选，再按真实语境把一个或多个 asset_id 交给 express；候选只是反馈，不是命令。',
    '检索时要从多个互补维度组织关键词：资源原名或别名、情绪与语气、动作与对象、适用场景、作品/角色/来源、媒体类型。不要只把名字机械拆词，也不要只搜抽象情绪；用户点名某个资源时，必须把名称原样放进 named_title。',
    '在闲聊、撒娇、玩笑、安慰、庆祝或其他有明显情绪的时刻，像真实聊天一样主动穿插合适素材，不必等用户提醒；严肃任务中不要强行发送。不要先调用 resource_find 或扫描资源目录。',
    '你可以选一个、多个、全部候选、重复近期用过的素材，或决定不发；近期记录只是帮助你判断，不是禁令。也可以在简单低风险语境直接让 express 自动选择。不要用 Emoji、颜文字或文字假装真实资源。',
    '若已经用真实表情完整表达，就不要再输出“已发送”“完成”等内部收尾；若还要说话，直接写自然台词。',
    '知识、记忆与能力问题先用 memory_recall / procedure_recall 得到方向，再用 vault_read / memory_explore 渐进深入；只有确实要了解某项资源元数据时才使用 resource_find。短期记忆会立刻参与召回；不要全库扫描。你不能读取或修改其他伙伴的私有 Vault。',
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
  // A single model turn can produce hundreds of token/tool events. Keep enough
  // raw history to retain several real conversational turns, then bound the
  // semantic transcript below so retrieval context stays small.
  return parent.session.events.slice(-5_000).flatMap((event) => {
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
  }).slice(-80).join('\n').slice(-12_000)
}

const DIFFERENT_RESOURCE_CUE = /换(?:个|一(?:个|张)|张)|另(?:一个|一张)|别的|不同(?:的|一张|一个)|不要(?:这|刚才|上一)(?:张|个)?|别再发这/iu
const EXPLICIT_REFERENCE_REQUEST_CUE = /(?:发|发送|播放|放一下|放一个|来一个|来一张|来一段|给我看|给我来|引用|分享)/iu

function latestRoomUserText(parent: Agent): string {
  for (let index = parent.session.events.length - 1; index >= 0; index -= 1) {
    const event = parent.session.events[index]
    if (event?.type !== 'user/message') continue
    return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
  }
  return ''
}

function normalizedReferenceName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * Resolve a resource explicitly named by the user against the bounded search/catalog candidates.
 * This is a deterministic guardrail for direct requests, not a semantic selection policy: ordinary
 * contextual use remains entirely under the companion Agent's control.
 */
function explicitlyNamedReference(
  userText: string,
  candidates: readonly VaultResource[],
): VaultResource | undefined {
  if (!EXPLICIT_REFERENCE_REQUEST_CUE.test(userText)) return undefined
  const normalizedUserText = normalizedReferenceName(userText)
  return [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()]
    .filter((candidate) => {
      const title = normalizedReferenceName(candidate.title)
      return title.length >= 2 && normalizedUserText.includes(title)
    })
    .sort((left, right) => normalizedReferenceName(right.title).length
      - normalizedReferenceName(left.title).length)[0]
}

function actorPrompt(
  directory: ActorDirectory,
  parent: Agent,
  companion: VirtualCompanion,
  self: string,
  appearance: string,
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
      appearance,
      '',
      `<reference-channel mode="${channel.mode}" exchange-depth="${String(channel.exchangeDepth)}"${channel.pendingReplyTo === undefined ? '' : ` pending-reply-to="${channel.pendingReplyTo}"`}>`,
      `recent-acts=${channel.recentActs.join(',') || 'none'}`,
      '</reference-channel>',
      '请以你自己的真实角色反应参与当前对话。普通文字直接自然回答；闲聊中出现清晰情绪时可以主动使用引用资源。需要挑选或用户点名时，先用 expression_search 获取 5 个以内候选，再把你真正想用的一个或多个 asset_id 交给 express；简单语境也可让 express 自动选择。不要先用 resource_find，也不会预先注入完整目录。你能看到谁说了什么；自然承接紧邻消息，不要复述整个历史。',
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

  /**
   * Install.
   * @param agent - Agent that owns the operation.
   */
  install(agent: Agent): void {
    if (this.installed.has(agent)) return
    const binding = this.directory.actorBinding(agent.id)
    const dispose = binding === undefined ? this.installCoordinator(agent) : this.installActor(agent, binding)
    if (dispose !== undefined) this.installed.set(agent, dispose)
  }

  /**
   * Dispose.
   * @param agent - Agent that owns the operation.
   */
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

  /**
   * Record membership.
   * @param parent - parent value.
   * @param before - before value.
   * @param after - after value.
   * @param actor - actor value.
   */
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
          const appearance = await this.directory.appearance(companion.id)
          const appearanceContext = appearance === undefined
            ? '自身形象资源：尚未提供；不要猜测外观，也不要用表情包冒充。'
            : [
              `自身形象资源 ID：${appearance.resource.id}`,
              appearance.hostPath === undefined
                ? '自身形象文件路径：当前资源只有可发送地址，不能声称已经视觉查看。'
                : `自身形象文件路径：${appearance.hostPath}（需要了解画面时使用 inspect_self_appearance）`,
              '需要把本人形象发到房间时使用 show_self_appearance；不要从 expression_search 挑选替代图。',
            ].join('\n')
          const content = actorPrompt(
            this.directory,
            parent,
            companion,
            self.compiled,
            appearanceContext,
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
    // The child Agent Context is a real Cordis scope. Installing the Vault
    // package directly on it bypasses the package's inject declaration: the
    // registrations appear, but their deferred execute closures are denied
    // when they later read `ctx.agentVaults`. Own the installation with a
    // dependency-declared Fiber so reads and disposal both follow Cordis.
    const vaultTools = actor.ctx.inject(
      ['agentVaults', 'tools', 'systemPrompt'],
      (scope) => { installAgentVaultTools(scope) },
    )
    disposers.push(() => vaultTools.dispose())
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
    let lastReferenceSearch: { userText: string; candidates: VaultResource[] } | undefined
    const discoverExpressions = async (target: Agent, intent: ReferenceIntent, limit = 5) => {
      const companion = this.directory.companion(binding.companionId)
      if (companion === undefined) throw new Error('伙伴资料不存在')
      const state = referenceConversationState(target.session.events, expressionStyle(companion))
      const transcript = roomTranscript(this.directory, target)
      const userText = latestRoomUserText(target)
      const query = intent.assetTitle ?? expressionQuery(intent, transcript)
      const shouldSearchUserRequest = EXPLICIT_REFERENCE_REQUEST_CUE.test(userText)
      const [own, shared, ownCatalog, sharedCatalog, userOwn, userShared] = await Promise.all([
        this.directory.vaults.searchResources({ agentId: binding.companionId, query,
          tags: intent.preferredTags ?? [], roles: ['expression'], limit: 12 }),
        this.directory.vaults.searchResources({ agentId: 'public', query,
          tags: intent.preferredTags ?? [], roles: ['expression'], limit: 12 }),
        this.directory.vaults.searchResources({
          agentId: binding.companionId, query: '', tags: [], roles: ['expression'], limit: 64,
        }),
        this.directory.vaults.searchResources({
          agentId: 'public', query: '', tags: [], roles: ['expression'], limit: 64,
        }),
        shouldSearchUserRequest
          ? this.directory.vaults.searchResources({
            agentId: binding.companionId, query: userText, tags: [], roles: ['expression'], limit: 12,
          })
          : Promise.resolve({ items: [] as VaultResource[] }),
        shouldSearchUserRequest
          ? this.directory.vaults.searchResources({
            agentId: 'public', query: userText, tags: [], roles: ['expression'], limit: 12,
          })
          : Promise.resolve({ items: [] as VaultResource[] }),
      ])
      const allCandidates = [
        ...own.items, ...shared.items, ...userOwn.items, ...userShared.items,
        ...ownCatalog.items, ...sharedCatalog.items,
      ]
      const namedCandidate = explicitlyNamedReference(userText, allCandidates)
      const rankedIntent = namedCandidate === undefined
        ? intent
        : { ...intent, assetTitle: namedCandidate.title }
      // "换一个" is an explicit constraint on this turn, not a global cooldown. Respect it only
      // when another enabled candidate exists; ordinary conversation may freely repeat assets.
      const wantsDifferent = DIFFERENT_RESOURCE_CUE.test(userText)
      const filteredCandidates = wantsDifferent && allCandidates.some(
        candidate => !state.recentAssetIds.includes(candidate.id),
      )
        ? allCandidates.filter(candidate => !state.recentAssetIds.includes(candidate.id))
        : allCandidates
      return {
        state,
        namedCandidate,
        candidates: rankExpressionCandidates(
          filteredCandidates,
          rankedIntent,
          state.recentAssetIds,
          binding.companionId,
          transcript.slice(-600),
          limit,
        ),
      }
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
        image: IMAGE_VALUE_SCHEMA,
      } }, render: (_args, value) => [
        { type: 'text', text: value.found ? `Room member profile resolved: ${value.name}. ${value.appearance}` : value.appearance },
        ...(value.image === undefined ? [] : [{ type: 'image' as const, attachment: imageReference(value.image) }]),
      ] },
      execute: async (args) => {
        const target = parent(); const id = args.companion_id
        if (id === 'owner') {
          const owner = actor.ctx.get('localAccountProfile')?.current()
          if (owner === undefined) return { found: false, id, name: '房主', profile: '',
            appearance: '当前运行时没有可用的房主资料；不要猜测房主外貌。' }
          const image = owner.avatarPath === undefined ? undefined : await trustedImage(actor.ctx, owner.avatarPath)
          return { found: true, id, name: owner.displayName,
            profile: `${owner.username}；${owner.bio}`,
            appearance: owner.avatarPath === undefined
              ? '房主没有提供可查看的头像；不要猜测外貌。'
              : image === undefined
                ? `房主头像文件路径：${owner.avatarPath}，但当前模型链路无法载入图像；不要猜测画面。`
                : `房主头像文件路径：${owner.avatarPath}；真实图像随本工具结果提供。`,
            ...(image === undefined ? {} : { image: image.image }) }
        }
        const room = this.directory.room(target.id)
        if (room === undefined || !room.participantIds.includes(id)) {
          return { found: false, id, name: '', profile: '', appearance: '该伙伴不在当前房间。' }
        }
        const member = this.directory.companion(id)
        if (member === undefined) {
          return { found: false, id, name: '', profile: '', appearance: '伙伴资料不存在。' }
        }
        const registered = await this.directory.appearance(id)
        const image = registered?.hostPath === undefined
          ? undefined
          : await trustedImage(actor.ctx, registered.hostPath, registered.resource.mimeType)
        const appearance = registered === undefined
          ? '尚未提供头像或形象图；不要自行补全外貌。'
          : image === undefined
            ? '已登记形象资源，但当前模型链路无法载入图像；不要猜测画面。'
            : `形象文件路径：${registered.hostPath}；真实图像随本工具结果提供。`
        return { found: true, id, name: member.name,
          profile: `${member.handle}；${member.description}`, appearance,
          ...(image === undefined ? {} : { image: image.image }) }
      },
    })))
    disposers.push(actor.ctx.tools.register(defineTool({
      name: 'inspect_self_appearance',
      description: 'Load your own registered appearance as an actual image for visual inspection. Use before describing what you look like; this does not send the image to the room.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        found: { type: 'boolean', required: true }, message: { type: 'string', required: true },
        path: { type: 'string', required: true }, image: IMAGE_VALUE_SCHEMA,
      } }, render: (_args, value) => [
        { type: 'text', text: value.message },
        ...(value.image === undefined ? [] : [{ type: 'image' as const, attachment: imageReference(value.image) }]),
      ] },
      execute: async () => {
        const appearance = await this.directory.appearance(binding.companionId)
        if (appearance?.hostPath === undefined) return {
          found: false, path: '', message: 'No Host-readable self appearance is available; do not guess visual details.',
        }
        const image = await trustedImage(actor.ctx, appearance.hostPath, appearance.resource.mimeType)
        if (image === undefined) return {
          found: false, path: appearance.hostPath,
          message: 'The registered self appearance could not be loaded on this model route; do not guess visual details.',
        }
        return {
          found: true, path: image.path, image: image.image,
          message: `Registered self appearance loaded from ${image.path}. Describe only details visible in the adjacent image.`,
        }
      },
    })))
    disposers.push(actor.ctx.tools.register(defineTool({
      name: 'show_self_appearance',
      description: 'Send your own registered appearance image to the room. Use this exact tool when the user asks to see or receive your avatar, portrait, character image, or appearance; never substitute an expression resource.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        sent: { type: 'boolean', required: true }, asset_id: { type: 'string', required: true },
        title: { type: 'string', required: true }, message: { type: 'string', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: value.message }] },
      execute: async () => {
        const target = parent()
        const appearance = await this.directory.appearance(binding.companionId)
        if (appearance === undefined) return {
          sent: false, asset_id: '', title: '',
          message: 'No registered self appearance is available; explain this naturally without substituting another resource.',
        }
        const room = this.directory.room(binding.roomSessionId)
        target.session.append('companion/reference', {
          version: 1, companionId: binding.companionId, actorSessionId: actor.id,
          roomEpoch: room?.epoch ?? binding.epoch,
          assetId: appearance.resource.id, title: appearance.resource.title,
          mimeType: appearance.resource.mimeType,
          url: this.directory.resourceUrl(appearance.resource.agentId, appearance.resource.id),
        })
        this.emitted.add(actor.id)
        return {
          sent: true, asset_id: appearance.resource.id, title: appearance.resource.title,
          message: `Your registered appearance was delivered: ${appearance.resource.title}. Do not announce completion; continue naturally only if prose is useful.`,
        }
      },
    })))
    disposers.push(actor.ctx.tools.register(defineTool({
      name: 'expression_search',
      description: 'Return up to five private/public reference-resource candidates across images, GIFs, video, audio, text, links and extension MIME types. Search from complementary dimensions: exact title/alias, emotion/tone, action/object, use scene, work/character/source and media type. Do not mechanically split only the title. Recent use is disclosed but never forbidden.',
      parameters: {
        keywords: { type: 'array', required: true, items: { type: 'string' },
          description: 'Two to twelve complementary natural-language keywords spanning meaning, mood, action, scene, source and media type; not a full sentence.' },
        named_title: { type: 'string', description: 'The verbatim resource title or alias when the user names one. Preserve it as a whole; do not split or paraphrase it.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        candidates: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
          properties: {
            asset_id: { type: 'string', required: true }, title: { type: 'string', required: true },
            scope: { type: 'string', required: true }, mime_type: { type: 'string', required: true },
            tags: { type: 'array', required: true, items: { type: 'string' } },
            recently_used: { type: 'boolean', required: true },
            exact_match: { type: 'boolean', required: true },
          } } },
      } }, render: (_args, value) => [{ type: 'text', text: value.candidates.length === 0
        ? 'No reference-resource candidates found.'
        : `Reference-resource candidates: ${value.candidates.map(candidate =>
          `${candidate.exact_match ? '[exact named match] ' : ''}${candidate.title} `
          + `(${candidate.asset_id}; ${candidate.mime_type}; tags: ${candidate.tags.join('/')})`).join(', ')}` }] },
      execute: async (args) => {
        const target = parent()
        const keywords = args.keywords.map(value => value.trim()).filter(Boolean).slice(0, 12)
        const intent: ReferenceIntent = {
          act: keywords.join(' '),
          query: keywords.join(' '),
          preferredTags: keywords,
          ...(args.named_title === undefined ? {} : { assetTitle: args.named_title }),
        }
        const found = await discoverExpressions(target, intent, 5)
        lastReferenceSearch = { userText: latestRoomUserText(target), candidates: found.candidates }
        return { candidates: found.candidates.map(candidate => ({
          asset_id: candidate.id,
          title: candidate.title,
          scope: candidate.agentId,
          mime_type: candidate.mimeType,
          tags: [...candidate.tags].slice(0, 12),
          recently_used: found.state.recentAssetIds.includes(candidate.id),
          exact_match: candidate.id === found.namedCandidate?.id
            || (args.named_title !== undefined
              && normalizedReferenceName(candidate.title) === normalizedReferenceName(args.named_title)),
        })) }
      },
    })))
    disposers.push(actor.ctx.tools.register(defineTool({
      name: 'express',
      description: 'Send one or more chosen reference resources at this exact point as part of natural speech. Any indexed MIME type is allowed. Pass asset_ids returned by expression_search for full control, including multiple resources and deliberate repeats; omit them only for a quick automatic single choice. A resource explicitly named by the user takes precedence over a mismatched id.',
      parameters: {
        act: { type: 'string', required: true, description: 'A free semantic label describing what the resource should express.' },
        asset_ids: { type: 'array', items: { type: 'string' }, description: 'One to five candidate ids selected from expression_search, in delivery order.' },
        role: { type: 'string', enum: ['replace-text', 'amplify-text', 'reply', 'illustrate'] },
        intensity: { type: 'integer', description: 'Expression strength from 1 to 3.' },
        target: { type: 'string', description: 'Who or what this expression addresses.' },
        reply_to: { type: 'string', description: 'Asset id being answered during a reference exchange.' },
        query: { type: 'string', description: 'Optional concrete object or situation for quick automatic matching.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Open resource tags chosen from the current catalog and combined freely.' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        sent: { type: 'boolean', required: true }, asset_id: { type: 'string', required: true }, title: { type: 'string', required: true }, act: { type: 'string', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: value.sent ? `Reference resource delivered: ${value.title}` : 'No suitable reference resource found; continue naturally.' }] },
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
        const userText = latestRoomUserText(target)
        const wantsDifferent = DIFFERENT_RESOURCE_CUE.test(userText)
        let namedCandidate = lastReferenceSearch?.userText === userText
          ? explicitlyNamedReference(userText, lastReferenceSearch.candidates)
          : undefined
        if (namedCandidate === undefined && EXPLICIT_REFERENCE_REQUEST_CUE.test(userText)) {
          const namedSearch = await discoverExpressions(target, {
            ...intent,
            query: [userText, intent.query ?? ''].filter(Boolean).join(' '),
          }, 5)
          namedCandidate = namedSearch.namedCandidate
        }
        const modelRequestedIds = [...new Set(
          (args.asset_ids ?? []).map(value => value.trim()).filter(Boolean),
        )]
        // A direct request such as “发一下孤高曼波” is a deterministic user constraint. It may
        // override a model-selected sticker, while ordinary contextual selection stays free.
        const requestedIds = (namedCandidate === undefined ? modelRequestedIds : [namedCandidate.id])
          .filter(id => namedCandidate !== undefined
            || !wantsDifferent || !state.recentAssetIds.includes(id))
          .slice(0, 5)
        const selected: VaultResource[] = []
        if (requestedIds.length > 0) {
          for (const id of requestedIds) {
            let resource
            try { resource = await this.directory.vaults.resource(binding.companionId, id) } catch {
              try { resource = await this.directory.vaults.resource('public', id) } catch { continue }
            }
            if (resource.enabled && resource.roles.includes('expression')) selected.push(resource)
          }
        } else {
          const found = await discoverExpressions(target, intent, 1)
          const automatic = found.candidates[0]
          if (automatic !== undefined) selected.push(automatic)
        }
        if (selected.length === 0) {
          return Promise.resolve({ sent: false, asset_id: '', title: '', act: intent.act })
        }
        const room = this.directory.room(binding.roomSessionId)
        for (const resource of selected) {
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
            assetId: resource.id,
          })
          target.session.append('companion/reference', {
            version: 1, companionId: binding.companionId, actorSessionId: actor.id,
            roomEpoch: room?.epoch ?? binding.epoch,
            assetId: resource.id, title: resource.title,
            mimeType: resource.mimeType, url: this.directory.resourceUrl(resource.agentId, resource.id),
          })
        }
        this.emitted.add(actor.id)
        return Promise.resolve({
          sent: true,
          asset_id: selected[0]?.id ?? '',
          title: selected.map(resource => resource.title).join('、'),
          act: intent.act,
        })
      },
    })))
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }

  /**
   *  Mirror one independent actor's native token stream into its parent room.
   * @param session - Session that owns the operation.
   * @param event - event value.
   */
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

  /**
   *  Completes the matching dispatch and preserves useful output if an actor ignored direct emission.
   * @param info - info value.
   */
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
