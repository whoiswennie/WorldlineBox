import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { AiBudget, Blueprint, ModelPolicy, StoryStageRenderer } from '@deepseek-ai/dsh-worldline-standard'
import { stableStringify, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import WorldlineAi from '../../ai/src/index.ts'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorkerWorldlineRuns from '../../runtime-worker/src/index.ts'
import { testBlueprint } from '../../runtime-worker/tests/fixture.ts'
import WorldlineNarrative from '../src/index.ts'

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

class NarratorAdapter extends LlmAdapter {
  calls = 0
  readonly inputs: string[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Narrator',
      context: { contextWindow: 4096 },
      defaultMaxTokens: 256,
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.inputs.push(options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    const text = 'The traveller completes the recorded task.'
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

const budget: AiBudget = {
  maxCalls: 10,
  maxInputTokens: 10_000,
  maxOutputTokens: 5000,
  maxConcurrent: 1,
  maxCallsPerLogicalDay: 10,
  maxCallsPerRealHour: 10,
  maxEstimatedCost: 10,
  currency: 'USD',
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

async function createRun(context: Context): Promise<{
  readonly runId: Awaited<ReturnType<Context['worldlineRuns']['create']>>['summary']['runId']
  readonly actorId: Blueprint['entities'][number]['id']
}> {
  const project = await context.worldlineProjects.create({ name: 'Narrative World', template: 'blank' })
  const base = testBlueprint()
  const blueprint: Blueprint = {
    ...base,
    projectId: project.manifest.id,
    modelPolicy: policy,
    entities: base.entities.map((entity, index) => ({
      ...entity,
      facets: index === 1 ? { secret: 'must-not-leak' } : entity.facets,
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
    modelPolicy: policy,
    aiBudget: budget,
    startPaused: false,
  })
  const actor = blueprint.entities[0]
  if (actor === undefined) throw new Error('narrative fixture has no actor')
  return { runId: run.summary.runId, actorId: actor.id }
}

afterEach(async () => {
  await Promise.allSettled(disposers.splice(0).map(dispose => dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorldlineNarrative', () => {
  it('matches a Chinese natural-language intent to one legal action', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const choices = await runtime.context.worldlineRuns.choices(run)
    const result = await runtime.context.worldlineNarrative.freeInput({
      ...run,
      text: '我想先工作一会儿',
      expectedSequence: choices.sequence,
    })
    expect(result.status).toBe('submitted')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.actionType).toBe('character.work')
    expect((await runtime.context.worldlineRuns.view(run)).controls[run.actorId]).toBe('player')
    await runtime.dispose()
  })

  it('streams source-bound prose without mutating the world and retries only by branching', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    await runtime.context.worldlineRuns.setControl({ ...run, mode: 'player' })
    const scene = await runtime.context.worldlineNarrative.scene(run)
    expect(stableStringify(scene.visibleState)).not.toContain('must-not-leak')
    const save = await runtime.context.worldlineNarrative.save({ ...run, label: 'Before work' })
    const choices = await runtime.context.worldlineRuns.choices(run)
    const work = choices.choices.find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work choice is missing')
    await runtime.context.worldlineNarrative.choose({
      ...run,
      choiceId: work.id,
      expectedSequence: choices.sequence,
    })
    await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    const beforeNarration = await runtime.context.worldlineRuns.view({ runId: run.runId })
    const streamed: string[] = []
    let beatId: string | undefined
    for await (const chunk of runtime.context.worldlineNarrative.narrateStream(run)) {
      if (chunk.type === 'text-delta') streamed.push(chunk.text)
      if (chunk.type === 'beat') beatId = chunk.beat.id
    }
    expect(streamed.length).toBeGreaterThan(1)
    expect(beatId).toMatch(/^narrative-beat:/u)
    const afterNarration = await runtime.context.worldlineRuns.view({ runId: run.runId })
    expect(afterNarration.snapshot.sequence).toBe(beforeNarration.snapshot.sequence)
    const beats = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    const first = beats.records[0]?.payload
    expect(first?.['style']).toBe('llm')
    expect(Array.isArray(first?.['eventIds']) ? first['eventIds'].length : 0).toBeGreaterThan(0)
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
      choiceId: work.id,
      seed: 'retry-branch',
    })
    expect(retried.view.summary.parentRunId).toBe(run.runId)
    expect(retried.view.summary.runId).not.toBe(run.runId)

    expect(runtime.context.worldlineNarrative.storyStage()).toMatchObject({
      available: true,
      renderers: [{ id: 'worldline-text-story', name: '内置文字故事舞台' }],
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
    expect(runtime.adapter.calls).toBe(2)
    expect(runtime.adapter.inputs.every(input => !input.includes('must-not-leak'))).toBe(true)
    await runtime.dispose()
  })

  it('continues six model-narrated rounds from authoritative action evidence', async () => {
    const runtime = await setup()
    const run = await createRun(runtime.context)
    const beats: NarrativeBeatId[] = []
    for (let round = 0; round < 6; round += 1) {
      const choices = await runtime.context.worldlineRuns.choices(run)
      const work = choices.choices.find(choice => choice.actionType === 'character.work')
      if (work === undefined) throw new Error(`round ${String(round + 1)} has no legal work action`)
      await runtime.context.worldlineNarrative.choose({
        ...run,
        choiceId: work.id,
        expectedSequence: choices.sequence,
      })
      await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
      const beat = await runtime.context.worldlineNarrative.narrate(run)
      expect(beat.style).toBe('llm')
      expect(beat.eventIds).not.toHaveLength(0)
      beats.push(beat.id)
    }
    const view = await runtime.context.worldlineRuns.view({ runId: run.runId })
    expect(view.snapshot.aiUsage.calls).toBe(6)
    expect(view.snapshot.logicalTime).toBe(60)
    expect(new Set(beats).size).toBe(6)
    expect(runtime.adapter.calls).toBe(6)
    expect(runtime.adapter.inputs.every(input => (
      input.includes('action.completed') && !input.includes('must-not-leak')
    ))).toBe(true)
    const retained = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'narrative-beat',
      limit: 10,
    })
    expect(retained.records).toHaveLength(6)
    await runtime.dispose()
  })
})

function worldlineBeatId(value: string | undefined): NarrativeBeatId {
  if (value === undefined) throw new Error('narrative beat was not retained')
  return worldlineId<'narrative-beat'>(value)
}

type NarrativeBeatId = Awaited<ReturnType<Context['worldlineNarrative']['narrate']>>['id']
