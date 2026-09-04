import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  CallId,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type {
  ActionPlan,
  Blueprint,
  ModelPolicy,
  NarrativeBeat,
  StoryStageRenderer,
} from '@deepseek-ai/dsh-worldline-standard'
import { stableStringify, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import WorldlineAi from '../../ai/src/index.ts'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorkerWorldlineRuns from '../../runtime-worker/src/index.ts'
import { testBlueprint } from '../../runtime-worker/tests/fixture.ts'
import WorldlineNarrative, {
  environmentallyGroundedBlocks,
  narrativeContinuityRisk,
} from '../src/index.ts'

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

function scriptedStoryBlocks(source: string): readonly Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = []
  const pattern = /<(narration|dialogue|thought|action)(?:\s+actor="([^"]+)")?\s*>([\s\S]*?)<\/\1>/giu
  for (const match of source.matchAll(pattern)) {
    const type = match[1]?.toLocaleLowerCase()
    const actorId = match[2]
    const text = (match[3] ?? '').trim()
    if (text === '') continue
    if (type === 'narration') blocks.push({ type: 'narration', text })
    else blocks.push({ type: 'character', actorId, mode: type, text })
  }
  if (blocks.length > 0) return blocks
  const sentences = source.match(/[^。！？!?]+[。！？!?]?/gu)?.map(text => text.trim()).filter(Boolean) ?? []
  if (sentences.length > 1) return sentences.slice(0, 16).map(text => ({ type: 'narration', text }))
  const text = source.trim()
  if (text === '') return []
  const midpoint = Math.max(1, Math.floor(text.length / 2))
  return [
    { type: 'narration', text: text.slice(0, midpoint) },
    { type: 'narration', text: text.slice(midpoint) || '。' },
  ]
}

