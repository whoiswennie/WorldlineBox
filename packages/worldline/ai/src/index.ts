import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BlockAssembler,
  errorChain,
  ReasoningEffortId,
  createUserMessage,
  type GenerateOptions,
  type LlmFailure,
  type LlmModelInfo,
  type ResolvedRetryPolicy,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-worldline-runtime'
import { stableStringify, validateContextPack } from '@deepseek-ai/dsh-worldline-standard'
import type {
  AiInvocation,
  CharacterMemory,
  ContextPack,
  ContextPackSection,
  EntityId,
  JsonObject,
  JsonValue,
  ModelPurpose,
  ModelRoute,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type {
  AiDecisionResult,
  ContextPackRequest,
  DecideForActorRequest,
  WorldlineAiCatalog,
  WorldlineAiModel,
  StreamWorldlineTextRequest,
  WorldlineTextChunk,
} from './types.ts'
import { WorldlineAiError } from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { worldlineAi: WorldlineAi }
}

/** Describes the route price value exchanged across the package boundary.
 */
export interface RoutePrice {
  /** Provider identifier matched against the selected model route. */
  readonly provider: string
  /** Provider model identifier matched against the selected model route. */
  readonly model: string
  /** Price per million uncached input tokens in the configured currency. */
  readonly inputPerMillion: number
  /** Price per million generated output tokens in the configured currency. */
  readonly outputPerMillion: number
  /** Price per million cache-read input tokens in the configured currency. */
  readonly cacheReadPerMillion: number
}

/** Describes the config value exchanged across the package boundary.
 */
export interface Config {
  /** Exact provider/model price rows used before the fallback prices. */
  readonly routePrices: readonly RoutePrice[]
  /** Input-token fallback price per million when a route has no exact row. */
  readonly fallbackInputPerMillion: number
  /** Output-token fallback price per million when a route has no exact row. */
  readonly fallbackOutputPerMillion: number
  /** Cache-read fallback price per million when a route has no exact row. */
  readonly fallbackCacheReadPerMillion: number
  /** Maximum durable Run records considered when assembling one context pack. */
  readonly maxContextRecords: number
  /** Minimum logical-time distance before L2 memory is included again. */
  readonly l2MinLogicalInterval: number
}

interface SectionSeed {
  readonly kind: ContextPackSection['kind']
  readonly text: string
  readonly sourceIds: readonly string[]
  readonly priority: number
}

interface ParsedDecision {
  readonly choiceId: string
  readonly rationale: string
  readonly confidence: number
}

interface TextAttempt {
  readonly assembler: BlockAssembler
  readonly output: string
  readonly textOutput: string
  readonly toolCalls: readonly { readonly name: string; readonly arguments: string }[]
  readonly failure?: LlmFailure
}

const EMPTY_MEMORY: CharacterMemory = {
  episodic: [], beliefs: [], goals: [], relationships: [], experience: [], skills: [], reflections: [],
}

function routeForPurpose(
  routes: Readonly<Partial<Record<ModelPurpose, ModelRoute>>>,
  purpose: ModelPurpose,
): ModelRoute | undefined {
  return purpose === 'creative' ? routes.creative ?? routes.narrator : routes[purpose]
}

function creativeToolSystem(tools: readonly { readonly name: string }[]): string {
  const names = new Set(tools.map(tool => tool.name))
  if (names.has('story_propose_state_update')) {
    return 'Use the supplied state-update tool to derive only schema-allowed world, character, and memory changes caused by the saved prose and authoritative records. Keep unaffected fields unchanged, respect each character knowledge boundary, and never invent a later event.'
  }
  if (names.has('story_assess_progress')) {
    return 'Use the supplied progress tool to audit only the current plot point against saved prose and authoritative records. Cite concrete evidence, keep the point active when proof is missing, and never create a new event or state change.'
  }
  return 'Act as the bounded Story Director. Use the supplied planning tool to return scene-aware suggestions or one player-intent proposal. Select only exact Runtime-legal ids from the input; never invent a result or world-state change.'
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function parseDecision(text: string): ParsedDecision | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1]
  const candidate = fenced ?? /\{[\s\S]*\}/u.exec(text)?.[0]
  if (candidate === undefined) return undefined
  try {
    const value = JSON.parse(candidate) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const decision = value as Record<string, unknown>
    if (typeof decision['choiceId'] !== 'string' || typeof decision['rationale'] !== 'string'
      || typeof decision['confidence'] !== 'number' || !Number.isFinite(decision['confidence'])) return undefined
    return {
      choiceId: decision['choiceId'],
      rationale: decision['rationale'].slice(0, 2000),
      confidence: Math.min(1, Math.max(0, decision['confidence'])),
    }
  } catch {
    return undefined
  }
}

