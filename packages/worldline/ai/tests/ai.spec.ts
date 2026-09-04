import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Blueprint, ModelPolicy } from '@deepseek-ai/dsh-worldline-standard'
import { stableStringify } from '@deepseek-ai/dsh-worldline-standard'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorkerWorldlineRuns from '../../runtime-worker/src/index.ts'
import { testBlueprint } from '../../runtime-worker/tests/fixture.ts'
import WorldlineAi from '../src/index.ts'

const roots: string[] = []
const disposers: Array<() => Promise<void>> = []

class ChoiceAdapter extends LlmAdapter {
  calls = 0
  failNext = false
  transientFailures = 0
  partialTransientFailures = 0
  readonly inputs: string[] = []
  readonly options: GenerateOptions[] = []
  readonly credential = 'sk-provider-owned-worldline-test-secret'

  override providerRetryPolicy() {
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 3,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    }, 'worldline test retryPolicy')
  }

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
        efforts: [
          { id: ReasoningEffortId('off'), name: 'Off' },
          { id: ReasoningEffortId('medium'), name: 'Medium' },
        ],
        defaultEffort: ReasoningEffortId('medium'),
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.options.push(options)
    const input = options.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    this.inputs.push(input)
    if (this.partialTransientFailures > 0) {
      this.partialTransientFailures -= 1
      const id = CallId('call-interrupted')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'discard_me', argumentsDelta: '{}' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'discard_me', arguments: '{}' },
      }
      throw new LlmError('stream disconnected after partial output', 'TRANSPORT')
    }
    if (this.transientFailures > 0) {
      this.transientFailures -= 1
      throw new LlmError('simulated transient outage', 'TRANSPORT')
    }
    if (this.failNext) {
      this.failNext = false
      throw new Error('simulated provider outage')
    }
    const tool = options.tools?.[0]
    if (tool !== undefined) {
      const id = CallId('call-structured')
      const args = tool.name === 'story_assess_progress'
        ? JSON.stringify({
          status: 'active',
          rationale: 'The supplied evidence does not yet complete the current plot point.',
          evidence: ['The saved prose establishes only the opening situation.'],
        })
        : JSON.stringify({ mutations: [], memoryWrites: [] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: tool.name, argumentsDelta: args }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: tool.name, arguments: args },
      }
      yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
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

async function createRun(
  context: Context,
  privateMarker?: string,
): Promise<{
  readonly runId: Awaited<ReturnType<Context['worldlineRuns']['create']>>['summary']['runId']
  readonly actorId: Blueprint['entities'][number]['id']
  readonly projectPath: string
}> {
  const project = await context.worldlineProjects.create({ name: 'AI World', template: 'blank' })
  const base = testBlueprint()
  const blueprint: Blueprint = {
    ...base,
    projectId: project.manifest.id,
    modelPolicy: policy,
    entities: base.entities.map((entity, index) => ({
      ...entity,
      lod: 'L3' as const,
      facets: index === 1 && privateMarker !== undefined
        ? { ...entity.facets, privateMarker }
        : entity.facets,
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
    seed: 'ai-run-seed',
    modelPolicy: policy,
    startPaused: false,
  })
  const actor = blueprint.entities[0]
  if (actor === undefined) throw new Error('AI fixture has no actor')
  return { runId: run.summary.runId, actorId: actor.id, projectPath: project.path }
}

async function treeContains(root: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (await treeContains(path, needle)) return true
    } else if (entry.isFile() && (await readFile(path)).includes(Buffer.from(needle))) return true
  }
  return false
}

