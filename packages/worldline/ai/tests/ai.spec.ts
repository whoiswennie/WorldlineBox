import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { AiBudget, Blueprint, ModelPolicy } from '@deepseek-ai/dsh-worldline-standard'
import { stableStringify } from '@deepseek-ai/dsh-worldline-standard'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorkerWorldlineRuns from '../../runtime-worker/src/index.ts'
import { testBlueprint } from '../../runtime-worker/tests/fixture.ts'
import WorldlineAi from '../src/index.ts'

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

class ChoiceAdapter extends LlmAdapter {
  calls = 0

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'planner', name: 'Planner' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Planner',
      context: { contextWindow: 4096 },
      defaultMaxTokens: 256,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }],
        defaultEffort: ReasoningEffortId('medium'),
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const input = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const choiceId = /"id":"(choice:[^"]+)"/u.exec(input)?.[1]
    if (choiceId === undefined) throw new Error('Context Pack contains no projected choice')
    const text = JSON.stringify({ choiceId, rationale: 'The listed action advances my goal.', confidence: 0.8 })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  readonly context: Context
  readonly adapter: ChoiceAdapter
  readonly dispose: () => Promise<void>
}

const policy: ModelPolicy = {
  routes: { character: { provider: 'mock', model: 'planner', reasoningEffort: 'medium' } },
  aiEnabled: true,
  revision: 'sha256:ai-policy' as ModelPolicy['revision'],
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

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-ai-'))
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
  const adapter = new ChoiceAdapter()
  context.llm.registerAdapter(['mock'], adapter)
  const meter = context.plugin(TokenMeter)
  await meter.await()
  const runs = context.plugin(WorkerWorldlineRuns, {
    maxOldGenerationSizeMb: 128,
    requestTimeoutMs: 15_000,
  })
  await runs.await()
  const ai = context.plugin(WorldlineAi, {
    routePrices: [{
      provider: 'mock',
      model: 'planner',
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.5,
    }],
    fallbackInputPerMillion: 30,
    fallbackOutputPerMillion: 60,
    fallbackCacheReadPerMillion: 10,
    maxContextRecords: 500,
    l2MinLogicalInterval: 3600,
  })
  await ai.await()
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await ai.dispose()
    await runs.dispose()
    await meter.dispose()
    await llm.dispose()
    await projects.dispose()
  }
  disposers.push(dispose)
  return {
    context,
    adapter,
    dispose,
  }
}

async function createRun(context: Context, runBudget: AiBudget = budget): Promise<{
  readonly runId: Awaited<ReturnType<Context['worldlineRuns']['create']>>['summary']['runId']
  readonly actorId: Blueprint['entities'][number]['id']
}> {
  const project = await context.worldlineProjects.create({ name: 'AI World', template: 'blank' })
  const base = testBlueprint()
  const blueprint: Blueprint = {
    ...base,
    projectId: project.manifest.id,
    modelPolicy: policy,
    entities: base.entities.map(entity => ({ ...entity, lod: 'L3' as const })),
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
    seed: 'ai-run-seed',
    modelPolicy: policy,
    aiBudget: runBudget,
    startPaused: false,
  })
  const actor = blueprint.entities[0]
  if (actor === undefined) throw new Error('AI fixture has no actor')
  return { runId: run.summary.runId, actorId: actor.id }
}

afterEach(async () => {
  await Promise.allSettled(disposers.splice(0).map(dispose => dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorldlineAi', () => {
  it('builds a hard-bounded Context Pack and records a legal model intent before its Action', async () => {
    const runtime = await harness()
    const run = await createRun(runtime.context)
    const pack = await runtime.context.worldlineAi.contextPack(run)
    expect(pack.totalTokens).toBeLessThanOrEqual(pack.inputLimit)
    expect(pack.inputLimit).toBeLessThanOrEqual(Math.floor(pack.contextWindow * 0.75))
    expect(pack.totalTokens + pack.reservedOutputTokens + pack.reservedToolTokens)
      .toBeLessThanOrEqual(pack.contextWindow)

    const result = await runtime.context.worldlineAi.decide(run)
    expect(result.status, result.message).toBe('submitted')
    expect(result.action?.process.state).toBe('started')
    expect(runtime.adapter.calls).toBe(1)
    const invocations = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'ai-invocation',
      limit: 10,
    })
    const intents = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'ai-intent',
      limit: 10,
    })
    expect(invocations.records).toHaveLength(1)
    expect(intents.records).toHaveLength(1)
    expect(intents.records[0]?.payload['invocationId']).toBe(invocations.records[0]?.id)
    expect(result.action?.view.snapshot.aiUsage).toMatchObject({
      calls: 1,
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheHits: 1,
    })
    await runtime.dispose()
  })

  it('blocks before provider IO when any hard budget is exhausted', async () => {
    const runtime = await harness()
    const run = await createRun(runtime.context, { ...budget, maxCalls: 0 })
    const result = await runtime.context.worldlineAi.decide(run)
    expect(result).toMatchObject({ status: 'budget-blocked' })
    expect(result.budget?.reasons).toContain('Call budget is exhausted.')
    expect(runtime.adapter.calls).toBe(0)
    await runtime.dispose()
  })
})