function retryDelay(policy: ResolvedRetryPolicy, retry: number): number {
  const exponent = Math.min(Math.max(0, retry - 1), 1024)
  const base = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random()
  return Math.max(1, Math.round(Math.min(base * jitter, policy.maxDelayMs)))
}

function retryable(policy: ResolvedRetryPolicy, failure: LlmFailure, retries: number): boolean {
  if (failure.code === 'ABORTED') return false
  if (policy.mode === 'always') return true
  return retries < policy.maxRetries && policy.retryableCodes.includes(failure.code)
}

function failureFrom(assembler: BlockAssembler, thrown: unknown): LlmFailure | undefined {
  if (assembler.finish.kind === 'error') return assembler.finish.failure
  if (assembler.finish.kind === 'aborted') {
    return { ...assembler.finish.failure, code: 'ABORTED' }
  }
  if (thrown === undefined) return undefined
  if (typeof thrown === 'object' && thrown !== null && 'code' in thrown
    && typeof thrown.code === 'string') {
    return { code: thrown.code, message: errorChain(thrown) }
  }
  // This boundary only surrounds provider iteration. An untyped throw here is a transport
  // failure, not an application exception; finite provider policy still bounds repetition.
  return { code: 'TRANSPORT', message: errorChain(thrown) }
}