class NarratorAdapter extends LlmAdapter {
  calls = 0
  text = 'The traveller completes the recorded task.'
  readonly inputs: string[] = []
  readonly reasoningEfforts: Array<GenerateOptions['reasoningEffort']> = []
  readonly models: string[] = []
  readonly toolSets: string[][] = []
  readonly toolSchemas: Array<NonNullable<GenerateOptions['tools']>> = []
  toolCalls: readonly { readonly name: string; readonly arguments: string }[] | undefined
  readonly textQueue: string[] = []
  readonly stateProgressQueue: string[] = []
  readonly worldStateQueue: string[] = []
  readonly characterStateQueue: string[] = []
  readonly toolCallQueue: Array<readonly {
    readonly name: string
    readonly arguments: string
  }[] | undefined> = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Narrator',
      context: { contextWindow: 4096 },
      defaultMaxTokens: 256,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.models.push(options.model)
    this.reasoningEfforts.push(options.reasoningEffort)
    this.toolSets.push(options.tools?.map(tool => tool.name) ?? [])
    if (options.tools !== undefined) this.toolSchemas.push(options.tools)
    this.inputs.push(options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    const stateDirector = options.tools?.some(tool => tool.name === 'story_propose_state_update') === true
    const progressDirector = options.tools?.some(tool => tool.name === 'story_assess_progress') === true
    const narrator = options.tools?.some(tool => tool.name === 'story_present_sequence') === true
    const narratorText = narrator ? this.textQueue.shift() ?? this.text : undefined
    const stateQueue = this.inputs.at(-1)?.includes('你是世界状态推演分支') === true
      ? this.worldStateQueue : this.characterStateQueue
    const defaultNarratorBlocks = narrator && narratorText !== undefined
      ? scriptedStoryBlocks(narratorText) : undefined
    const toolCalls = stateDirector ? [{
      name: 'story_propose_state_update',
      arguments: stateQueue.shift() ?? JSON.stringify({
        mutations: [],
        memoryWrites: [],
      }),
    }] : progressDirector ? [{
      name: 'story_assess_progress',
      arguments: this.stateProgressQueue.shift() ?? JSON.stringify({
        status: 'active',
        rationale: '本轮材料尚未完整证明当前剧情目标已经成立。',
        evidence: ['当前完成证据仍然缺失。'],
      }),
    }] : this.toolCallQueue.length > 0 ? this.toolCallQueue.shift() : this.toolCalls ?? (
      narrator && defaultNarratorBlocks !== undefined ? [{
        name: 'story_present_sequence',
        arguments: JSON.stringify({
          mediaDecision: { mode: 'none', rationale: '测试正文没有独立媒体演出需要。' },
          blocks: defaultNarratorBlocks,
        }),
      }] : undefined
    )
    if (toolCalls !== undefined) {
      for (const [index, call] of toolCalls.entries()) {
        const id = CallId(`call-${String(index)}`)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
        }
      }
      yield { type: 'usage', usage: { inputTokens: 250, outputTokens: 40 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = this.textQueue.shift() ?? this.text
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: text.slice(0, 15) }
    yield { type: 'text-delta', index: 0, text: text.slice(15) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 250, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const policy: ModelPolicy = {
  routes: { narrator: { provider: 'mock', model: 'narrator' } },
  aiEnabled: true,
  revision: 'sha256:narrative-policy' as ModelPolicy['revision'],
}

async function setup(): Promise<{
  readonly context: Context
  readonly adapter: NarratorAdapter
  readonly dispose: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-narrative-'))
  roots.push(root)
  const context = new Context()
  const projects = context.plugin(LocalWorldlineProjects, {
    root,
    maxEntries: 5000,
    maxSearchFiles: 50_000,
  })
  await projects.await()
  const llm = context.plugin(LlmRuntime)
  await llm.await()
  const adapter = new NarratorAdapter()
  context.llm.registerAdapter(['mock'], adapter)
  const meter = context.plugin(TokenMeter)
  await meter.await()
  const runs = context.plugin(WorkerWorldlineRuns, {
    maxOldGenerationSizeMb: 128,
    requestTimeoutMs: 15_000,
  })
  await runs.await()
  const ai = context.plugin(WorldlineAi, {
    routePrices: [],
    fallbackInputPerMillion: 30,
    fallbackOutputPerMillion: 60,
    fallbackCacheReadPerMillion: 10,
    maxContextRecords: 500,
    l2MinLogicalInterval: 3600,
  })
  await ai.await()
  const narrative = context.plugin(WorldlineNarrative)
  await narrative.await()
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await narrative.dispose()
    await ai.dispose()
    await runs.dispose()
    await meter.dispose()
    await llm.dispose()
    await projects.dispose()
  }
  disposers.push(dispose)
  return { context, adapter, dispose }
}

interface RunFixtureOptions {
  readonly includeSocialAction?: boolean
  readonly secondActorLocation?: string
  readonly secondActorResources?: boolean
  readonly namedScriptActorIndex?: number
  readonly modelPolicy?: ModelPolicy
}

async function createRun(context: Context, options: RunFixtureOptions = {}): Promise<{
  readonly runId: Awaited<ReturnType<Context['worldlineRuns']['create']>>['summary']['runId']
  readonly actorId: Blueprint['entities'][number]['id']
}> {
  const project = await context.worldlineProjects.create({ name: 'Narrative World', template: 'blank' })
  const base = testBlueprint()
  const selectedPolicy = options.modelPolicy ?? policy
  const blueprint: Blueprint = {
    ...base,
    projectId: project.manifest.id,
    modelPolicy: selectedPolicy,
    canon: [...base.canon, {
      id: worldlineId<'entity'>('entity:narrative-world'),
      kind: 'charter',
      documentId: worldlineId<'document'>('document:narrative-world'),
      title: '叙事测试世界',
      aliases: [],
      tags: [],
      status: 'canon',
      worldIds: [base.worldId],
      worldlineIds: [base.worldlineId],
      facets: {
        initialWorldState: {
          world: {
            calendar: {
              secondsPerDay: 86_400,
              daysPerSeason: 28,
              seasons: ['春季', '夏季', '秋季', '冬季'],
              week: 1,
              weekday: '周一',
              startDayIndex: 1,
              startClockMinute: 1_005,
            },
            environment: { ambience: 'quiet' },
          },
        },
        worldStateSchema: {
          'environment.ambience': {
            type: 'string', mutable: true, label: '环境声场',
            participation: {
              drivers: ['director'],
              meaning: '声场会改变可感知线索与紧张程度',
              narrative: '安静时细小声响会更突出',
              choices: '优先提供倾听与谨慎观察',
              bands: [{
                equals: 'quiet', label: '过分安静', tone: 'notice',
                narrative: '任何细响都显得突兀', choices: '倾听比莽撞移动更有价值',
              }],
            },
          },
        },
      },
      provenance: base.provenance,
    }],
    maps: base.maps.map((map, mapIndex) => mapIndex === 0 ? {
      ...map,
      nodes: map.nodes.map(node => node.id === 'map-node:a-node-00001'
        ? { ...node, background: 'assets/files/locations/root/morning.png' }
        : node),
    } : map),
    entities: base.entities.map((entity, index) => ({
      ...entity,
      state: index === 0
        ? { ...entity.state, emotion: 'anxious', inventory: [], routeSense: '潮声偏左' }
        : options.secondActorLocation === undefined
          ? entity.state
          : { ...entity.state, locationId: options.secondActorLocation },
      facets: index === 0 ? {
        ...entity.facets,
        displayName: 'Traveler',
        profile: {
          age: '17',
          gender: '男',
          pronouns: '他',
          identity: '高中生',
        },
        stateSchema: {
          emotion: {
            type: 'string', mutable: true, label: '当前情绪',
            participation: {
              drivers: ['director'], meaning: '情绪改变风险判断',
              narrative: '焦虑会让呼吸变浅并放大威胁', choices: '更重视确认与退路',
              bands: [{
                equals: 'anxious', label: '焦虑', tone: 'notice',
                narrative: '呼吸变浅，注意力收紧', choices: '优先确认风险并保留退路',
              }],
            },
          },
          inventory: { type: 'array', mutable: true, description: '随身物品' },
          routeSense: { type: 'string', mutable: true, label: '潮路感知' },
        },
        resources: {
          visual: {
            portrait: 'assets/files/characters/traveller/portrait.png',
            expressions: {
              default: 'assets/files/characters/traveller/portrait.png',
              anxious: 'assets/files/characters/traveller/anxious.png',
            },
          },
          audio: {
            voice: 'assets/files/characters/traveller/voice.ogg',
            theme: 'assets/files/characters/traveller/theme.ogg',
          },
        },
      } : index === 1 && options.secondActorResources ? {
        displayName: 'Witness',
        secret: 'must-not-leak',
        resources: {
          visual: {
            portrait: 'assets/files/characters/witness/portrait.png',
            expressions: {
              default: 'assets/files/characters/witness/portrait.png',
              calm: 'assets/files/characters/witness/calm.png',
            },
          },
          audio: {
            voice: 'assets/files/characters/witness/voice.ogg',
            theme: 'assets/files/characters/witness/theme.ogg',
          },
        },
      } : index === 1 ? { displayName: 'Witness', secret: 'must-not-leak' } : entity.facets,
    })),
    actions: [
      ...base.actions,
      ...(options.includeSocialAction ? [{
        id: 'social.talk',
        description: '与在场角色交谈',
        actorTypes: ['character'],
        preconditions: [],
        claims: [],
        duration: 10,
        effects: [{ op: 'increment' as const, path: 'state.bond', amount: 1 }],
        interruptible: true,
        maxWait: 100,
        maxRetries: 3,
        fallbacks: [],
        provenance: base.actions[0]?.provenance ?? [],
      }] : []),
    ],
    plotPoints: [1, 2].map(order => ({
      id: `plot-point:test-${String(order)}`,
      name: order === 1 ? '先完成手头的工作' : '再确认工作的结果',
      summary: options.namedScriptActorIndex === undefined
        ? '剧本只能由真实完成的行动逐点推进。'
        : `这个剧本点必须由 ${options.namedScriptActorIndex === 0 ? 'Traveler' : 'Witness'} 完成。`,
      order,
      entryCondition: '角色仍在当前工作地点，并且本幕尚未完成。',
      completionCriteria: order === 1
        ? '本轮事实和正文明确证明手头工作已经完成。'
        : '本轮事实和正文明确证明角色已确认工作结果。',
      dramaticPressure: '截止时间正在临近，拖延会造成明确损失。',
      successOutcome: order === 1 ? '进入第二个剧情点。' : '完成测试剧情。',
      failureOutcome: '工作失败并产生新的现实阻碍。',
      recoveryHook: '角色可以调查失败原因并通过新的方法重新尝试。',
      timing: {
        activateAt: (order - 1) * 1_800,
        deadlineAt: order * 1_800,
        interventions: [{
          id: `plot-intervention:test-${String(order)}`,
          at: order * 1_800 - 300,
          title: '截止提醒',
          description: '校舍广播明确提醒本阶段只剩五分钟。',
        }],
      },
      provenance: base.actions[0]?.provenance ?? [],
    })),
  }
  await context.worldlineProjects.storeBuild({
    projectId: project.manifest.id,
    digest: blueprint.digest,
    blueprint: stableStringify(blueprint),
    certificate: stableStringify(blueprint.certificate),
    sourceSnapshot: '{}',
  })
  const run = await context.worldlineRuns.create({
    projectId: project.manifest.id,
    seed: 'narrative-run',
    modelPolicy: selectedPolicy,
    startPaused: false,
  })
  const actor = blueprint.entities[0]
  if (actor === undefined) throw new Error('narrative fixture has no actor')
  return { runId: run.summary.runId, actorId: actor.id }
}

async function prepareActionPlan(
  context: Context,
  run: Awaited<ReturnType<typeof createRun>>,
  actionType: string,
): Promise<{ readonly plan: ActionPlan; readonly sequence: number }> {
  const choices = await context.worldlineRuns.choices(run)
  const opportunity = choices.choices.find(choice => choice.actionType === actionType)
  if (opportunity === undefined) throw new Error(`${actionType} opportunity is missing`)
  const beats = await context.worldlineRuns.records({
    runId: run.runId,
    stream: 'narrative-beat',
    limit: 1,
    tail: true,
  })
  const latest = beats.records[0]?.payload as unknown as
    import('@deepseek-ai/dsh-worldline-standard').NarrativeBeat | undefined
  const testBeatText = '测试舞台已经建立。'
  const narratorInvocation = latest === undefined
    ? await context.worldlineRuns.recordAiInvocation({
      runId: run.runId,
      purpose: 'narrator',
      actorId: run.actorId,
      modelRoute: policy.routes.narrator!,
      contextSourceIds: [],
      inputTokens: 1,
      outputTokens: 1,
      estimatedCost: 0,
      outputDigest: createHash('sha256').update(testBeatText).digest('hex'),
      outcome: 'completed',
    })
    : undefined
  const beat = latest ?? (await context.worldlineRuns.recordNarrativeBeat({
    runId: run.runId,
    invocationId: narratorInvocation!.invocation.id,
    perspectiveActorId: run.actorId,
    eventIds: [],
    observationIds: [],
    camera: 'limited-third-person',
    modelOutput: testBeatText,
    text: testBeatText,
    blocks: [{ type: 'narration', text: testBeatText }],
    media: [],
    modelRoute: policy.routes.narrator!,
  })).beat
  const beforeState = await context.worldlineRuns.view({ runId: run.runId })
  if (beforeState.snapshot.storyStateCommits[beat.id] === undefined) {
    const definition = await context.worldlineRuns.definition({ runId: run.runId })
    const currentPoint = [...definition.plotPoints]
      .sort((left, right) => left.order - right.order)
      .find(point => beforeState.snapshot.storyProgress[point.id]?.status !== 'completed')
    const recordStateInvocation = (subjectId: string, digest: string) => (
      context.worldlineRuns.recordAiInvocation({
        runId: run.runId,
        purpose: 'creative',
        actorId: run.actorId,
        modelRoute: policy.routes.narrator!,
        contextSourceIds: [beat.id, subjectId],
        inputTokens: 1,
        outputTokens: 1,
        estimatedCost: 0,
        outputDigest: digest.repeat(64),
        outcome: 'completed',
      })
    )
    const [worldInvocation, characterInvocation, progressInvocation] = await Promise.all([
      recordStateInvocation('runtime:world-state-shard', 'a'),
      recordStateInvocation('runtime:character-state-shard', 'b'),
      currentPoint === undefined ? Promise.resolve(undefined) : recordStateInvocation(currentPoint.id, 'c'),
    ])
    const characterIds = definition.entities.filter(entity => entity.type === 'character')
      .map(entity => entity.id)
    await context.worldlineRuns.recordStoryState({
      runId: run.runId,
      beatId: beat.id,
      shards: [{
        invocationId: worldInvocation.invocation.id,
        domain: 'world',
        subjectIds: [],
        mutations: [],
        memoryWrites: [],
      }, {
        invocationId: characterInvocation.invocation.id,
        domain: 'characters',
        subjectIds: characterIds,
        mutations: [],
        memoryWrites: [],
      }],
      ...(currentPoint === undefined || progressInvocation === undefined ? {} : {
        progress: {
          invocationId: progressInvocation.invocation.id,
          pointId: currentPoint.id,
          status: 'active',
          rationale: '测试舞台没有提供剧情目标已经完成的证据。',
          evidence: ['当前只建立了测试舞台。'],
          eventIds: beat.eventIds,
          observationIds: beat.observationIds,
        },
      }),
    })
  }
  await context.worldlineRuns.completePresentation({
    runId: run.runId,
    actorId: run.actorId,
    beatId: beat.id,
  })
  const invocation = await context.worldlineRuns.recordAiInvocation({
    runId: run.runId,
    purpose: 'creative',
    actorId: run.actorId,
    modelRoute: policy.routes.narrator!,
    contextSourceIds: [beat.id],
    inputTokens: 1,
    outputTokens: 1,
    estimatedCost: 0,
    outputDigest: 'd'.repeat(64),
    outcome: 'completed',
  })
  const retained = await context.worldlineRuns.recordActionDeck({
    runId: run.runId,
    actorId: run.actorId,
    expectedSequence: choices.sequence,
    afterBeatId: beat.id,
    invocationId: invocation.invocation.id,
    plans: [
      { opportunityId: opportunity.id, storyRole: 'advance', label: '推进当前目标的具体行动', intent: '采取直接步骤推进当前剧情目标。' },
      { opportunityId: opportunity.id, storyRole: 'character', label: '从人物关系寻找另一种解法', intent: '通过人物态度与关系处理眼前局面。' },
      { opportunityId: opportunity.id, storyRole: 'deviate', label: '暂时离开主线观察周围变化', intent: '暂缓当前目标并自由调查周围的新变化。' },
    ],
  })
  const plan = retained.deck.plans.find(item => item.storyRole === 'advance')
  if (plan === undefined) throw new Error('prepared action deck has no advance plan')
  return { plan, sequence: retained.deck.sequence }
}

afterEach(async () => {
  await Promise.allSettled(disposers.splice(0).map(dispose => dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorldlineNarrative', () => {
  it('cannot present a live disaster as an unqualified calm daily scene', () => {
    const blocks = environmentallyGroundedBlocks([
      { type: 'narration', text: '两个人在教室里安静地整理值日表。' },
    ], {
      world: { disaster: { stage: 2 }, intel: { greyTide: 4 } },
      conflict: { greyTide: 4, infectedCount: 7 },
    })
    const prose = blocks.flatMap(block => block.type === 'narration' || block.type === 'character'
      ? [block.text]
      : []).join('')
    expect(prose).toContain('灾变')
    expect(prose).toContain('灰雾')
    expect(prose).not.toContain('灰潮 4')
  })

  it('does not replay an unchanged authoritative environment bridge on consecutive beats', () => {
    const state = {
      world: { disaster: { stage: 2 }, intel: { greyTide: 4 } },
      conflict: { greyTide: 4, infectedCount: 7 },
    }
    const previous = environmentallyGroundedBlocks([
      { type: 'narration', text: '两个人收好了值日表。' },
    ], state)
    const next = environmentallyGroundedBlocks([
      { type: 'narration', text: '苏晚晴把旧书推到桌沿，等他开口。' },
    ], state, [previous])
    expect(next).toEqual([
      { type: 'narration', text: '苏晚晴把旧书推到桌沿，等他开口。' },
    ])
  })

  it('advances the frozen script only from an executed generated plan', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const opening = await runtime.context.worldlineNarrative.open(run)
    expect(opening.script).toMatchObject({
      completed: [],
      current: { order: 1 },
      remaining: 2,
    })
    const prepared = await prepareActionPlan(runtime.context, run, 'character.work')
    const submitted = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: prepared.plan.id,
      expectedSequence: prepared.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    expect((await runtime.context.worldlineNarrative.open(run)).script.completed).toEqual([])
    runtime.adapter.stateProgressQueue.push(JSON.stringify({
      status: 'completed',
      rationale: '本轮权威事件与正文共同证明手头工作已经完成。',
      evidence: ['action.completed 事件确认工作完成。', '正文呈现了完成后的直接结果。'],
    }))
    await runtime.context.worldlineNarrative.narrate({ ...run, actionId: submitted.actionId })
    const next = await runtime.context.worldlineNarrative.open(run)
    expect(next.script.completed.map(point => point.order)).toEqual([1])
    expect(next.script.current?.order).toBe(2)
    await runtime.dispose()
  })

  it('does not let an unrelated character satisfy a named script beat', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context, { namedScriptActorIndex: 1 })
    const opening = await runtime.context.worldlineNarrative.open(run)
    expect(opening.script.suggestedActorIds).toEqual([worldlineId<'entity'>('entity:actor-b1')])
    const prepared = await prepareActionPlan(runtime.context, run, 'character.work')
    await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: prepared.plan.id,
      expectedSequence: prepared.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    expect((await runtime.context.worldlineNarrative.open(run)).script.completed).toEqual([])
    await runtime.dispose()
  })

  it('commits schema-constrained story state, perceived memory, and plot evidence atomically', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const prepared = await prepareActionPlan(runtime.context, run, 'character.work')
    const submitted = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: prepared.plan.id,
      expectedSequence: prepared.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    runtime.adapter.text = '工作结束后，他如释重负地松开了紧绷的肩膀，但仍没有提到约定。'
    runtime.adapter.worldStateQueue.push(JSON.stringify({
      mutations: [{
        scope: 'world',
        path: 'environment.ambience',
        operation: 'set',
        value: 'relieved',
        reason: '正文明确表现紧张气氛随工作结束而缓和。',
      }],
      memoryWrites: [],
    }))
    runtime.adapter.characterStateQueue.push(JSON.stringify({
      mutations: [{
        scope: 'character',
        actorId: run.actorId,
        path: 'emotion',
        operation: 'set',
        value: 'relieved',
        reason: '正文明确表现角色在完成工作后放松下来。',
      }],
      memoryWrites: [{
        actorId: run.actorId,
        summary: '完成值日后，自己终于放松下来，但还没有谈到约定。',
        importance: 0.72,
      }],
    }))
    runtime.adapter.stateProgressQueue.push(JSON.stringify({
      status: 'active',
      rationale: '工作虽已完成，但剧情点要求的约定尚未得到确认。',
      evidence: ['正文只确认了工作与值日表，未出现双方确认约定。'],
    }))
    await runtime.context.worldlineNarrative.narrate({ ...run, actionId: submitted.actionId })
    const view = await runtime.context.worldlineRuns.view(run)
    const actor = (view.snapshot.state['entities'] as unknown as Record<string, {
      readonly state: { readonly emotion: string; readonly inventory: readonly string[] }
      readonly memory: { readonly episodic: readonly { readonly summary: string }[] }
    }>)[run.actorId]
    expect(actor?.state).toMatchObject({
      emotion: 'relieved',
      inventory: [],
    })
    expect(actor?.memory.episodic.at(-1)?.summary).toContain('放松下来')
    expect(view.snapshot.state['world']).toMatchObject({ environment: { ambience: 'relieved' } })
    expect(Object.values(view.snapshot.storyStateCommits)).toHaveLength(2)
    const latestCommit = Object.values(view.snapshot.storyStateCommits)
      .sort((left, right) => right.sequence - left.sequence)[0]
    expect(latestCommit?.shards.map(shard => shard.domain).sort()).toEqual(['characters', 'world'])
    expect(latestCommit?.shards.find(shard => shard.domain === 'characters')?.subjectIds)
      .toEqual(expect.arrayContaining(['entity:actor-a1', 'entity:actor-b1']))
    expect(view.snapshot.storyProgress['plot-point:test-1']?.status).toBe('active')
    const stateRecords = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'story-state',
      limit: 10,
    })
    const progressRecords = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'story-progress',
      limit: 10,
    })
    expect(stateRecords.records).toHaveLength(2)
    expect(progressRecords.records).toHaveLength(2)
    expect(stateRecords.records.at(-1)?.ordinal).not.toBe(progressRecords.records.at(-1)?.ordinal)
    await runtime.dispose()
  })

  it('maps free-form intent through the model without a deterministic keyword fallback', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work opportunity is missing')
    runtime.adapter.toolCalls = [{
      name: 'story_propose_action',
      arguments: JSON.stringify({ opportunityId: work.id }),
    }]
    const result = await runtime.context.worldlineNarrative.freeInput({
      ...run,
      text: '我想先工作一会儿',
      expectedSequence: choices.sequence,
    })
    expect(result.status).toBe('submitted')
    expect(result.action?.process.action.parameters).toMatchObject({
      storyIntent: '我想先工作一会儿',
    })
    expect(runtime.adapter.toolSets.at(-1)).toContain('story_propose_action')
    await runtime.dispose()
  })

  it('feeds active attribute meaning and bands into creative and state-director reasoning', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    await runtime.context.worldlineNarrative.narrate(run)
    const prompts = runtime.adapter.inputs.join('\n')
    expect(prompts).toContain('stateSemantics')
    expect(prompts).toContain('worldStateSemantics')
    expect(prompts).toContain('呼吸变浅，注意力收紧')
    expect(prompts).toContain('倾听比莽撞移动更有价值')
    expect(prompts).toContain('activeSemantics')
    await runtime.dispose()
  })

  it('prefetches exactly three durable plans while the retained beat is still playing', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const opening = await runtime.context.worldlineNarrative.narrate(run)
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    const rest = choices.choices.find(choice => choice.actionType !== 'character.work')
    if (work === undefined || rest === undefined) throw new Error('planning opportunities are incomplete')
    runtime.adapter.toolCalls = [{
      name: 'story_offer_choices',
      arguments: JSON.stringify({ choices: [
        {
          opportunityId: work.id,
          storyRole: 'advance',
          label: '先把值日表核对清楚再追问书签',
          intent: '完成眼前值日工作，并借机确认书签是谁留下的。',
        },
        {
          opportunityId: work.id,
          storyRole: 'character',
          label: '坦白自己一直在意她刚才的回答',
          intent: '放慢节奏谈清彼此的真实感受，观察关系如何变化。',
        },
        {
          opportunityId: rest.id,
          storyRole: 'deviate',
          label: '暂时离开书签去查看走廊的异响',
          intent: '偏离当前线索，先确认走廊里是否出现了新的风险。',
        },
      ] }),
    }]
    const planned = await runtime.context.worldlineNarrative.suggest(run)
    expect(planned.afterBeatId).toBe(opening.id)
    expect(planned.suggestions).toHaveLength(3)
    expect(runtime.adapter.inputs.at(-1)).toContain('倾听比莽撞移动更有价值')
    expect(runtime.adapter.inputs.at(-1)).toContain('优先确认风险并保留退路')
    expect(new Set(planned.suggestions.map(item => item.storyRole))).toEqual(
      new Set(['advance', 'character', 'deviate']),
    )
    expect(new Set(planned.suggestions.map(item => item.label)).size).toBe(3)
    const callsAfterGeneration = runtime.adapter.calls
    const restored = await runtime.context.worldlineNarrative.suggest(run)
    expect(restored).toEqual(planned)
    expect(runtime.adapter.calls).toBe(callsAfterGeneration)
    const snapshot = await runtime.context.worldlineRuns.view(run)
    expect(snapshot.snapshot.actionDecks[run.actorId]?.plans).toEqual(planned.suggestions)
    const records = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'action-deck',
      limit: 10,
    })
    expect(records.records).toHaveLength(1)
    const selected = planned.suggestions.find(item => item.storyRole === 'character')
    if (selected === undefined) throw new Error('character plan is missing')
    const submitted = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: selected.id,
      expectedSequence: planned.sequence,
    })
    expect(submitted.process.action.parameters['storyIntent']).toBe(selected.intent)
    await runtime.dispose()
  })

  it('rejects a malformed choice-director result instead of filling static options', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const opening = await runtime.context.worldlineNarrative.narrate(run)
    await runtime.context.worldlineRuns.completePresentation({ ...run, beatId: opening.id })
    runtime.adapter.toolCalls = [{
      name: 'story_offer_choices',
      arguments: JSON.stringify({ choices: [] }),
    }]
    await expect(runtime.context.worldlineNarrative.suggest(run)).rejects.toThrow()
    expect((await runtime.context.worldlineRuns.view(run)).snapshot.actionDecks).toEqual({})
    await runtime.dispose()
  })

  it('asks the choice director to repair malformed tool JSON before exposing the stage', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const opening = await runtime.context.worldlineNarrative.narrate(run)
    await runtime.context.worldlineRuns.completePresentation({ ...run, beatId: opening.id })
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    const rest = choices.choices.find(choice => choice.actionType !== 'character.work')
    if (work === undefined || rest === undefined) throw new Error('planning opportunities are incomplete')
    runtime.adapter.toolCallQueue.push(
      [{ name: 'story_offer_choices', arguments: '{"choices":[{"opportunityId":' }],
      [{
        name: 'story_offer_choices',
        arguments: JSON.stringify({ choices: [
          {
            opportunityId: work.id,
            storyRole: 'advance',
            label: '核对眼前的值日记录',
            intent: '完成值日核对，并确认记录缺口来自哪里。',
          },
          {
            opportunityId: work.id,
            storyRole: 'character',
            label: '询问同伴刚才为何迟疑',
            intent: '放慢节奏，确认同伴真正担心的事情。',
          },
          {
            opportunityId: rest.id,
            storyRole: 'deviate',
            label: '离开现场查看走廊异响',
            intent: '暂时偏离眼前记录，先确认走廊里的异常。',
          },
        ] }),
      }],
    )

    const planned = await runtime.context.worldlineNarrative.suggest(run)

    expect(planned.suggestions).toHaveLength(3)
    expect(runtime.adapter.inputs.at(-1)).toContain('上一次 story_offer_choices 工具参数未通过')
    expect((await runtime.context.worldlineRuns.view(run))
      .snapshot.actionDecks[run.actorId]?.plans).toEqual(planned.suggestions)
    await runtime.dispose()
  })

  it('resumes an interrupted story turn by committing state before generating choices', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.worldStateQueue.push('{"mutations":', '{"mutations":')
    await expect(runtime.context.worldlineNarrative.narrate(run))
      .rejects.toThrow('story_propose_state_update 连续两次返回了无效的结构化参数')
    const beats = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 1,
      tail: true,
    })
    const beat = beats.records[0]?.payload as unknown as NarrativeBeat | undefined
    if (beat === undefined) throw new Error('interrupted turn did not retain its prose')
    await runtime.context.worldlineRuns.completePresentation({ ...run, beatId: beat.id })
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    const rest = choices.choices.find(choice => choice.actionType !== 'character.work')
    if (work === undefined || rest === undefined) throw new Error('planning opportunities are incomplete')
    runtime.adapter.toolCalls = [{
      name: 'story_offer_choices',
      arguments: JSON.stringify({ choices: [
        {
          opportunityId: work.id,
          storyRole: 'advance',
          label: '核对值日记录里的缺口',
          intent: '先完成眼前工作，并确认记录为何缺失。',
        },
        {
          opportunityId: work.id,
          storyRole: 'character',
          label: '和同伴谈谈彼此的顾虑',
          intent: '放慢调查节奏，确认同伴真正担心什么。',
        },
        {
          opportunityId: rest.id,
          storyRole: 'deviate',
          label: '暂时离开去查看走廊',
          intent: '偏离眼前线索，先确认走廊是否安全。',
        },
      ] }),
    }]

    const planned = await runtime.context.worldlineNarrative.suggest(run)

    expect(planned.suggestions).toHaveLength(3)
    expect((await runtime.context.worldlineRuns.view(run))
      .snapshot.storyStateCommits[beat.id]).toBeDefined()
    await runtime.dispose()
  })

  it('repairs prefixed state paths before committing them', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.characterStateQueue.push(
      JSON.stringify({
        mutations: [{
          scope: 'character',
          actorId: run.actorId,
          path: 'state.emotion',
          operation: 'set',
          value: 'calm',
          reason: '正文明确写出角色已经平静下来。',
        }],
        memoryWrites: [],
      }),
      JSON.stringify({
        mutations: [{
          scope: 'character',
          actorId: run.actorId,
          path: 'emotion',
          operation: 'set',
          value: 'calm',
          reason: '正文明确写出角色已经平静下来。',
        }],
        memoryWrites: [],
      }),
    )

    await runtime.context.worldlineNarrative.narrate(run)

    const view = await runtime.context.worldlineRuns.view({ runId: run.runId })
    const actor = (view.snapshot.state['entities'] as Record<string, {
      readonly state?: Record<string, unknown>
    }>)[run.actorId]
    expect(actor?.state?.['emotion']).toBe('calm')
    expect(runtime.adapter.inputs.some(input => input.includes(
      '上一次 story_propose_state_update 工具参数未通过',
    ))).toBe(true)
    const characterTool = runtime.adapter.toolSchemas.flatMap(tools => tools)
      .find((tool) => {
        const parameters = tool.parameters as {
          readonly properties?: { readonly mutations?: { readonly items?: {
            readonly properties?: Record<string, { readonly enum?: readonly string[] }>
          } } }
        }
        return parameters.properties?.mutations?.items?.properties?.['actorId'] !== undefined
      })
    const mutationProperties = (characterTool?.parameters as {
      readonly properties?: { readonly mutations?: { readonly items?: {
        readonly properties?: Record<string, { readonly enum?: readonly string[] }>
      } } }
    }).properties?.mutations?.items?.properties
    expect(mutationProperties?.['path']?.enum).toContain('emotion')
    expect(mutationProperties?.['path']?.enum).not.toContain('state.emotion')
    expect(mutationProperties?.['actorId']?.enum).toContain(run.actorId)
    await runtime.dispose()
  })

  it('retains validated character and narration blocks for player-paced presentation', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.text = [
      '<narration>窗外的光落在工作台上。</narration>',
      `<thought actor="${run.actorId}">先把眼前这件事做完。</thought>`,
      `<dialogue actor="${run.actorId}">我再检查一遍。</dialogue>`,
      '<dialogue actor="entity:not-present">这句话不能冒充在场角色。</dialogue>',
    ].join('')
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    const beat = await runtime.context.worldlineNarrative.narrate(run)
    expect(beat.blocks).toContainEqual({ type: 'narration', text: '窗外的光落在工作台上。' })
    expect(beat.blocks.filter(block => block.type === 'character')).toEqual([
      { type: 'character', actorId: run.actorId, mode: 'thought', text: '先把眼前这件事做完。' },
      { type: 'character', actorId: run.actorId, mode: 'dialogue', text: '我再检查一遍。' },
    ])
    await runtime.dispose()
  })

  it('scores a replayed scene much higher than a genuine continuation', () => {
    const previous = [{
      type: 'narration' as const,
      text: '顾星野把值日表压在窗边，翻开那本旧书，在空白姓名旁补上苏晚晴的名字。粉笔灰从窗缝里落下来，她把旧书递回去，谁也没有再说话。',
    }]
    const replay = [{
      type: 'narration' as const,
      text: '顾星野又把值日表放到窗边，重新翻开旧书，在空白的姓名旁写下苏晚晴的名字。粉笔灰仍从窗缝落下，她随后把那本旧书递了回去。',
    }]
    const continuation = [{
      type: 'narration' as const,
      text: '最后一把椅子归位后，两人关掉教室的灯。走廊尽头传来异常的撞击声，她们没有回头争论，而是贴着墙确认最近的安全出口。',
    }]
    expect(narrativeContinuityRisk(replay, [previous])).toBeGreaterThanOrEqual(.22)
    expect(narrativeContinuityRisk(continuation, [previous])).toBeLessThan(.22)
  })

  it('repairs one semantically replayed generation before retaining the next beat', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const first = [
      '<narration>顾星野把值日表压在窗边，翻开那本旧书，在空白姓名旁补上苏晚晴的名字。粉笔灰从窗缝里落下来，她把旧书递回去，谁也没有再说话。</narration>',
      `<thought actor="${run.actorId}">这件事总算写清楚了。</thought>`,
    ].join('')
    runtime.adapter.text = first
    for (let round = 0; round < 2; round += 1) {
      const choices = await runtime.context.worldlineRuns.choices(run)
      const work = choices.choices.find(choice => choice.actionType === 'character.work')
      if (work === undefined) throw new Error('work choice is missing')
      await runtime.context.worldlineNarrative.choose({
        ...run,
        planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
        expectedSequence: choices.sequence,
      })
      await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
      if (round === 0) {
        await runtime.context.worldlineNarrative.narrate(run)
        runtime.adapter.textQueue.push(
          [
            '<narration>顾星野又把值日表放到窗边，重新翻开旧书，在空白的姓名旁写下苏晚晴的名字。粉笔灰仍从窗缝落下，她随后把那本旧书递了回去。</narration>',
            `<dialogue actor="${run.actorId}">名字还是写在这里。</dialogue>`,
          ].join(''),
          [
            '<narration>最后一把椅子归位后，教室终于收拾完毕。走廊尽头传来异常的撞击声，门框也随之轻轻震动。</narration>',
            `<action actor="${run.actorId}">她关掉教室的灯，贴着墙确认最近的安全出口。</action>`,
            `<dialogue actor="${run.actorId}">先离开这里，别惊动走廊里的东西。</dialogue>`,
          ].join(''),
        )
      } else {
        const beat = await runtime.context.worldlineNarrative.narrate(run)
        expect(beat.blocks.some(block => (
          block.type === 'narration' && block.text.includes('最后一把椅子')
        ))).toBe(true)
      }
    }
    expect(runtime.adapter.calls).toBe(9)
    expect(runtime.adapter.inputs.some(input => input.includes('连续性校验拒绝了上一版候选'))).toBe(true)
    const retained = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    expect(retained.records).toHaveLength(3)
    await runtime.dispose()
  })

  it('uses validated presentation tools for ordered story, character and media units', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.toolCalls = [{
      name: 'story_present_sequence',
      arguments: JSON.stringify({
        mediaDecision: { mode: 'staged', rationale: '灯光、潮声与纸页形成独立的视听时刻。' },
        blocks: [
          { type: 'narration', text: '灯光在窗台上摇晃。' },
          { type: 'character', actorId: run.actorId, mode: 'thought', text: '这个数值不对。' },
          { type: 'state', stateCueIndex: 0 },
          { type: 'media', cueIndex: 0 },
          {
            type: 'media-intent',
            intent: {
              kind: 'image',
              purpose: 'scene',
              prompt: '昏黄灯光下的档案馆窗台，潮雾贴着玻璃，只呈现视角人物可见的环境。',
              fallbackText: '此处应呈现潮雾漫过窗台、灯光微微摇晃的场景插图。',
            },
          },
          {
            type: 'media-intent',
            intent: {
              kind: 'audio',
              purpose: 'sfx',
              prompt: '近处纸页翻动与远处低沉潮声，短促、无旋律、无人物对白。',
              fallbackText: '此处应响起纸页翻动与远处潮声。',
            },
          },
          {
            type: 'media-intent',
            intent: {
              kind: 'image',
              purpose: 'voice',
              prompt: '类型与用途冲突，不应被保留。',
              fallbackText: '不应显示。',
            },
          },
          {
            type: 'character',
            actorId: 'entity:not-present',
            mode: 'dialogue',
            text: '不应被保留。',
          },
          { type: 'character', actorId: run.actorId, mode: 'action', text: '。' },
          { type: 'narration', text: '！' },
          { type: 'media', cueIndex: 99 },
        ],
      }),
    }]
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    const beat = await runtime.context.worldlineNarrative.narrate(run)
    expect(runtime.adapter.toolSets).toContainEqual(['story_present_sequence'])
    const presentation = runtime.adapter.toolSchemas.flat()
      .find(tool => tool.name === 'story_present_sequence')
    const presentationParameters = presentation?.parameters as unknown as {
      readonly required?: readonly string[]
      readonly properties?: Readonly<Record<string, {
        readonly required?: readonly string[]
        readonly items?: {
          readonly oneOf?: readonly {
            readonly required?: readonly string[]
            readonly properties?: Readonly<Record<string, {
              readonly const?: string
              readonly required?: readonly string[]
            }>>
          }[]
        }
      }>>
    } | undefined
    const blockBranches = presentationParameters?.properties?.['blocks']?.items?.oneOf
    expect(presentationParameters?.required).toEqual(['mediaDecision', 'blocks'])
    expect(presentationParameters?.properties?.['mediaDecision']?.required)
      .toEqual(['mode', 'rationale'])
    expect(presentation?.description).toContain('There is no opening quota')
    expect(blockBranches?.find(branch => branch.properties?.['type']?.const === 'media-intent'))
      .toMatchObject({
        required: ['type', 'intent'],
        properties: { intent: { required: ['kind', 'purpose', 'prompt', 'fallbackText'] } },
      })
    expect(beat.blocks).toEqual([
      { type: 'narration', text: '灯光在窗台上摇晃。' },
      { type: 'character', actorId: run.actorId, mode: 'thought', text: '这个数值不对。' },
      {
        type: 'state',
        cue: {
          scope: 'character',
          label: '精力',
          before: '0',
          value: '1',
          tone: 'positive',
          actorId: run.actorId,
          path: `entities.${run.actorId}.state.energy`,
        },
      },
      { type: 'media', cue: beat.media[0] },
      {
        type: 'media-intent',
        intent: {
          kind: 'image',
          purpose: 'scene',
          prompt: '昏黄灯光下的档案馆窗台，潮雾贴着玻璃，只呈现视角人物可见的环境。',
          fallbackText: '此处应呈现潮雾漫过窗台、灯光微微摇晃的场景插图。',
        },
      },
      {
        type: 'media-intent',
        intent: {
          kind: 'audio',
          purpose: 'sfx',
          prompt: '近处纸页翻动与远处低沉潮声，短促、无旋律、无人物对白。',
          fallbackText: '此处应响起纸页翻动与远处潮声。',
        },
      },
    ])
    expect(beat.text).not.toContain('story_present_sequence')
    expect(beat.text).toContain('此处应呈现潮雾漫过窗台')
    await runtime.dispose()
  })

  it('rejects a staged media decision when the story contains no inline media', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.toolCalls = [{
      name: 'story_present_sequence',
      arguments: JSON.stringify({
        mediaDecision: { mode: 'staged', rationale: '声响值得演出。' },
        blocks: [
          { type: 'narration', text: '门外传来一声短促的敲击。' },
          { type: 'narration', text: '房间里的人同时停下动作。' },
        ],
      }),
    }]

    await expect(runtime.context.worldlineNarrative.narrate(run))
      .rejects.toThrow('多模态判断与正文演出不一致')
    expect(runtime.adapter.inputs.some(input => input.includes(
      'mediaDecision 选择 staged 时',
    ))).toBe(true)
    await runtime.dispose()
  })

  it('rejects obsolete presentation aliases instead of retaining compatibility output', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.toolCalls = [{
      name: 'story_present_sequence',
      arguments: JSON.stringify({
        mediaDecision: { mode: 'none', rationale: '本测试只验证过时正文别名会被拒绝。' },
        blocks: [
          { type: 'narration', content: '走廊里的风忽然停了。' },
          { type: 'dialogue', actor: run.actorId, content: '先别出声。' },
          { type: 'dialogue', actor: 'entity:not-present', content: '不能冒充在场角色。' },
          { type: 'unknown', text: '不能通过未知类型混入。' },
        ],
      }),
    }]
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    await expect(runtime.context.worldlineNarrative.narrate(run))
      .rejects.toThrow('叙事模型没有返回可保存的小说正文')
    const retained = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    expect(retained.records).toHaveLength(1)
    await runtime.dispose()
  })

  it('routes prose to narrator and state/choices to the creative director with full schema state', async () => {
    const runtime = await setup()
    const splitPolicy: ModelPolicy = {
      ...policy,
      routes: {
        narrator: { provider: 'mock', model: 'prose-model' },
        creative: { provider: 'mock', model: 'director-model' },
      },
    }
    const run = await createRun(runtime.context, { modelPolicy: splitPolicy })
    const opening = await runtime.context.worldlineNarrative.narrate(run)
    expect(runtime.adapter.models.slice(0, 2)).toEqual(['prose-model', 'director-model'])
    expect(runtime.adapter.inputs[0]).toContain('"routeSense":"潮声偏左"')
    await runtime.context.worldlineRuns.completePresentation({ ...run, beatId: opening.id })
    const opportunities = await runtime.context.worldlineRuns.choices(run)
    const work = opportunities.choices.find(choice => choice.actionType === 'character.work')
    const rest = opportunities.choices.find(choice => choice.actionType !== 'character.work')
    if (work === undefined || rest === undefined) throw new Error('planning opportunities are incomplete')
    runtime.adapter.toolCalls = [{
      name: 'story_offer_choices',
      arguments: JSON.stringify({ choices: [
        { opportunityId: work.id, label: '沿着潮声核对眼前工作的异常来源', intent: '利用潮路感知推进当前目标。', storyRole: 'advance' },
        { opportunityId: work.id, label: '先向在场的人坦白自己的迟疑', intent: '借当前局面深化人物关系。', storyRole: 'character' },
        { opportunityId: rest.id, label: '暂时离开主线检查另一条安全路径', intent: '偏离目标验证新的可能。', storyRole: 'deviate' },
      ] }),
    }]
    await runtime.context.worldlineNarrative.suggest(run)
    expect(runtime.adapter.models.at(-1)).toBe('director-model')
    expect(runtime.adapter.inputs.at(-1)).toContain('"routeSense":"潮声偏左"')
    await runtime.dispose()
  })

  it('separates quoted speech from mixed character action and dialogue blocks', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.toolCalls = [{
      name: 'story_present_sequence',
      arguments: JSON.stringify({
        mediaDecision: { mode: 'none', rationale: '连续对话不需要重复媒体演出。' },
        blocks: [
          {
            type: 'character',
            actorId: run.actorId,
            mode: 'action',
            text: '顾星野放慢脚步，回头看她。“先下楼，别留在这里。”他让开楼梯口。',
          },
          {
            type: 'character',
            actorId: run.actorId,
            mode: 'dialogue',
            text: '顾星野压低声音：“广播室有人处理。”“你跟紧我。”',
          },
        ],
      }),
    }]
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    const beat = await runtime.context.worldlineNarrative.narrate(run)
    expect(beat.blocks).toEqual([
      { type: 'character', actorId: run.actorId, mode: 'action', text: '顾星野放慢脚步，回头看她。' },
      { type: 'character', actorId: run.actorId, mode: 'dialogue', text: '先下楼，别留在这里。' },
      { type: 'character', actorId: run.actorId, mode: 'action', text: '他让开楼梯口。' },
      { type: 'character', actorId: run.actorId, mode: 'dialogue', text: '广播室有人处理。你跟紧我。' },
    ])
    await runtime.dispose()
  })

  it('keeps audit output but removes clock and daypart claims that contradict Runtime time', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.toolCalls = [{
      name: 'story_present_sequence',
      arguments: JSON.stringify({
        mediaDecision: { mode: 'none', rationale: '本测试聚焦时间陈述，不添加媒体。' },
        blocks: [
          { type: 'narration', text: '馆里的钟走过了两点。灯光仍落在纸页上。' },
          { type: 'narration', text: '午后的阳光照进窗户。顾星野把记录册合上。' },
          { type: 'character', actorId: run.actorId, mode: 'thought', text: '此刻是 00:00，我该休息了。' },
        ],
      }),
    }]
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    const submitted = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    const beat = await runtime.context.worldlineNarrative.narrate({
      ...run,
      actionId: submitted.actionId,
    })

    expect(beat.blocks).toEqual([
      { type: 'narration', text: '灯光仍落在纸页上。' },
      { type: 'narration', text: '午后的阳光照进窗户。顾星野把记录册合上。' },
    ])
    expect(beat.text).not.toContain('馆里的钟走过了两点')
    expect(beat.text).toContain('午后的阳光')
    await runtime.dispose()
  })

  it('rejects a media-only presentation sequence as an unsaveable story beat', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.toolCalls = [{
      name: 'story_present_sequence',
      arguments: JSON.stringify({
        mediaDecision: { mode: 'staged', rationale: '测试媒体不能替代正文。' },
        blocks: [{ type: 'media', cueIndex: 0 }],
      }),
    }]
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    const submitted = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })

    await expect(runtime.context.worldlineNarrative.narrate({
      ...run,
      actionId: submitted.actionId,
    })).rejects.toThrow('叙事模型没有返回可保存的小说正文')
    const retained = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    expect(retained.records).toHaveLength(1)
    await runtime.dispose()
  })

  it('offers co-present character art and voice without borrowing their theme music', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context, { secondActorResources: true })
    const scene = await runtime.context.worldlineNarrative.scene(run)
    expect(scene.media).toContainEqual({
      type: 'expression',
      entityId: worldlineId<'entity'>('entity:actor-b1'),
      variant: 'assets/files/characters/witness/portrait.png',
    })
    expect(scene.media).toContainEqual({
      type: 'voice',
      entityId: worldlineId<'entity'>('entity:actor-b1'),
      variant: 'assets/files/characters/witness/voice.ogg',
    })
    expect(scene.media).not.toContainEqual({
      type: 'bgm',
      entityId: worldlineId<'entity'>('entity:actor-b1'),
      variant: 'assets/files/characters/witness/theme.ogg',
    })
    await runtime.dispose()
  })

  it('streams source-bound prose without mutating the world and retries only by branching', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    await runtime.context.worldlineRuns.setControl({ ...run, mode: 'player' })
    const scene = await runtime.context.worldlineNarrative.scene(run)
    expect(stableStringify(scene.visibleState)).not.toContain('must-not-leak')
    expect(scene.visibleState['place']).toMatchObject({
      background: 'assets/files/locations/root/morning.png',
    })
    expect(scene.media).toEqual([
      { type: 'background', variant: 'assets/files/locations/root/morning.png' },
      { type: 'bgm', entityId: run.actorId, variant: 'assets/files/characters/traveller/theme.ogg' },
      { type: 'expression', entityId: run.actorId, variant: 'assets/files/characters/traveller/anxious.png' },
      { type: 'voice', entityId: run.actorId, variant: 'assets/files/characters/traveller/voice.ogg' },
    ])
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    const prepared = await prepareActionPlan(runtime.context, run, 'character.work')
    const save = await runtime.context.worldlineNarrative.save({ ...run, label: 'Before work' })
    const submitted = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: prepared.plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    const beforeNarration = await runtime.context.worldlineRuns.view({ runId: run.runId })
    const streamed: string[] = []
    const streamKinds: string[] = []
    const phases: string[] = []
    let beatId: string | undefined
    for await (const chunk of runtime.context.worldlineNarrative.narrateStream({
      ...run,
      actionId: submitted.actionId,
    })) {
      streamKinds.push(chunk.type)
      if (chunk.type === 'phase') phases.push(chunk.phase)
      if (chunk.type === 'text-delta') streamed.push(chunk.text)
      if (chunk.type === 'beat') beatId = chunk.beat.id
    }
    expect(streamed.length).toBeGreaterThan(1)
    expect(runtime.adapter.reasoningEfforts[0]).toBe(ReasoningEffortId('off'))
    expect(streamKinds.slice(0, 5)).toEqual(['phase', 'media', 'media', 'media', 'media'])
    expect(streamKinds.indexOf('media')).toBeLessThan(streamKinds.indexOf('text-delta'))
    expect(phases).toEqual(['context', 'narrative', 'world-state', 'complete'])
    expect(beatId).toMatch(/^narrative-beat:/u)
    const afterNarration = await runtime.context.worldlineRuns.view({ runId: run.runId })
    expect(afterNarration.snapshot.sequence).toBe(beforeNarration.snapshot.sequence)
    const beats = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    const first = beats.records.at(-1)?.payload
    expect(first?.['modelRoute']).toMatchObject({ provider: 'mock', model: 'narrator' })
    expect(Array.isArray(first?.['eventIds']) ? first['eventIds'].length : 0).toBeGreaterThan(0)
    const retainedEventIds = Array.isArray(first?.['eventIds']) ? first['eventIds'] : []
    const causalEvents = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'world-event',
      limit: 50,
    })
    const completed = causalEvents.records.map(record => record.payload)
      .find(event => event['actionId'] === submitted.actionId && event['type'] === 'action.completed')
    expect(completed?.['id']).toBeDefined()
    expect(retainedEventIds).toContain(completed?.['id'])
    const rephrased = await runtime.context.worldlineNarrative.rephrase({
      ...run,
      beatId: worldlineBeatId(beatId),
      camera: 'first-person',
    })
    expect(rephrased.camera).toBe('first-person')
    expect(rephrased.eventIds).toEqual(first?.['eventIds'])
    expect((await runtime.context.worldlineRuns.view({ runId: run.runId })).snapshot.sequence)
      .toBe(beforeNarration.snapshot.sequence)

    const retried = await runtime.context.worldlineNarrative.retry({
      ...run,
      checkpointId: save.checkpoint.id,
      planId: prepared.plan.id,
      seed: 'retry-branch',
    })
    expect(retried.view.summary.parentRunId).toBe(run.runId)
    expect(retried.view.summary.runId).not.toBe(run.runId)
    expect(retried.view.snapshot.actionDecks).toEqual({})

    expect(runtime.context.worldlineNarrative.storyStage()).toMatchObject({
      available: true,
      renderers: [{ id: 'worldline-text-story', name: '内置视觉演绎器' }],
    })
    const renderer: StoryStageRenderer = {
      id: 'test-stage',
      name: 'Test stage',
      capabilities: ['background'],
      render: () => null,
    }
    const unregister = runtime.context.worldlineNarrative.registerRenderer(renderer)
    expect(runtime.context.worldlineNarrative.storyStage()).toMatchObject({
      available: true,
      renderers: [{ id: 'worldline-text-story' }, { id: 'test-stage' }],
    })
    unregister()
    expect(runtime.adapter.calls).toBe(8)
    expect(runtime.adapter.inputs.every(input => !input.includes('must-not-leak'))).toBe(true)
    expect(runtime.adapter.inputs[0]).toContain('第 1 周 · 周一 16:45')
    expect(runtime.adapter.inputs[0]).toContain('gameDateTime 是唯一正确的游戏日期与时刻')
    expect(runtime.adapter.inputs[0]).toContain('天气、灾变阶段、感染、灰潮、暴露和地点状态同样是权威事实')
    expect(runtime.adapter.inputs[0]).toContain('绝不能把异常现场写成毫无征兆的平静日常')
    expect(runtime.adapter.inputs[0]).toContain('6 至 12 个短故事块')
    expect(runtime.adapter.inputs[0]).toContain('必须通过 story_present_sequence 提交完整正文')
    expect(runtime.adapter.inputs[0]).toContain('dialogue 块只能放角色实际说出口的原句')
    expect(runtime.adapter.inputs[0]).toContain('动作必须另放 action，心理必须另放 thought')
    expect(runtime.adapter.inputs[0]).toContain('action 块只能写玩家可见的动作')
    expect(runtime.adapter.inputs[0]).toContain('未列入 presentCharacters 的人物不得到场或直接发言')
    expect(runtime.adapter.inputs[0]).toContain('绝不能借用另一个在场角色的 ID')
    expect(runtime.adapter.inputs[0]).toContain('档案没有明确性别或代词时')
    expect(runtime.adapter.inputs[0]).toContain('"gender":"男"')
    expect(runtime.adapter.inputs[0]).toContain('"pronouns":"他"')
    expect(runtime.adapter.inputs[0]).toContain('不得擅自新增或发现秘密、线索、书信、记录、物品')
    expect(runtime.adapter.inputs.map((input, index) => input.includes(
      '校舍广播明确提醒本阶段只剩五分钟',
    ) ? index : -1).filter(index => index >= 0)).toEqual([])
    await runtime.dispose()
  })

  it('authors and retains a grounded prologue before the first player action', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    runtime.adapter.text = [
      '<narration>微弱的光沿着窗框落进房间，远处的脚步声把寂静切成断续的几段。</narration>',
      `<thought actor="${run.actorId}">先看清这里发生了什么，再决定下一步。</thought>`,
    ].join('')
    const before = await runtime.context.worldlineRuns.view({ runId: run.runId })

    const opening = await runtime.context.worldlineNarrative.narrate(run)
    const repeated = await runtime.context.worldlineNarrative.narrate(run)
    const after = await runtime.context.worldlineRuns.view({ runId: run.runId })

    expect(opening.blocks.filter(block => block.type === 'narration'
      || block.type === 'character')).toHaveLength(2)
    expect(repeated.id).toBe(opening.id)
    expect(runtime.adapter.calls).toBe(4)
    expect(runtime.adapter.inputs[0]).toContain('这是整条世界线的第一幕')
    expect(runtime.adapter.inputs[0]).toContain('每段正文都必须先判断这一段是否真的存在')
    expect(runtime.adapter.inputs[0]).toContain('不是媒体配额')
    expect(runtime.adapter.inputs[0]).toContain('不得按轮次轮换类型')
    expect(runtime.adapter.inputs[0]).toContain('不等于默认选择 none')
    expect(runtime.adapter.inputs[0]).toContain('通常就应选择 staged')
    expect(runtime.adapter.inputs[0]).toContain('开场不能假装玩家已经作出选择')
    expect(runtime.adapter.inputs[0]).toContain('序章只负责建立舞台、人物落点和眼前局面')
    expect(runtime.adapter.inputs[0]).not.toContain('本轮的玩家行动与最新权威事件是这一段的中心')
    expect(after.snapshot.sequence).toBe(before.snapshot.sequence)
    expect(after.snapshot.logicalTime).toBe(before.snapshot.logicalTime)
    await runtime.dispose()
  })

  it('reuses the retained beat when narration is requested again at the same causal frontier', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })

    const first = await runtime.context.worldlineNarrative.narrate(run)
    const repeated = await runtime.context.worldlineNarrative.narrate(run)
    expect(repeated.id).toBe(first.id)
    expect(repeated.perspectiveActorId).toBe(run.actorId)
    expect(runtime.adapter.calls).toBe(4)

    const retained = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    expect(retained.records).toHaveLength(2)
    await runtime.dispose()
  })

  it('resumes world settlement after failure without regenerating action-bound prose', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const prepared = await prepareActionPlan(runtime.context, run, 'character.work')
    const submitted = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: prepared.plan.id,
      expectedSequence: prepared.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    vi.spyOn(runtime.context.worldlineRuns, 'recordStoryState')
      .mockRejectedValueOnce(new Error('simulated commit transport loss'))

    await expect(runtime.context.worldlineNarrative.narrate({
      ...run,
      actionId: submitted.actionId,
    })).rejects.toThrow('simulated commit transport loss')
    const afterFailure = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    expect(afterFailure.records).toHaveLength(2)
    expect(runtime.adapter.toolSets.filter(names => names.includes('story_present_sequence')))
      .toHaveLength(1)

    const recovered = await runtime.context.worldlineNarrative.narrate({
      ...run,
      actionId: submitted.actionId,
    })
    const afterRecovery = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    const view = await runtime.context.worldlineRuns.view({ runId: run.runId })
    expect(afterRecovery.records).toHaveLength(2)
    expect(recovered.id).toBe(afterFailure.records.at(-1)?.id)
    expect(view.snapshot.storyStateCommits[recovered.id]).toBeDefined()
    expect(runtime.adapter.toolSets.filter(names => names.includes('story_present_sequence')))
      .toHaveLength(1)
    await runtime.dispose()
  })

  it('binds narration to the submitted action instead of an older unsettled frontier', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const firstChoices = await runtime.context.worldlineRuns.choices(run)
    const firstChoice = firstChoices.choices.find(choice => choice.actionType === 'character.work')
    if (firstChoice === undefined) throw new Error('first work choice is missing')
    const first = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, firstChoice.actionType)).plan.id,
      expectedSequence: firstChoices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    await runtime.context.worldlineNarrative.narrate({ ...run, actionId: first.actionId })

    const secondChoices = await runtime.context.worldlineRuns.choices(run)
    const secondChoice = secondChoices.choices.find(choice => choice.actionType === 'character.work')
    if (secondChoice === undefined) throw new Error('second work choice is missing')
    const second = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, secondChoice.actionType)).plan.id,
      expectedSequence: secondChoices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })

    const beat = await runtime.context.worldlineNarrative.narrate({ ...run, actionId: second.actionId })
    const events = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'world-event',
      limit: 100,
      tail: true,
    })
    const secondEventIds = events.records.filter(record => record.payload['actionId'] === second.actionId)
      .map(record => record.id)
    const firstEventIds = events.records.filter(record => record.payload['actionId'] === first.actionId)
      .map(record => record.id)
    expect(secondEventIds.length).toBeGreaterThan(0)
    expect(beat.eventIds).toEqual(secondEventIds)
    expect(beat.eventIds.some(id => firstEventIds.includes(id))).toBe(false)
    expect(runtime.adapter.inputs.at(-1)).toContain(second.actionId)
    expect(runtime.adapter.inputs.at(-1)).not.toContain(first.actionId)
    await runtime.dispose()
  })

  it('bounds a verbose model stream before retaining it as novel prose', async () => {
    const runtime = await setup()
    runtime.adapter.text = Array.from({ length: 80 }, (_, index) => `第${String(index + 1)}句只描述权威事实。`).join('')
    const run = await createRun(runtime.context)
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    const action = await runtime.context.worldlineNarrative.choose({
      ...run,
      planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    const chunks = []
    for await (const chunk of runtime.context.worldlineNarrative.narrateStream({
      ...run,
      actionId: action.actionId,
    })) chunks.push(chunk)
    const beat = chunks.findLast(chunk => chunk.type === 'beat')
    if (beat?.type !== 'beat') throw new Error('bounded narrative beat is missing')
    expect(beat.beat.text.length).toBeLessThanOrEqual(900)
    expect(chunks.some(chunk => chunk.type === 'replace')).toBe(true)
    await runtime.dispose()
  })

  it('continues model-narrated rounds with a bounded rolling story context', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const beats: NarrativeBeatId[] = []
    for (let round = 0; round < 9; round += 1) {
      runtime.adapter.text = `<narration>第${String(round + 1)}轮只处理了眼前这件新事。</narration>`
      const choices = await runtime.context.worldlineRuns.choices(run)
      const work = choices.choices.find(choice => choice.actionType === 'character.work')
      if (work === undefined) throw new Error(`round ${String(round + 1)} has no legal work action`)
      await runtime.context.worldlineNarrative.choose({
        ...run,
        planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
        expectedSequence: choices.sequence,
      })
      await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
      const beat = await runtime.context.worldlineNarrative.narrate(run)
      expect(beat.modelRoute).toMatchObject(policy.routes.narrator!)
      expect(beat.eventIds).not.toHaveLength(0)
      beats.push(beat.id)
    }
    const view = await runtime.context.worldlineRuns.view({ runId: run.runId })
    expect(view.snapshot.aiUsage.calls).toBe(49)
    expect(view.snapshot.logicalTime).toBe(90)
    expect(new Set(beats).size).toBe(9)
    expect(runtime.adapter.calls).toBe(36)
    expect(runtime.adapter.inputs.every(input => (
      input.includes('action.completed') && !input.includes('must-not-leak')
    ))).toBe(true)
    const finalInput = runtime.adapter.inputs.findLast(input => input.includes('runtimeMemory')) ?? ''
    expect(beats.filter(beat => finalInput.includes(beat)).length).toBeLessThanOrEqual(1)
    expect(finalInput).toContain('runtimeMemory')
    expect(finalInput).toContain('recentPresentation')
    expect(finalInput).toContain('第8轮只处理了眼前这件新事')
    expect(finalInput).toContain('第7轮只处理了眼前这件新事')
    expect(finalInput).not.toContain('第1轮只处理了眼前这件新事')
    expect(Math.max(...runtime.adapter.inputs.map(input => input.length))).toBeLessThan(30_000)
    const retained = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    expect(retained.records).toHaveLength(10)
    await runtime.dispose()
  })

  it('narrates the newest causal frontier after the run grows beyond the first records page', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    for (let round = 0; round < 70; round += 1) {
      const choices = await runtime.context.worldlineRuns.choices(run)
      const work = choices.choices.find(choice => choice.actionType === 'character.work')
      if (work === undefined) throw new Error(`round ${String(round + 1)} has no legal work action`)
      await runtime.context.worldlineNarrative.choose({
        ...run,
        planId: (await prepareActionPlan(runtime.context, run, 'character.work')).plan.id,
        expectedSequence: choices.sequence,
      })
      await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
      await runtime.context.worldlineNarrative.narrate(run)
    }
    const latestEvents = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'world-event',
      limit: 20,
      tail: true,
    })
    const latestEventId = latestEvents.records.findLast(record => (
      record.payload['type'] === 'action.completed'
      && record.payload['actorId'] === run.actorId
    ))?.id
    if (latestEventId === undefined) throw new Error('latest event is missing')

    const beat = await runtime.context.worldlineNarrative.narrate(run)
    expect(beat.eventIds).toContain(latestEventId)
    expect(runtime.adapter.inputs.at(-1)).toContain(latestEventId)
    await runtime.dispose()
  })
})

function worldlineBeatId(value: string | undefined): NarrativeBeatId {
  if (value === undefined) throw new Error('narrative beat was not retained')
  return worldlineId<'narrative-beat'>(value)
}

type NarrativeBeatId = Awaited<ReturnType<Context['worldlineNarrative']['narrate']>>['id']
