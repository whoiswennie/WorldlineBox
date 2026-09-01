import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BlockAssembler,
  ReasoningEffortId,
  createUserMessage,
  type LlmModelInfo,
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
  ModelRoute,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type {
  AiBudgetRequest,
  AiBudgetStatus,
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

export interface RoutePrice {
  readonly provider: string
  readonly model: string
  readonly inputPerMillion: number
  readonly outputPerMillion: number
  readonly cacheReadPerMillion: number
}

export interface Config {
  readonly routePrices: readonly RoutePrice[]
  readonly fallbackInputPerMillion: number
  readonly fallbackOutputPerMillion: number
  readonly fallbackCacheReadPerMillion: number
  readonly maxContextRecords: number
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

const EMPTY_MEMORY: CharacterMemory = {
  episodic: [], beliefs: [], goals: [], relationships: [], experience: [], skills: [], reflections: [],
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

  @Remote('catalog')
  async catalog(): Promise<WorldlineAiCatalog> {
    const providers = this.context.llm.listProviders()
    const groups = await Promise.all(providers.map(async (provider) => {
      const models = await this.context.llm.listModels(provider.id)
      return Promise.all(models.map(model => this.describeModel(model)))
    }))
    return { models: groups.flat() }
  }

  @Remote('contextPack')
  async contextPack(request: ContextPackRequest): Promise<ContextPack> {
    const view = await this.context.worldlineRuns.view({ runId: request.runId })
    const purpose = request.purpose ?? 'character'
    const route = view.snapshot.modelPolicy.routes[purpose]
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

  @Remote('budget')
  async budget(request: AiBudgetRequest): Promise<AiBudgetStatus> {
    const view = await this.context.worldlineRuns.view({ runId: request.runId })
    const purpose = request.purpose ?? 'character'
    const route = view.snapshot.modelPolicy.routes[purpose]
    const pack = request.contextPack ?? (route === undefined ? undefined : await this.contextPack(request))
    const invocations = (await this.context.worldlineRuns.records({
      runId: request.runId,
      stream: 'ai-invocation',
      limit: 5000,
    })).records.map(item => item.payload as unknown as AiInvocation)
    const budget = view.snapshot.aiBudget
    const logicalDay = Math.floor(view.snapshot.logicalTime / 86_400)
    const logicalCalls = invocations.filter(item => Math.floor(item.logicalTime / 86_400) === logicalDay).length
    const hourAgo = Date.now() - 3_600_000
    const realHourCalls = invocations.filter(item => Date.parse(item.recordedAt) >= hourAgo).length
    const activeCalls = this.active.get(request.runId) ?? 0
    const priced = route === undefined
      ? { cost: 0, source: 'conservative-fallback' as const }
      : this.estimatedCost(route, pack?.totalTokens ?? 0, pack?.reservedOutputTokens ?? 0, 0)
    const reasons: string[] = []
    if (!view.snapshot.modelPolicy.aiEnabled) reasons.push('AI is paused for this Run.')
    if (route === undefined) reasons.push(`No ${purpose} model route is configured.`)
    if (view.snapshot.aiUsage.calls >= budget.maxCalls) reasons.push('Call budget is exhausted.')
    if (view.snapshot.aiUsage.inputTokens + (pack?.totalTokens ?? 0) > budget.maxInputTokens) {
      reasons.push('Input-token budget is exhausted.')
    }
    if (view.snapshot.aiUsage.outputTokens + (pack?.reservedOutputTokens ?? 0) > budget.maxOutputTokens) {
      reasons.push('Output-token budget is exhausted.')
    }
    if (logicalCalls >= budget.maxCallsPerLogicalDay) reasons.push('Logical-day call budget is exhausted.')
    if (realHourCalls >= budget.maxCallsPerRealHour) reasons.push('Real-hour call budget is exhausted.')
    if (activeCalls >= budget.maxConcurrent) reasons.push('Concurrent-call budget is exhausted.')
    if (view.snapshot.aiUsage.estimatedCost + priced.cost > budget.maxEstimatedCost) {
      reasons.push('Estimated monetary budget is exhausted.')
    }
    return {
      runId: request.runId,
      allowed: reasons.length === 0,
      reasons,
      ...(route === undefined ? {} : { route }),
      activeCalls,
      callsRemaining: Math.max(0, budget.maxCalls - view.snapshot.aiUsage.calls),
      inputTokensRemaining: Math.max(0, budget.maxInputTokens - view.snapshot.aiUsage.inputTokens),
      outputTokensRemaining: Math.max(0, budget.maxOutputTokens - view.snapshot.aiUsage.outputTokens),
      logicalDayCallsRemaining: Math.max(0, budget.maxCallsPerLogicalDay - logicalCalls),
      realHourCallsRemaining: Math.max(0, budget.maxCallsPerRealHour - realHourCalls),
      estimatedNextCost: priced.cost,
      estimatedCostRemaining: Math.max(0, budget.maxEstimatedCost - view.snapshot.aiUsage.estimatedCost),
      pricing: priced.source,
    }
  }

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
    const budget = await this.budget({ ...request, contextPack: pack })
    if (!budget.allowed || budget.route === undefined) {
      return { status: 'budget-blocked', message: budget.reasons.join(' '), contextPack: pack, budget }
    }
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
        budget,
      }
    }
    return this.callDecision(request, choices.sequence, choices.choices, pack, budget)
  }

  /** Host-only streaming primitive used by authority-constrained narrative and summary services. */
  async *streamText(request: StreamWorldlineTextRequest): AsyncIterable<WorldlineTextChunk> {
    validateContextPack(request.contextPack)
    const budget = await this.budget({
      runId: request.runId,
      actorId: request.actorId,
      purpose: request.purpose === 'creative' ? 'narrator' : request.purpose,
      contextPack: request.contextPack,
    })
    if (!budget.allowed || budget.route === undefined) {
      yield { type: 'blocked', budget }
      return
    }
    const route = budget.route
    const assembler = new BlockAssembler()
    let thrown: unknown
    this.active.set(request.runId, (this.active.get(request.runId) ?? 0) + 1)
    try {
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
      for await (const chunk of this.context.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
        messages: [message],
        system: request.purpose === 'summary'
          ? 'Summarize only supplied authoritative records. Add no facts.'
          : 'Write prose using only supplied WorldEvents, Observations and SceneFrame. Add no facts, secrets, participants or state changes.',
        maxTokens: request.contextPack.reservedOutputTokens,
        temperature: request.temperature ?? 0.6,
      })) {
        assembler.push(chunk)
        if (chunk.type === 'text-delta' && chunk.text !== '') {
          yield { type: 'text-delta', text: chunk.text }
        }
      }
    } catch (error) {
      thrown = error
    } finally {
      const next = Math.max(0, (this.active.get(request.runId) ?? 1) - 1)
      if (next === 0) this.active.delete(request.runId)
      else this.active.set(request.runId, next)
    }
    const output = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const failed = thrown !== undefined || assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted'
    const invocation = await this.recordInvocation(
      { runId: request.runId, actorId: request.actorId },
      route,
      request.contextPack,
      assembler.usage,
      output,
      failed ? 'failed' : 'completed',
      request.purpose,
    )
    yield {
      type: 'finish',
      invocation: invocation.invocation,
      budgetExceeded: invocation.budgetExceeded,
    }
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

  private price(route: ModelRoute): { readonly price: RoutePrice; readonly source: AiBudgetStatus['pricing'] } {
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
  ): { readonly cost: number; readonly source: AiBudgetStatus['pricing'] } {
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
    budget: AiBudgetStatus,
  ): Promise<AiDecisionResult> {
    const route = budget.route
    if (route === undefined) throw new WorldlineAiError('model-route-missing', 'character model route disappeared')
    this.active.set(request.runId, (this.active.get(request.runId) ?? 0) + 1)
    const assembler = new BlockAssembler()
    let thrown: unknown
    try {
      const message = createUserMessage({
        source: { kind: 'plugin', plugin: 'worldline-ai', form: 'snapshot', sections: pack.sections.map(section => ({
          name: section.kind,
          text: section.text,
        })) },
        content: [{ type: 'text', text: pack.sections.map(section => (
          `## ${section.kind}\n${section.text}`
        )).join('\n\n') }],
      })
      for await (const chunk of this.context.llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
        messages: [message],
        system: 'Return only JSON: {"choiceId":"...","rationale":"...","confidence":0..1}. Choose exactly one listed choice. Do not create world facts.',
        maxTokens: pack.reservedOutputTokens,
        temperature: 0.2,
      })) assembler.push(chunk)
    } catch (error) {
      thrown = error
    } finally {
      const next = Math.max(0, (this.active.get(request.runId) ?? 1) - 1)
      if (next === 0) this.active.delete(request.runId)
      else this.active.set(request.runId, next)
    }
    const output = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const failed = thrown !== undefined || assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted'
    const invocation = await this.recordInvocation(
      request,
      route,
      pack,
      assembler.usage,
      output,
      failed ? 'failed' : 'completed',
    )
    if (failed) {
      return {
        status: 'model-failed',
        message: thrown instanceof Error ? thrown.message : 'The model call failed; deterministic Runtime remains active.',
        contextPack: pack,
        budget,
        invocation: invocation.invocation,
      }
    }
    if (invocation.budgetExceeded) {
      return {
        status: 'budget-blocked',
        message: 'Actual model usage exhausted the Run budget; the proposal was retained but not applied.',
        contextPack: pack,
        budget,
        invocation: invocation.invocation,
      }
    }
    const parsed = parseDecision(output)
    const choice = parsed === undefined ? undefined : choices.find(item => item.id === parsed.choiceId)
    if (parsed === undefined || choice === undefined) {
      return {
        status: 'invalid-output',
        message: 'The model did not select one legal Runtime choice.',
        contextPack: pack,
        budget,
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
        budget,
        invocation: invocation.invocation,
        intent: recorded.intent,
        action,
      }
    } catch (error) {
      return {
        status: 'conflict',
        message: error instanceof Error ? error.message : String(error),
        contextPack: pack,
        budget,
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
