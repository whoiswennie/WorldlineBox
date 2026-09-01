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

export interface WorldlineConversationBinding {
  readonly sessionId: SessionId
  readonly projectId: ProjectId
  readonly worldlineId: CanonWorldlineId
  readonly sourceRevision: Revision
  readonly boundAt: string
  readonly runId?: RunId
}

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

export function resolveWorldlineConversationBinding(
  source: Pick<Session, 'events'> | { readonly events: readonly SessionEvent[] },
): WorldlineConversationBinding | undefined {
  for (let index = source.events.length - 1; index >= 0; index -= 1) {
    const event = source.events[index]
    if (event?.type === 'worldline/context-bound') return event.data
  }
  return undefined
}

function renderBinding(binding: WorldlineConversationBinding | undefined): string {
  if (binding === undefined) {
    return 'This Worldline author Session is not bound to a project. Project-scoped authoring, build, and Run tools must fail closed until the Studio creates a bound Session.'
  }
  return [
    'Authoritative Worldline conversation binding:',
    `- sessionId: ${binding.sessionId}`,
    `- projectId: ${binding.projectId}`,
    `- worldlineId: ${binding.worldlineId}`,
    `- sourceRevisionAtBinding: ${binding.sourceRevision}`,
    ...(binding.runId === undefined ? [] : [`- runId: ${binding.runId}`]),
    'Keep every project and Run operation inside this binding. Document-level expected revisions and current build digests remain authoritative after binding.',
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

  binding(session: Pick<Session, 'events'>): WorldlineConversationBinding | undefined {
    return resolveWorldlineConversationBinding(session)
  }

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
