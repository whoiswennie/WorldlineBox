/** Durable scope binding between one ordinary Session and one Worldline project revision. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-worldline-project'
import type {} from '@deepseek-ai/dsh-worldline-runtime'
import type {
  CanonWorldlineId,
  ProjectId,
  Revision,
  RunId,
} from '@deepseek-ai/dsh-worldline-standard'

/** Describes the worldline conversation binding value exchanged across the package boundary.
 */
export interface WorldlineConversationBinding {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  readonly worldlineId: CanonWorldlineId
  readonly sourceRevision: Revision
  readonly boundAt: string
  readonly runId?: RunId
}

/** Describes the bind worldline conversation request value exchanged across the package boundary.
 */
export interface BindWorldlineConversationRequest {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  readonly runId?: RunId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable creation-time domain scope for a Worldline author conversation. */
    'worldline/context-bound': WorldlineConversationBinding
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { worldlineConversationContexts: WorldlineConversationContexts }
}

/** Read resolve worldline conversation binding from the package-owned authoritative state.
 * @param source - The source supplied by the caller.
 * @returns The result produced by the operation.
 */
export function resolveWorldlineConversationBinding(
  source: Pick<Session, 'events'> | { readonly events: readonly SessionEvent[] },
): WorldlineConversationBinding | undefined {
  let binding: WorldlineConversationBinding | undefined
  for (const event of source.events) {
    if (event.type !== 'worldline/context-bound') continue
    if (binding !== undefined) {
      throw new Error('Worldline conversation contains more than one immutable project binding')
    }
    binding = event.data
  }
  return binding
}

function renderBinding(binding: WorldlineConversationBinding | undefined): string {
  if (binding === undefined) {
    return '当前世界线作者会话尚未绑定项目。在工作室完成绑定前，所有项目创作、构建和 Run 工具都必须拒绝执行。'
  }
  return [
    '当前会话的权威世界线绑定：',
    `- sessionId: ${binding.sessionId}`,
    `- projectId: ${binding.projectId}`,
    `- worldlineId: ${binding.worldlineId}`,
    `- sourceRevisionAtBinding: ${binding.sourceRevision}`,
    ...(binding.runId === undefined ? [] : [`- runId: ${binding.runId}`]),
    '这是结构化 OC 世界线项目，不是普通工作区写作。先加载 worldline-authoring 技能并用 worldline_query 检查项目树；只用 worldline_* 工具在上述 projectId/Run 范围内读写。',
    '开放式世界观创作必须分别完善 Canon、角色、地图、机制和场景；除非用户明确只要说明文，否则单个 Markdown 总结不算完成。',
    '声称可运行前必须完成编译预览，并实际验证冻结蓝图、创建 Run、合法动作、时间推进与事件记录。绑定后的文档预期修订和当前构建摘要始终是并发与冻结权威。',
  ].join('\n')
}

/** Host owner of binding validation, persistence, lookup, and prompt projection. */
export default class WorldlineConversationContexts extends Service {
  static inject = ['agents', 'sessions', 'worldlineProjects', 'worldlineRuns']
  private readonly promptFibers = new Map<Agent, ReturnType<Context['inject']>>()

  constructor(private readonly context: Context) {
    super(context, 'worldlineConversationContexts')
    const install = (agent: Agent): void => {
      if (this.promptFibers.has(agent)) return
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'worldline:conversation-binding',
          order: 100,
          text: () => renderBinding(resolveWorldlineConversationBinding(agent.session)),
        })
      })
      this.promptFibers.set(agent, fiber)
    }
    for (const agent of context.agents.list()) install(agent)
    context.on('agent/created', ({ agent }) => { install(agent) })
    context.on('agent/disposed', ({ agent }) => {
      const fiber = this.promptFibers.get(agent)
      this.promptFibers.delete(agent)
      if (fiber !== undefined) void fiber.dispose()
    })
    context.effect(() => async () => {
      const fibers = [...this.promptFibers.values()]
      this.promptFibers.clear()
      await Promise.all(fibers.map(fiber => fiber.dispose()))
    }, 'worldline conversation prompt bindings')
  }

  /** Return the active Worldline binding for a conversation.
   * @param session - The session supplied by the caller.
   * @returns The result produced by the operation.
   */
  binding(session: Pick<Session, 'events'>): WorldlineConversationBinding | undefined {
    return resolveWorldlineConversationBinding(session)
  }

  /** Bind a conversation to a project and optional Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  async bind(request: BindWorldlineConversationRequest): Promise<WorldlineConversationBinding> {
    const session = this.context.sessions.get(request.sessionId)
    if (session === undefined) throw new Error(`Session is not live: ${request.sessionId}`)
    if (resolveWorldlineConversationBinding(session) !== undefined) {
      throw new Error('Worldline conversation is already bound and cannot be rebound')
    }
    if (session.events.some(event => event.type === 'turn/start')) {
      throw new Error('Worldline conversation must be bound before its first turn')
    }
    const source = await this.context.worldlineProjects.sourceSnapshot(request.projectId)
    if (request.runId !== undefined) {
      const run = await this.context.worldlineRuns.view({ runId: request.runId })
      if (run.summary.projectId !== request.projectId) throw new Error('Run does not belong to the bound project')
    }
    const binding: WorldlineConversationBinding = {
      sessionId: request.sessionId,
      projectId: request.projectId,
      worldlineId: source.manifest.defaultWorldlineId,
      sourceRevision: source.digest as Revision,
      boundAt: new Date().toISOString(),
      ...(request.runId === undefined ? {} : { runId: request.runId }),
    }
    session.append('worldline/context-bound', binding)
    return binding
  }
}

export { WorldlineConversationContexts }
