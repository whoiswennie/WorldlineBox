import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-worldline-ai'
import type {} from '@deepseek-ai/dsh-worldline-runtime'
import type {
  CheckpointView,
  RunView,
  SubmitRunActionResult,
} from '@deepseek-ai/dsh-worldline-runtime/types'
import { stableStringify, validateContextPack, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import type {
  ContextPack,
  ContextPackSection,
  JsonObject,
  JsonValue,
  NarrativeBeat,
  Observation,
  SceneFrame,
  StoryStageRenderer,
  WorldEvent,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type {
  BranchTextPlayRequest,
  ChooseTextActionRequest,
  FreeTextActionRequest,
  FreeTextActionResult,
  NarrateRequest,
  NarrativeStreamChunk,
  RephraseRequest,
  RetryTextActionRequest,
  SaveTextPlayRequest,
  StoryStageStatus,
  TextPlayRequest,
  TextPlayView,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { worldlineNarrative: WorldlineNarrative }
}

interface NarrativeSources {
  readonly events: readonly WorldEvent[]
  readonly observations: readonly Observation[]
}

interface TextChoice {
  readonly id: string
  readonly actionType: string
  readonly label: string
  readonly description: string
}

const INTENT_ALIASES: readonly [RegExp, RegExp][] = [
  [/(?:^|\.)(?:move|travel|teleport)$/u, /(?:去|前往|走|移动|赶往|进入|抵达|传送|travel|move|go|walk|enter)/iu],
  [/(?:attack|fight|combat|strike|slay)/u, /(?:攻击|战斗|迎战|打|击败|杀死|屠龙|attack|fight|strike|slay)/iu],
  [/(?:work|craft|gather)/u, /(?:工作|劳动|干活|制作|采集|收集|work|craft|gather)/iu],
  [/(?:speak|talk|dialog|ask)/u, /(?:说|交谈|对话|询问|告诉|talk|speak|ask)/iu],
  [/(?:rest|sleep|wait)/u, /(?:休息|睡觉|等待|歇|rest|sleep|wait)/iu],
]

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function longestSharedTerm(input: string, candidate: string): number {
  const shorter = input.length <= candidate.length ? input : candidate
  const longer = input.length <= candidate.length ? candidate : input
  for (let size = Math.min(12, shorter.length); size >= 2; size -= 1) {
    for (let start = 0; start + size <= shorter.length; start += 1) {
      if (longer.includes(shorter.slice(start, start + size))) return size
    }
  }
  return 0
}

function intentScore(input: string, choice: TextChoice): number {
  const text = normalizedText(input)
  const id = normalizedText(choice.id)
  const action = normalizedText(choice.actionType)
  const label = normalizedText(choice.label)
  const description = normalizedText(choice.description)
  if (text === id || text === action || text === label) return 1_000
  let score = 0
  if (label.includes(text) || description.includes(text)) score += 200
  if (text.includes(label) || text.includes(description)) score += 160
  const shared = Math.max(longestSharedTerm(text, label), longestSharedTerm(text, description))
  if (shared >= 2) score += shared * 20
  for (const [actionPattern, inputPattern] of INTENT_ALIASES) {
    if (actionPattern.test(choice.actionType) && inputPattern.test(input)) score += 30
  }
  return score
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/** Text-play projection. It can phrase retained facts but has no world mutation primitive of its own. */
export default class WorldlineNarrative extends TypertRemoteService {
  static inject = ['worldlineRuns', 'worldlineAi', 'llm', 'tokenMeter']

  private readonly renderers = new Map<string, StoryStageRenderer>()

  constructor(private readonly context: Context) {
    super(context, 'worldlineNarrative')
  }

  /** Perform register renderer through the package's public contract.
   * @param renderer - The renderer supplied by the caller.
   * @returns The result produced by the operation.
   */
  registerRenderer(renderer: StoryStageRenderer): () => void {
    const effect = this.context.effect(function* (this: WorldlineNarrative) {
      if (this.renderers.has(renderer.id)) throw new Error(`StoryStage renderer already exists: ${renderer.id}`)
      this.renderers.set(renderer.id, renderer)
      yield () => { this.renderers.delete(renderer.id) }
    }.bind(this), 'worldlineNarrative.registerRenderer()')
    return () => void effect()
  }

  /** Return the current text-play scene.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('scene')
  async scene(request: TextPlayRequest): Promise<SceneFrame> {
    const [view, spatial] = await Promise.all([
      this.context.worldlineRuns.view({ runId: request.runId }),
      this.context.worldlineRuns.spatial({ runId: request.runId }),
    ])
    const entities = object(view.snapshot.state['entities'])
    const actor = object(entities?.[request.actorId])
    if (actor === undefined) throw new Error(`unknown actor: ${request.actorId}`)
    const actorState = object(actor['state']) ?? {}
    const place = typeof actorState['locationId'] === 'string'
      ? worldlineId<'map-node'>(actorState['locationId'])
      : undefined
    const presentEntityIds = Object.entries(entities ?? {}).flatMap(([id, value]) => {
      const state = object(object(value)?.['state'])
      return place !== undefined && state?.['locationId'] === place
        ? [worldlineId<'entity'>(id)]
        : []
    })
    const present = Object.fromEntries(presentEntityIds.map((id) => {
      const entity = object(entities?.[id])
      const state = object(entity?.['state'])
      return [id, {
        type: entity?.['type'] ?? 'entity',
        locationId: state?.['locationId'] ?? null,
        lod: entity?.['lod'] ?? 'L0',
      }]
    }))
    const visibleIds = new Set(presentEntityIds)
    const placeName = place === undefined
      ? undefined
      : spatial.map?.nodes.find(node => node.id === place)?.name
    return {
      logicalTime: view.snapshot.logicalTime,
      ...(place === undefined ? {} : { placeId: place }),
      presentEntityIds,
      visibleState: {
        self: { id: request.actorId, type: actor['type'] ?? 'entity', state: actorState },
        present,
        ...(place === undefined ? {} : { place: { id: place, name: placeName ?? place } }),
      },
      activeProcesses: view.snapshot.processes.filter(process => (
        process.action.actorId === request.actorId || visibleIds.has(process.action.actorId)
      )),
      media: [],
    }
  }

  /** Open a text-play session for a Run and actor.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('open')
  async open(request: TextPlayRequest): Promise<TextPlayView> {
    const [run, frame, choices, beatsPage, saves] = await Promise.all([
      this.context.worldlineRuns.view({ runId: request.runId }),
      this.scene(request),
      this.context.worldlineRuns.choices(request),
      this.context.worldlineRuns.records({
        runId: request.runId,
        stream: 'narrative-beat',
        limit: 200,
      }),
      this.context.worldlineRuns.checkpoints({ runId: request.runId }),
    ])
    return {
      run,
      frame,
      choices,
      beats: beatsPage.records.map(item => item.payload as unknown as NarrativeBeat),
      saves,
    }
  }

  /** Produce the next narration from authoritative Run records.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('narrate')
  async narrate(request: NarrateRequest): Promise<NarrativeBeat> {
    let beat: NarrativeBeat | undefined
    for await (const chunk of this.narrateStream(request)) {
      if (chunk.type === 'beat') beat = chunk.beat
    }
    if (beat === undefined) throw new Error('narrative stream ended without a retained beat')
    return beat
  }

  /** Perform narrate stream through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  async *narrateStream(request: NarrateRequest): AsyncIterable<NarrativeStreamChunk> {
    const frame = await this.scene(request)
    const sources = await this.sources(request)
    const camera = request.camera ?? 'limited-third-person'
    let streamed = false
    if (!request.templateOnly) {
      try {
        const pack = await this.narratorPack(request, frame, sources)
        let text = ''
        let invocationId: NarrativeBeat['invocationId']
        let route = pack.model
        let exhausted = false
        for await (const chunk of this.context.worldlineAi.streamText({
          runId: request.runId,
          actorId: request.actorId,
          purpose: 'narrator',
          contextPack: pack,
        })) {
          if (chunk.type === 'text-delta') {
            text += chunk.text
            streamed = true
            yield { type: 'text-delta', text: chunk.text }
          }
          if (chunk.type === 'finish') {
            invocationId = chunk.invocation.id
            route = chunk.invocation.modelRoute
            exhausted = chunk.budgetExceeded
          }
          if (chunk.type === 'blocked') exhausted = true
        }
        if (!exhausted && invocationId !== undefined && text.trim() !== '') {
          const recorded = await this.context.worldlineRuns.recordNarrativeBeat({
            runId: request.runId,
            invocationId,
            eventIds: sources.events.map(event => event.id),
            observationIds: sources.observations.map(observation => observation.id),
            camera,
            text,
            media: frame.media,
            style: 'llm',
            modelRoute: route,
          })
          yield { type: 'beat', beat: recorded.beat }
          return
        }
      } catch {
        // A narrator outage degrades to an event-bound template; Runtime remains live.
      }
    }
    const text = this.template(frame, sources)
    yield { type: streamed ? 'replace' : 'text-delta', text }
    const recorded = await this.context.worldlineRuns.recordNarrativeBeat({
      runId: request.runId,
      eventIds: sources.events.map(event => event.id),
      observationIds: sources.observations.map(observation => observation.id),
      camera,
      text,
      media: frame.media,
      style: 'template',
    })
    yield { type: 'beat', beat: recorded.beat }
  }

  /** Submit one listed text-play choice.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('choose')
  async choose(request: ChooseTextActionRequest): Promise<SubmitRunActionResult> {
    const projected = await this.context.worldlineRuns.choices(request)
    if (projected.sequence !== request.expectedSequence) throw new Error('行动选项已经变化，请刷新当前场景。')
    const choice = projected.choices.find(item => item.id === request.choiceId)
    if (choice === undefined) throw new Error('这个行动在当前世界状态中不可执行。')
    await this.context.worldlineRuns.setControl({
      runId: request.runId,
      actorId: request.actorId,
      mode: 'player',
    })
    return this.context.worldlineRuns.submitAction({
      runId: request.runId,
      actorId: request.actorId,
      type: choice.actionType,
      parameters: choice.parameters,
      expectedSequence: request.expectedSequence,
      controller: 'player',
    })
  }

  /** Perform free input through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('freeInput')
  async freeInput(request: FreeTextActionRequest): Promise<FreeTextActionResult> {
    const text = request.text.trim()
    const projected = await this.context.worldlineRuns.choices(request)
    const scored = projected.choices.map(choice => ({ choice, score: intentScore(text, choice) }))
    const best = Math.max(0, ...scored.map(item => item.score))
    const candidates = scored.filter(item => item.score === best && item.score > 0).map(item => item.choice)
    if (candidates.length !== 1) {
      return { status: candidates.length === 0 ? 'unmatched' : 'ambiguous', candidates }
    }
    const candidate = candidates[0]
    if (candidate === undefined) throw new Error('matched choice disappeared')
    const action = await this.choose({ ...request, choiceId: candidate.id })
    return { status: 'submitted', candidates, action }
  }

  /** Rephrase presentation text without changing Run state.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('rephrase')
  async rephrase(request: RephraseRequest): Promise<NarrativeBeat> {
    const records = await this.context.worldlineRuns.records({
      runId: request.runId,
      stream: 'narrative-beat',
      limit: 5000,
    })
    const beat = records.records.map(item => item.payload as unknown as NarrativeBeat)
      .find(item => item.id === request.beatId)
    if (beat === undefined) throw new Error('narrative beat was not found')
    return this.narrate({
      ...request,
      eventIds: beat.eventIds,
      observationIds: beat.observationIds,
      camera: request.camera ?? beat.camera,
    })
  }

  /** Save the current text-play scene as a checkpoint.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('save')
  save(request: SaveTextPlayRequest): Promise<CheckpointView> {
    return this.context.worldlineRuns.checkpoint({ runId: request.runId, label: request.label })
  }

  /** Branch text play from a saved checkpoint.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('branch')
  branch(request: BranchTextPlayRequest): Promise<RunView> {
    return this.context.worldlineRuns.branch({
      runId: request.runId,
      checkpointId: request.checkpointId,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    })
  }

  /** Retry narration from the latest authoritative Run state.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('retry')
  async retry(request: RetryTextActionRequest): Promise<SubmitRunActionResult> {
    const branch = await this.branch(request)
    await this.context.worldlineRuns.setControl({
      runId: branch.summary.runId,
      actorId: request.actorId,
      mode: 'player',
    })
    const choices = await this.context.worldlineRuns.choices({
      runId: branch.summary.runId,
      actorId: request.actorId,
    })
    const choice = choices.choices.find(item => item.id === request.choiceId)
    if (choice === undefined) throw new Error('retry choice is not legal on the explicit branch')
    return this.choose({
      runId: branch.summary.runId,
      actorId: request.actorId,
      choiceId: choice.id,
      expectedSequence: choices.sequence,
    })
  }

  /** Perform story stage through the package's public contract.
   * @returns The result produced by the operation.
   */
  @Remote('storyStage')
  storyStage(): StoryStageStatus {
    const renderers = [{
      id: 'worldline-text-story',
      name: '内置文字故事舞台',
      capabilities: [] as readonly string[],
    }, ...[...this.renderers.values()].map(renderer => ({
      id: renderer.id,
      name: renderer.name,
      capabilities: [...renderer.capabilities],
    }))]
    return {
      available: true,
      renderers,
      message: this.renderers.size === 0
        ? '内置中文文字故事舞台已就绪；可随时继续接入立绘、背景和音频演出器。'
        : '内置文字故事舞台与扩展演出器均已就绪。',
    }
  }

  private async sources(request: NarrateRequest): Promise<NarrativeSources> {
    const [eventPage, observationPage] = await Promise.all([
      this.context.worldlineRuns.records({ runId: request.runId, stream: 'world-event', limit: 200 }),
      this.context.worldlineRuns.records({ runId: request.runId, stream: 'observation', limit: 200 }),
    ])
    const requestedEvents = request.eventIds === undefined ? undefined : new Set(request.eventIds)
    const requestedObservations = request.observationIds === undefined
      ? undefined
      : new Set(request.observationIds)
    const events = eventPage.records.map(item => item.payload as unknown as WorldEvent)
      .filter(event => requestedEvents?.has(event.id)
        ?? (event.visibleTo.includes(request.actorId) || event.participantIds.includes(request.actorId)))
      .slice(-20)
    const observations = observationPage.records.map(item => item.payload as unknown as Observation)
      .filter(observation => observation.observerId === request.actorId
        && (requestedObservations?.has(observation.id) ?? true))
      .slice(-40)
    return { events, observations }
  }

  private template(frame: SceneFrame, sources: NarrativeSources): string {
    const latest = sources.events.at(-1)
    if (latest === undefined) {
      return `世界时间 ${String(frame.logicalTime)}。四周暂时安静，没有新的可见事件发生。`
    }
    const placeState = object(frame.visibleState['place'])
    const place = typeof placeState?.['name'] === 'string'
      ? placeState['name']
      : frame.placeId === undefined ? '尚未标明的地点' : frame.placeId
    const event = ({
      'action.proposed': '有人作出了行动决定',
      'action.started': '一项行动已经开始',
      'action.completed': '一项行动已经完成',
      'system.effects-committed': '世界规则推动了局势变化',
    } as Record<string, string>)[latest.type] ?? `发生了“${latest.type}”事件`
    return `世界时间 ${String(frame.logicalTime)}，${place}：${event}。`
  }

  private async narratorPack(
    request: TextPlayRequest,
    frame: SceneFrame,
    sources: NarrativeSources,
  ): Promise<ContextPack> {
    const view = await this.context.worldlineRuns.view({ runId: request.runId })
    const route = view.snapshot.modelPolicy.routes.narrator
    if (route === undefined) throw new Error('no narrator model is configured')
    const model = await this.context.llm.resolveModelInfo(route.provider, route.model)
    const contextWindow = model.context?.contextWindow
    if (contextWindow === undefined) throw new Error('narrator model context capacity is unknown')
    const reservedOutputTokens = Math.max(1, Math.min(
      model.defaultMaxTokens ?? 1024,
      Math.floor(contextWindow * 0.2),
    ))
    const reservedToolTokens = 0
    const inputLimit = Math.min(
      Math.floor(contextWindow * 0.75),
      contextWindow - reservedOutputTokens,
    )
    const seeds = [
      {
        kind: 'constraints' as const,
        text: 'Narrate only these records. Do not add facts, secrets, participants, dialogue, location, inventory, health or relationship changes.',
        sourceIds: ['runtime:narrator-authority'],
        priority: 100,
      },
      {
        kind: 'background' as const,
        text: stableStringify(frame),
        sourceIds: [`scene:${request.runId}:${String(view.snapshot.sequence)}`],
        priority: 90,
      },
      {
        kind: 'observation' as const,
        text: stableStringify(sources.observations),
        sourceIds: sources.observations.map(item => item.id),
        priority: 85,
      },
      {
        kind: 'background' as const,
        text: stableStringify(sources.events),
        sourceIds: sources.events.map(item => item.id),
        priority: 80,
      },
    ]
    const sections: ContextPackSection[] = []
    const droppedSourceIds: string[] = []
    let remaining = inputLimit
    for (const seed of seeds.sort((left, right) => right.priority - left.priority)) {
      let text = seed.text
      let tokens = this.tokens(text)
      if (tokens > remaining) {
        text = this.trim(text, remaining)
        tokens = text === '' ? 0 : this.tokens(text)
        droppedSourceIds.push(...seed.sourceIds)
      }
      if (tokens === 0) continue
      sections.push({ ...seed, text, tokens })
      remaining -= tokens
    }
    const pack: ContextPack = {
      actorId: request.actorId,
      model: route,
      contextWindow,
      inputLimit,
      reservedOutputTokens,
      reservedToolTokens,
      sections,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
      droppedSourceIds: [...new Set(droppedSourceIds)],
    }
    validateContextPack(pack)
    return pack
  }

  private tokens(text: string): number {
    return this.context.tokenMeter.estimateMessage(createUserMessage({
      source: { kind: 'plugin', plugin: 'worldline-narrative' },
      content: [{ type: 'text', text }],
    }))
  }

  private trim(text: string, limit: number): string {
    if (limit <= 0) return ''
    let low = 0
    let high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (this.tokens(`${text.slice(0, middle)}…`) <= limit) low = middle
      else high = middle - 1
    }
    return low === 0 ? '' : `${text.slice(0, low)}…`
  }
}

export { WorldlineNarrative }