/** Bounded one-shot model planner. Runtime remains the only authority that can change world state. */
export default class WorldlineAi extends TypertRemoteService {
  static inject = ['llm', 'tokenMeter', 'worldlineRuns']
  static Config: z<Config> = z.object({
    routePrices: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      inputPerMillion: z.number().min(0).default(0),
      outputPerMillion: z.number().min(0).default(0),
      cacheReadPerMillion: z.number().min(0).default(0),
    })).default([]),
    fallbackInputPerMillion: z.number().min(0).default(30),
    fallbackOutputPerMillion: z.number().min(0).default(60),
    fallbackCacheReadPerMillion: z.number().min(0).default(10),
    maxContextRecords: z.natural().min(10).max(5000).default(500),
    l2MinLogicalInterval: z.number().min(0).default(3600),
  }) as unknown as z<Config>

  private readonly active = new Map<string, number>()

  constructor(private readonly context: Context, private readonly config: Config) {
    super(context, 'worldlineAi')
  }

  /** Return the configured model catalog visible to Worldline routing.
   * @returns The result produced by the operation.
   */
  @Remote('catalog')
  async catalog(): Promise<WorldlineAiCatalog> {
    const providers = this.context.llm.listProviders()
    const groups = await Promise.all(providers.map(async (provider) => {
      const models = await this.context.llm.listModels(provider.id)
      return Promise.all(models.map(model => this.describeModel(model)))
    }))
    return { models: groups.flat() }
  }

  /** Perform context pack through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('contextPack')
  async contextPack(request: ContextPackRequest): Promise<ContextPack> {
    const view = await this.context.worldlineRuns.view({ runId: request.runId })
    const purpose = request.purpose ?? 'character'
    const route = routeForPurpose(view.snapshot.modelPolicy.routes, purpose)
    if (route === undefined) {
      throw new WorldlineAiError('model-route-missing', `no ${purpose} model route is configured for this Run`)
    }
    const info = await this.context.llm.resolveModelInfo(route.provider, route.model)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) {
      throw new WorldlineAiError('context-capacity-unknown', 'the selected model does not publish a context window')
    }
    const reservedOutputTokens = Math.max(1, Math.min(
      request.maxOutputTokens ?? info.defaultMaxTokens ?? 1024,
      Math.floor(contextWindow * 0.2),
    ))
    const reservedToolTokens = Math.max(0, Math.min(
      request.reservedToolTokens ?? 128,
      Math.floor(contextWindow * 0.05),
    ))
    const inputLimit = Math.min(
      Math.floor(contextWindow * 0.75),
      contextWindow - reservedOutputTokens - reservedToolTokens,
    )
    if (inputLimit < 1) {
      throw new WorldlineAiError('context-impossible', 'model reserves leave no safe input capacity')
    }
    const entity = this.entity(view.snapshot.state, request.actorId)
    if (entity === undefined) throw new WorldlineAiError('actor-not-found', `unknown actor: ${request.actorId}`)
    const choices = await this.context.worldlineRuns.choices({
      runId: request.runId,
      actorId: request.actorId,
    })
    const observations = await this.context.worldlineRuns.records({
      runId: request.runId,
      stream: 'observation',
      limit: this.config.maxContextRecords,
    })
    const visibleObservations = observations.records
      .filter(item => item.payload['observerId'] === request.actorId)
      .slice(-40)
    const memory = this.memory(entity)
    const seeds: SectionSeed[] = [
      {
        kind: 'constraints',
        text: 'Choose only one supplied choice. Treat Runtime state as authoritative. Never invent facts, actions, targets or private knowledge.',
        sourceIds: ['runtime:authority-boundary'],
        priority: 100,
      },
      {
        kind: 'identity',
        text: stableStringify({
          actorId: request.actorId,
          type: entity['type'],
          facets: entity['facets'],
          state: entity['state'],
          lod: entity['lod'],
        }),
        sourceIds: [request.actorId],
        priority: 95,
      },
      {
        kind: 'actions',
        text: stableStringify(choices.choices),
        sourceIds: choices.choices.map(choice => choice.id),
        priority: 90,
      },
      {
        kind: 'observation',
        text: stableStringify(visibleObservations.map(item => item.payload)),
        sourceIds: visibleObservations.map(item => item.id),
        priority: 85,
      },
      {
        kind: 'goal',
        text: stableStringify(memory.goals),
        sourceIds: memory.goals.map(item => item.id),
        priority: 80,
      },
      {
        kind: 'memory',
        text: stableStringify({
          episodic: memory.episodic.slice(-30),
          beliefs: memory.beliefs.slice(-40),
          relationships: memory.relationships.slice(-30),
          experience: memory.experience.slice(-30),
          skills: memory.skills.slice(-30),
          reflections: memory.reflections.slice(-20),
        }),
        sourceIds: [
          ...memory.episodic,
          ...memory.beliefs,
          ...memory.relationships,
          ...memory.experience,
          ...memory.skills,
          ...memory.reflections,
        ].map(item => item.id),
        priority: 70,
      },
      {
        kind: 'background',
        text: stableStringify({ logicalTime: view.snapshot.logicalTime, branchId: view.summary.branchId }),
        sourceIds: [`run:${view.summary.runId}:sequence:${String(view.snapshot.sequence)}`],
        priority: 60,
      },
    ]
    const { sections, droppedSourceIds } = this.fitSections(seeds, inputLimit)
    const pack: ContextPack = {
      actorId: request.actorId,
      model: route,
      contextWindow,
      inputLimit,
      reservedOutputTokens,
      reservedToolTokens,
      sections,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
      droppedSourceIds,
    }
    validateContextPack(pack)
    return pack
  }

  /** Route one actor decision through policy, context-capacity, and validation gates.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('decide')
  async decide(request: DecideForActorRequest): Promise<AiDecisionResult> {
    const view = await this.context.worldlineRuns.view({ runId: request.runId })
    const actor = this.entity(view.snapshot.state, request.actorId)
    if (actor === undefined) throw new WorldlineAiError('actor-not-found', `unknown actor: ${request.actorId}`)
    if (actor['lod'] === 'L0' || actor['lod'] === 'L1') {
      return { status: 'deterministic-only', message: 'L0/L1 actors never trigger model calls.' }
    }
    const choices = await this.context.worldlineRuns.choices(request)
    if (choices.choices.length === 0) {
      return { status: 'no-legal-choice', message: 'Runtime projected no legal action choices.' }
    }
    const pack = await this.contextPack(request)
    const recent = (await this.context.worldlineRuns.records({
      runId: request.runId,
      stream: 'ai-invocation',
      limit: 5000,
    })).records.map(item => item.payload as unknown as AiInvocation)
      .filter(item => item.actorId === request.actorId && item.purpose === 'character')
      .at(-1)
    if (actor['lod'] === 'L2' && recent !== undefined
      && view.snapshot.logicalTime - recent.logicalTime < this.config.l2MinLogicalInterval) {
      return {
        status: 'deterministic-only',
        message: 'The L2 actor is inside its low-frequency model cooldown.',
        contextPack: pack,
      }
    }
    return this.callDecision(request, choices.sequence, choices.choices, pack)
  }

  /** Host-only streaming primitive used by authority-constrained narrative and summary services.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  async *streamText(request: StreamWorldlineTextRequest): AsyncIterable<WorldlineTextChunk> {
    validateContextPack(request.contextPack)
    let route = request.contextPack.model
    if (route.reasoningEffort === undefined
      && (request.purpose === 'narrator' || request.purpose === 'summary'
        || (request.tools?.length ?? 0) > 0)) {
      const model = await this.context.llm.resolveModelInfo(route.provider, route.model)
      if (model.reasoning?.efforts.some(effort => effort.id === 'off')) {
        route = { ...route, reasoningEffort: 'off' }
      }
    }
    const message = createUserMessage({
      source: {
        kind: 'plugin',
        plugin: 'worldline-ai',
        form: 'snapshot',
        sections: request.contextPack.sections.map(section => ({ name: section.kind, text: section.text })),
      },
      content: [{
        type: 'text',
        text: request.contextPack.sections.map(section => `## ${section.kind}\n${section.text}`).join('\n\n'),
      }],
    })
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
      messages: [message],
      system: request.purpose === 'summary'
        ? 'Summarize only supplied authoritative records. Add no facts.'
        : request.purpose === 'creative'
          ? request.tools !== undefined && request.tools.length > 0
            ? creativeToolSystem(request.tools)
            : 'Follow the supplied bounded planning contract. Return only the requested JSON. Select only exact legal choice IDs from the input; never create an action, parameter, result, or world-state change.'
          : request.tools !== undefined && request.tools.length > 0
            ? 'Use only the supplied presentation tools, in story order, to stage the requested bounded visual interactive fiction. Each call is one player-revealed unit. Tool calls may present known facts but cannot mutate world state. Never invent an actor id, media cue, durable fact, location change, relationship change, item, injury, or completed result.'
            : 'Write only the requested bounded visual-interactive-fiction story blocks. Preserve the exact narration/dialogue/thought/action tags and exact legal actor IDs. You may stage dialogue, body language and sensory detail consistent with known character profiles, but never invent durable world-state changes.',
      ...(request.tools === undefined ? {} : { tools: [...request.tools] }),
      maxTokens: request.contextPack.reservedOutputTokens,
      temperature: request.temperature ?? 0.6,
    }
    const policy = this.context.llm.providerRetryPolicy(route.provider)
    let retries = 0
    while (true) {
      const attempt = await this.textAttempt(request.runId, options, request.maxCharacters)
      const invocation = await this.recordInvocation(
        { runId: request.runId, actorId: request.actorId },
        route,
        request.contextPack,
        attempt.assembler.usage,
        attempt.output,
        attempt.failure === undefined ? 'completed' : 'failed',
        request.purpose,
      )
      if (attempt.failure === undefined) {
        if (attempt.textOutput !== '') yield { type: 'text-delta', text: attempt.textOutput }
        for (const tool of attempt.toolCalls) yield { type: 'tool-call', ...tool }
        yield {
          type: 'finish',
          invocation: invocation.invocation,
          output: attempt.output,
        }
        return
      }
      if (!retryable(policy, attempt.failure, retries)) {
        throw new WorldlineAiError(
          'model-retry-exhausted',
          `模型连接在 ${String(retries + 1)} 次尝试后仍失败（${attempt.failure.code}）：${attempt.failure.message}`,
        )
      }
      retries += 1
      const localDelay = retryDelay(policy, retries)
      const requestedDelay = attempt.failure.providerRetryAfterMs
      const delayMs = requestedDelay !== undefined && requestedDelay <= policy.maxDelayMs
        ? Math.max(1, Math.round(requestedDelay))
        : localDelay
      yield {
        type: 'retry',
        attempt: retries + 1,
        ...(policy.mode === 'normal' ? { maxAttempts: policy.maxRetries + 1 } : {}),
        delayMs,
        failure: { code: attempt.failure.code, message: attempt.failure.message },
      }
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  private async textAttempt(
    runId: string,
    options: GenerateOptions,
    maxCharacters: number | undefined,
  ): Promise<TextAttempt> {
    const assembler = new BlockAssembler()
    let thrown: unknown
    this.active.set(runId, (this.active.get(runId) ?? 0) + 1)
    try {
      for await (const chunk of this.context.llm.stream(options)) assembler.push(chunk)
    } catch (error) {
      thrown = error
    } finally {
      const next = Math.max(0, (this.active.get(runId) ?? 1) - 1)
      if (next === 0) this.active.delete(runId)
      else this.active.set(runId, next)
    }
    const failure = failureFrom(assembler, thrown)
    let blocks: ReturnType<BlockAssembler['blocks']> = []
    try {
      blocks = assembler.blocks()
    } catch (error) {
      return {
        assembler,
        output: '',
        textOutput: '',
        toolCalls: [],
        failure: { code: 'TRANSPORT', message: errorChain(error) },
      }
    }
    const rawText = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const textOutput = (maxCharacters === undefined
      ? rawText
      : rawText.slice(0, Math.max(1, maxCharacters))).trim()
    const toolCalls = blocks.flatMap(block => block.type === 'tool-call'
      ? [{ name: block.name, arguments: block.arguments }]
      : [])
    const toolOutput = toolCalls.map(tool => stableStringify(tool))
    const output = [...(textOutput === '' ? [] : [textOutput]), ...toolOutput].join('\n')
    return { assembler, output, textOutput, toolCalls, ...(failure === undefined ? {} : { failure }) }
  }

  private async describeModel(model: LlmModelInfo): Promise<WorldlineAiModel> {
    try {
      const exact = await this.context.llm.resolveModelInfo(model.provider, model.id)
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(exact.context?.contextWindow === undefined ? {} : { contextWindow: exact.context.contextWindow }),
        ...(exact.defaultMaxTokens === undefined ? {} : { maxOutputTokens: exact.defaultMaxTokens }),
        reasoningEfforts: exact.reasoning?.efforts.map(item => item.id) ?? [],
      }
    } catch {
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        reasoningEfforts: [],
      }
    }
  }

  private entity(state: JsonObject, actorId: EntityId): JsonObject | undefined {
    return record(record(state['entities'])?.[actorId])
  }

  private memory(entity: JsonObject): CharacterMemory {
    const value = record(entity['memory'])
    return value === undefined ? EMPTY_MEMORY : value as unknown as CharacterMemory
  }

  private tokens(text: string): number {
    return this.context.tokenMeter.estimateMessage(createUserMessage({
      source: { kind: 'plugin', plugin: 'worldline-ai' },
      content: [{ type: 'text', text }],
    }))
  }

  private fitSections(seeds: readonly SectionSeed[], limit: number): {
    readonly sections: readonly ContextPackSection[]
    readonly droppedSourceIds: readonly string[]
  } {
    const sections: ContextPackSection[] = []
    const droppedSourceIds: string[] = []
    let remaining = limit
    for (const seed of [...seeds].sort((left, right) => right.priority - left.priority)) {
      const fullTokens = this.tokens(seed.text)
      if (fullTokens <= remaining) {
        sections.push({ ...seed, tokens: fullTokens })
        remaining -= fullTokens
        continue
      }
      const text = this.trimToTokens(seed.text, remaining)
      if (text === '') {
        droppedSourceIds.push(...seed.sourceIds)
        continue
      }
      const tokens = this.tokens(text)
      sections.push({ ...seed, text, tokens })
      remaining -= tokens
      droppedSourceIds.push(...seed.sourceIds)
    }
    return { sections, droppedSourceIds: [...new Set(droppedSourceIds)] }
  }

  private trimToTokens(text: string, limit: number): string {
    if (limit <= 0) return ''
    let low = 0
    let high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = `${text.slice(0, middle)}…`
      if (this.tokens(candidate) <= limit) low = middle
      else high = middle - 1
    }
    return low === 0 ? '' : `${text.slice(0, low)}…`
  }

  private price(route: ModelRoute): {
    readonly price: RoutePrice
    readonly source: 'route' | 'conservative-fallback'
  } {
    const configured = this.config.routePrices.find(item => (
      item.provider === route.provider && item.model === route.model
    ))
    return configured === undefined
      ? {
        price: {
          provider: route.provider,
          model: route.model,
          inputPerMillion: this.config.fallbackInputPerMillion,
          outputPerMillion: this.config.fallbackOutputPerMillion,
          cacheReadPerMillion: this.config.fallbackCacheReadPerMillion,
        },
        source: 'conservative-fallback',
      }
      : { price: configured, source: 'route' }
  }

  private estimatedCost(
    route: ModelRoute,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
  ): { readonly cost: number; readonly source: 'route' | 'conservative-fallback' } {
    const { price, source } = this.price(route)
    return {
      cost: (
        inputTokens * price.inputPerMillion
        + outputTokens * price.outputPerMillion
        + cacheReadTokens * price.cacheReadPerMillion
      ) / 1_000_000,
      source,
    }
  }

  private async callDecision(
    request: DecideForActorRequest,
    expectedSequence: number,
    choices: Awaited<ReturnType<Context['worldlineRuns']['choices']>>['choices'],
    pack: ContextPack,
  ): Promise<AiDecisionResult> {
    const route = pack.model
    const message = createUserMessage({
      source: { kind: 'plugin', plugin: 'worldline-ai', form: 'snapshot', sections: pack.sections.map(section => ({
        name: section.kind,
        text: section.text,
      })) },
      content: [{ type: 'text', text: pack.sections.map(section => (
        `## ${section.kind}\n${section.text}`
      )).join('\n\n') }],
    })
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
      messages: [message],
      system: 'Return only JSON: {"choiceId":"...","rationale":"...","confidence":0..1}. Choose exactly one listed choice. Do not create world facts.',
      maxTokens: pack.reservedOutputTokens,
      temperature: 0.2,
    }
    const policy = this.context.llm.providerRetryPolicy(route.provider)
    let retries = 0
    let invocation: Awaited<ReturnType<WorldlineAi['recordInvocation']>>
    let output = ''
    while (true) {
      const attempt = await this.textAttempt(request.runId, options, undefined)
      invocation = await this.recordInvocation(
        request,
        route,
        pack,
        attempt.assembler.usage,
        attempt.output,
        attempt.failure === undefined ? 'completed' : 'failed',
      )
      output = attempt.output
      if (attempt.failure === undefined) break
      if (!retryable(policy, attempt.failure, retries)) {
        return {
          status: 'model-failed',
          message: `The model call failed after ${String(retries + 1)} attempts: ${attempt.failure.message}; deterministic Runtime remains active.`,
          contextPack: pack,
          invocation: invocation.invocation,
        }
      }
      retries += 1
      const requestedDelay = attempt.failure.providerRetryAfterMs
      const delayMs = requestedDelay !== undefined && requestedDelay <= policy.maxDelayMs
        ? Math.max(1, Math.round(requestedDelay))
        : retryDelay(policy, retries)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
    const parsed = parseDecision(output)
    const choice = parsed === undefined ? undefined : choices.find(item => item.id === parsed.choiceId)
    if (parsed === undefined || choice === undefined) {
      return {
        status: 'invalid-output',
        message: 'The model did not select one legal Runtime choice.',
        contextPack: pack,
        invocation: invocation.invocation,
      }
    }
    const parameters = choice.parameters
    const recorded = await this.context.worldlineRuns.recordAiIntent({
      runId: request.runId,
      actorId: request.actorId,
      invocationId: invocation.invocation.id,
      choiceId: choice.id,
      actionType: choice.actionType,
      parameters,
      rationale: parsed.rationale,
      confidence: parsed.confidence,
      modelRoute: route,
      contextSourceIds: pack.sections.flatMap(section => section.sourceIds),
    })
    try {
      const action = await this.context.worldlineRuns.submitAction({
        runId: request.runId,
        actorId: request.actorId,
        type: choice.actionType,
        parameters,
        expectedSequence,
        controller: 'agent',
      })
      return {
        status: 'submitted',
        message: 'The recorded intent passed Runtime validation and started an Action.',
        contextPack: pack,
        invocation: invocation.invocation,
        intent: recorded.intent,
        action,
      }
    } catch (error) {
      return {
        status: 'conflict',
        message: error instanceof Error ? error.message : String(error),
        contextPack: pack,
        invocation: invocation.invocation,
        intent: recorded.intent,
      }
    }
  }

  private async recordInvocation(
    request: DecideForActorRequest,
    route: ModelRoute,
    pack: ContextPack,
    usage: TokenUsage | undefined,
    output: string,
    outcome: AiInvocation['outcome'],
    purpose: AiInvocation['purpose'] = 'character',
  ): ReturnType<Context['worldlineRuns']['recordAiInvocation']> {
    const inputTokens = usage?.inputTokens ?? pack.totalTokens
    const outputTokens = usage?.outputTokens ?? this.tokens(output)
    const cacheReadTokens = usage?.cacheReadTokens ?? 0
    const cost = this.estimatedCost(route, inputTokens, outputTokens, cacheReadTokens).cost
    return this.context.worldlineRuns.recordAiInvocation({
      runId: request.runId,
      purpose,
      actorId: request.actorId,
      modelRoute: route,
      contextSourceIds: pack.sections.flatMap(section => section.sourceIds),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      estimatedCost: cost,
      outputDigest: createHash('sha256').update(output).digest('hex'),
      outcome,
    })
  }
}

export { WorldlineAi }