afterEach(async () => {
  await Promise.allSettled(disposers.splice(0).map(dispose => dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorldlineAi', () => {
  it('disables hidden reasoning and gives state/progress tools purpose-specific authority', async () => {
    const runtime = await harness()
    const run = await createRun(runtime.context)
    const before = await runtime.context.worldlineRuns.view({ runId: run.runId })
    await runtime.context.worldlineRuns.switchModel({
      runId: run.runId,
      expectedSequence: before.snapshot.sequence,
      modelPolicy: {
        ...policy,
        routes: {
          ...policy.routes,
          creative: { provider: 'mock', model: 'planner' },
        },
      },
    })
    const view = await runtime.context.worldlineRuns.view({ runId: run.runId })
    const pack = await runtime.context.worldlineAi.contextPack({
      runId: run.runId,
      actorId: run.actorId,
      purpose: 'creative',
    })
    const chunks = []
    for await (const chunk of runtime.context.worldlineAi.streamText({
      runId: run.runId,
      actorId: run.actorId,
      purpose: 'creative',
      contextPack: pack,
      tools: [{
        name: 'story_propose_state_update',
        description: 'test state update',
        parameters: { type: 'object' },
      }],
    })) chunks.push(chunk)
    const generated = runtime.adapter.options.at(-1)
    expect(view.snapshot.modelPolicy.routes.creative?.reasoningEffort).toBeUndefined()
    expect(generated?.reasoningEffort).toBe('off')
    expect(generated?.system).toContain('schema-allowed world, character, and memory changes')
    expect(generated?.system).not.toContain('never invent a result or world-state change')
    expect(chunks.some(chunk => chunk.type === 'tool-call')).toBe(true)
    await runtime.dispose()
  })

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
    expect(await treeContains(run.projectPath, runtime.adapter.credential)).toBe(false)
    await runtime.dispose()
  })

  it('retains usage telemetry without a story-stopping quota', async () => {
    const runtime = await harness()
    const run = await createRun(runtime.context)
    const result = await runtime.context.worldlineAi.decide(run)
    expect(result).toMatchObject({ status: 'submitted' })
    expect(runtime.adapter.calls).toBe(1)
    const view = await runtime.context.worldlineRuns.view({ runId: run.runId })
    expect(view.snapshot.aiUsage.calls).toBe(1)
    expect(view.snapshot).not.toHaveProperty('aiBudget')
    await runtime.dispose()
  })

  it('automatically retries transient streams and records each isolated attempt', async () => {
    const runtime = await harness()
    const run = await createRun(runtime.context)
    runtime.adapter.transientFailures = 2
    const pack = await runtime.context.worldlineAi.contextPack(run)
    const chunks = []
    for await (const chunk of runtime.context.worldlineAi.streamText({
      ...run,
      purpose: 'creative',
      contextPack: pack,
      tools: [{ name: 'story_propose_state_update', description: 'test', parameters: { type: 'object' } }],
    })) chunks.push(chunk)

    expect(runtime.adapter.calls).toBe(3)
    expect(chunks.filter(chunk => chunk.type === 'retry')).toMatchObject([
      { attempt: 2, maxAttempts: 4, delayMs: 1, failure: { code: 'TRANSPORT' } },
      { attempt: 3, maxAttempts: 4, delayMs: 1, failure: { code: 'TRANSPORT' } },
    ])
    expect(chunks.filter(chunk => chunk.type === 'tool-call')).toHaveLength(1)
    expect(chunks.at(-1)?.type).toBe('finish')
    const invocations = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'ai-invocation',
      limit: 10,
    })
    expect(invocations.records.map(item => item.payload['outcome']))
      .toEqual(['failed', 'failed', 'completed'])
    await runtime.dispose()
  })

  it('discards partial failed-attempt output and stops after the provider retry bound', async () => {
    const runtime = await harness()
    const run = await createRun(runtime.context)
    const pack = await runtime.context.worldlineAi.contextPack(run)
    runtime.adapter.partialTransientFailures = 1
    const recovered = []
    for await (const chunk of runtime.context.worldlineAi.streamText({
      ...run,
      purpose: 'creative',
      contextPack: pack,
      tools: [{ name: 'story_propose_state_update', description: 'test', parameters: { type: 'object' } }],
    })) recovered.push(chunk)
    expect(recovered.some(chunk => chunk.type === 'tool-call' && chunk.name === 'discard_me'))
      .toBe(false)
    expect(recovered.filter(chunk => chunk.type === 'tool-call')).toHaveLength(1)

    runtime.adapter.transientFailures = 5
    await expect(async () => {
      for await (const _chunk of runtime.context.worldlineAi.streamText({
        ...run,
        purpose: 'creative',
        contextPack: pack,
      })) { /* consume */ }
    }).rejects.toThrow('4 次尝试后仍失败')
    expect(runtime.adapter.transientFailures).toBe(1)
    await runtime.dispose()
  })

  it('keeps another actor private and never accumulates unrelated context', async () => {
    const runtime = await harness()
    const marker = 'OTHER_ACTOR_PRIVATE_CONTEXT_MUST_NOT_LEAK'
    const run = await createRun(runtime.context, marker)
    const pack = await runtime.context.worldlineAi.contextPack(run)
    expect(stableStringify(pack)).not.toContain(marker)

    const result = await runtime.context.worldlineAi.decide(run)
    expect(result.status).toBe('submitted')
    expect(runtime.adapter.inputs).toHaveLength(1)
    expect(runtime.adapter.inputs[0]).not.toContain(marker)
    await runtime.dispose()
  })

  it('records a provider outage while deterministic time keeps advancing', async () => {
    const runtime = await harness()
    const run = await createRun(runtime.context)
    const before = await runtime.context.worldlineRuns.view({ runId: run.runId })
    runtime.adapter.failNext = true

    const result = await runtime.context.worldlineAi.decide(run)
    expect(result).toMatchObject({ status: 'model-failed' })
    expect(result.message).toContain('deterministic Runtime remains active')
    const invocations = await runtime.context.worldlineRuns.records({
      runId: run.runId,
      stream: 'ai-invocation',
      limit: 10,
    })
    expect(invocations.records).toHaveLength(1)
    expect(invocations.records[0]?.payload['outcome']).toBe('failed')

    const advanced = await runtime.context.worldlineRuns.advance({ runId: run.runId, duration: 10 })
    expect(advanced.snapshot.logicalTime).toBeGreaterThan(before.snapshot.logicalTime)
    expect(advanced.summary.status).toBe('running')
    await runtime.dispose()
  })
})
