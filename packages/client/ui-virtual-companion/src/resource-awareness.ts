/** Step-local, model-free discovery of relevant durable knowledge. */
import { createHash } from 'node:crypto'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { KnowledgeDiscoveryResult, KnowledgeVault } from './knowledge-vault.ts'

const NAME = 'resource-awareness'
const MAX_SIGNAL_CHARS = 8_000
const MAX_PREVIEW_CHARS = 240
const MAX_INSPECT_CHARS = 1_600

interface AwarenessState {
  signalFingerprint?: string
  manifestFingerprint?: string
}

const states = new WeakMap<Agent, AwarenessState>()

function messageText(message: Pick<UserMessage, 'content'>): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function nestedText(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return []
  if (typeof value === 'string') return []
  if (Array.isArray(value)) return value.flatMap(item => nestedText(item, depth + 1))
  if (typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const own = typeof record['text'] === 'string' ? [record['text']] : []
  return [...own, ...Object.entries(record)
    .filter(([key]) => key !== 'text' && key !== 'source')
    .flatMap(([, item]) => nestedText(item, depth + 1))]
}

function sessionSignals(agent: Agent): string[] {
  return agent.session.events.slice(-80).flatMap((event) => {
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'plugin' && source.plugin === NAME) return []
      return [messageText(event.data)]
    }
    if (event.type === 'tool/result') return nestedText(event.data)
    if (event.type === 'companion/stream-delta') return [event.data.text]
    if (event.type === 'companion/reference') return [event.data.title]
    return []
  })
}

function signalFor(agent: Agent, messages: readonly UserMessage[]): string {
  return [...sessionSignals(agent), ...messages.map(messageText)]
    .filter(Boolean)
    .join('\n')
    .slice(-MAX_SIGNAL_CHARS)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

function compact(value: string, maximum: number): string {
  const text = value.trim().replace(/\s+/gu, ' ')
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function renderManifest(
  vault: KnowledgeVault,
  candidates: readonly KnowledgeDiscoveryResult[],
): Promise<string> {
  const rendered: string[] = ['<resource-awareness version="1">']
  for (const [index, candidate] of candidates.entries()) {
    rendered.push(
      `<knowledge-candidate rank="${String(index + 1)}" confidence="${candidate.confidence}" scope="${xml(candidate.scope)}" path="${xml(candidate.path)}" revision="${xml(candidate.revision)}" reason="${xml(candidate.reasons.join(','))}">`,
      `<title>${xml(candidate.title)}</title>`,
      `<matched>${xml(candidate.matchedTerms.join('、'))}</matched>`,
      `<preview>${xml(compact(candidate.summary, MAX_PREVIEW_CHARS))}</preview>`,
    )
    if (index === 0 && candidate.confidence === 'high') {
      const document = await vault.read(candidate.scope, candidate.path, 'top')
      rendered.push(`<inspected view="top">${xml(compact(document.content, MAX_INSPECT_CHARS))}</inspected>`)
    }
    rendered.push('</knowledge-candidate>')
  }
  rendered.push('</resource-awareness>')
  return rendered.join('\n')
}

/** Dependencies and scope authority for one Agent's automatic knowledge discovery. */
export interface KnowledgeAwarenessOptions {
  readonly knowledge: KnowledgeVault
  readonly scopes: readonly string[]
  readonly ready?: Promise<void>
  readonly onError?: (error: unknown) => void
}

/**
 * Add a compact, durable resource fact at every changed pre-step. The listener never adds
 * behavioral instructions and never exposes another actor's private scope.
 * @param agent - Exact Agent scope receiving awareness snapshots.
 * @param options - Vault, scope authority, readiness, and error observer.
 * @returns Disposer for the scoped pre-step listener.
 */
export function installKnowledgeAwareness(
  agent: Agent,
  options: KnowledgeAwarenessOptions,
): () => void {
  const state = states.get(agent) ?? {}
  states.set(agent, state)
  return agent.ctx.on('agent/pre-step', async (
    { agent: subject, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    try {
      await options.ready
      const signalText = signalFor(subject, decision.messages)
      const signalFingerprint = digest(`${options.scopes.join(',')}\n${signalText}`)
      if (state.signalFingerprint === signalFingerprint) return decision
      const candidates = options.knowledge.discover(options.scopes, signalText, 3)
      if (candidates.length === 0) {
        state.signalFingerprint = signalFingerprint
        return decision
      }
      const manifestFingerprint = digest(candidates
        .map(candidate => `${candidate.scope}:${candidate.path}:${candidate.revision}:${candidate.confidence}`)
        .join('\n'))
      if (state.manifestFingerprint === manifestFingerprint) return decision
      const text = await renderManifest(options.knowledge, candidates)
      state.signalFingerprint = signalFingerprint
      state.manifestFingerprint = manifestFingerprint
      const content: ContentBlock[] = [{ type: 'text', text }]
      return {
        kind: 'enter',
        messages: [...decision.messages, createUserMessage({
          content,
          source: {
            kind: 'plugin',
            plugin: NAME,
            form: 'snapshot',
            sections: [{ name: `${NAME}:${manifestFingerprint}`, text }],
          },
        })],
      }
    } catch (error) {
      options.onError?.(error)
      return decision
    }
  }, { prepend: true })
}
