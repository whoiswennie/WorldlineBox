import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stableStringify, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import type { Blueprint, ModelRoute } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineKernel } from '../src/kernel.ts'
import { testBlueprint } from './fixture.ts'

const roots: string[] = []

async function kernel(
  seed = 'deterministic-seed',
  blueprint: Blueprint = testBlueprint(),
): Promise<WorldlineKernel> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-kernel-'))
  roots.push(root)
  return new WorldlineKernel({
    projectId: worldlineId<'project'>('project:test-project-0001'),
    runId: worldlineId<'run'>(`run:${seed.replaceAll('_', '-').padEnd(8, '0')}`),
    blueprint,
    databasePath: join(root, 'world.sqlite'),
    seed,
    startPaused: false,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorldlineKernel', () => {
  it('records AI usage as diagnostics without exposing a story-stopping quota', async () => {
    const run = await kernel('ai-usage-seed')
    const initial = run.view()
    expect(initial.snapshot).not.toHaveProperty('aiBudget')
    const recorded = run.recordAiInvocation({
      runId: initial.summary.runId,
      purpose: 'narrator',
      modelRoute: { provider: 'mock', model: 'narrator' },
      contextSourceIds: [],
      inputTokens: 120,
      outputTokens: 30,
      estimatedCost: 0.002,
      outputDigest: 'a'.repeat(64),
      outcome: 'completed',
    })
    expect(recorded.view.snapshot.aiUsage).toMatchObject({
      calls: 1,
      inputTokens: 120,
      outputTokens: 30,
      estimatedCost: 0.002,
    })
    run.close()
  })

  it('projects the retained frozen Blueprint for simulation inspection', async () => {
    const run = await kernel('definition-projection-seed')
    const definition = run.definitionView()
    expect(definition).toMatchObject({
      blueprintDigest: 'a'.repeat(64),
      purpose: { detail: 'L2' },
      systems: [{ id: 'world.clock' }],
      invariants: [{ id: 'world.time.nonnegative' }],
    })
    expect(definition.actions.map(action => action.id)).toContain('character.move')
    expect(definition.entities).toHaveLength(2)
    expect(definition.entities[0]).not.toHaveProperty('memory')
    run.close()
  })

  it('advances through a Future Event Queue without tick heartbeat events', async () => {
    const run = await kernel()
    const view = run.advance({ runId: run.view().summary.runId, duration: 300 })
    expect(view.snapshot.logicalTime).toBe(300)
    expect((view.snapshot.state['world'] as { time: number }).time).toBe(300)
    expect(view.health.futureQueueDepth).toBe(1)
    const events = run.records({ runId: view.summary.runId, stream: 'world-event', limit: 100 })
    expect(events.records).toHaveLength(5)
    expect(events.records.every(item => item.payload['type'] === 'system.effects-committed')).toBe(true)
    run.close()
  })

  it('keeps an authored era stable while projecting logical time into the calendar', async () => {
    const base = testBlueprint()
    const blueprint: Blueprint = {
      ...base,
      canon: [{
        id: worldlineId<'entity'>('entity:calendar-charter'),
        kind: 'charter',
        documentId: worldlineId<'document'>('document:calendar-charter'),
        title: '镜潮历法',
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
                daysPerSeason: 9,
                seasons: ['第一伪月周期', '第二伪月周期', '第三伪月周期', '第四伪月周期',
                  '第五伪月周期', '第六伪月周期'],
                startDayIndex: 53,
                startClockMinute: 1_397,
              },
              year: 218,
              season: '第六伪月周期',
              day: 8,
              time: '23:17',
            },
          },
        },
        provenance: [],
      }],
    }
    const run = await kernel('authored-calendar-seed', blueprint)
    const advanced = run.advance({ runId: run.view().summary.runId, duration: 45 * 60 })
    const world = advanced.snapshot.state['world'] as Record<string, unknown>
    expect(world).toMatchObject({
      year: 218,
      season: '第六伪月周期',
      day: 9,
      time: '00:02',
      calendar: {
        startYear: 218,
        startSeason: '第六伪月周期',
        startDayOfSeason: 8,
        year: 218,
        season: '第六伪月周期',
        dayOfSeason: 9,
        timeOfDaySeconds: 120,
      },
    })
    run.close()
  })

  it('moves only through route milestones and never teleports an ordinary move', async () => {
    const run = await kernel('movement-seed')
    const actorId = worldlineId<'entity'>('entity:actor-a1')
    const submitted = run.submitAction({
      runId: run.view().summary.runId,
      actorId,
      type: 'character.move',
      parameters: { destination: 'map-node:c-node-00001' },
      expectedSequence: 0,
      controller: 'agent',
    })
    expect(submitted.process).toMatchObject({ state: 'started', movement: { remainingDuration: 30 } })
    const before = run.advance({ runId: submitted.view.summary.runId, duration: 9 })
    expect(((before.snapshot.state['entities'] as Record<string, { state: { locationId: string } }>)[actorId]?.state.locationId))
      .toBe('map-node:a-node-00001')
    const firstEdge = run.advance({ runId: submitted.view.summary.runId, duration: 1 })
    expect(((firstEdge.snapshot.state['entities'] as Record<string, { state: { locationId: string } }>)[actorId]?.state.locationId))
      .toBe('map-node:b-node-00001')
    const arrived = run.advance({ runId: submitted.view.summary.runId, duration: 20 })
    expect(((arrived.snapshot.state['entities'] as Record<string, { state: { locationId: string } }>)[actorId]?.state.locationId))
      .toBe('map-node:c-node-00001')
    expect(arrived.snapshot.processes.find(item => item.id === submitted.process.id)?.state).toBe('completed')
    run.close()
  })

  it('keeps place-bound actions unavailable until Runtime movement reaches the authored node', async () => {
    const base = testBlueprint()
    const blueprint: Blueprint = {
      ...base,
      actions: base.actions.map((action) => {
        if (action.id !== 'character.work') return action
        return {
          ...action,
          location: {
            mode: 'at' as const,
            nodeIds: [worldlineId<'map-node'>('map-node:c-node-00001')],
          },
        }
      }),
    }
    const run = await kernel('place-bound-action-seed', blueprint)
    const actorId = worldlineId<'entity'>('entity:actor-a1')
    const initial = run.view()
    expect(run.choices({ runId: initial.summary.runId, actorId }).choices
      .some(choice => choice.actionType === 'character.work')).toBe(false)
    expect(() => run.submitAction({
      runId: initial.summary.runId,
      actorId,
      type: 'character.work',
      expectedSequence: initial.snapshot.sequence,
      controller: 'agent',
    })).toThrow(/actor location/u)
    run.submitAction({
      runId: initial.summary.runId,
      actorId,
      type: 'character.move',
      parameters: { destination: 'map-node:c-node-00001' },
      expectedSequence: initial.snapshot.sequence,
      controller: 'agent',
    })
    const arrived = run.advance({ runId: initial.summary.runId, duration: 30 })
    expect(run.choices({ runId: arrived.summary.runId, actorId }).choices
      .some(choice => choice.actionType === 'character.work')).toBe(true)
    run.close()
  })

  it('projects a bounded frozen map with actor positions and movement progress', async () => {
    const run = await kernel('spatial-projection-seed')
    const actorId = worldlineId<'entity'>('entity:actor-a1')
    const initial = run.view()
    const submitted = run.submitAction({
      runId: initial.summary.runId,
      actorId,
      type: 'character.move',
      parameters: { destination: 'map-node:c-node-00001' },
      expectedSequence: initial.snapshot.sequence,
      controller: 'agent',
    })
    const spatial = run.spatial({
      runId: initial.summary.runId,
      viewport: { left: -0.5, top: -0.5, right: 1.5, bottom: 0.5 },
      maxNodes: 50,
    })
    expect(spatial.map).toMatchObject({ name: 'Test map', totalNodes: 4, totalEdges: 2 })
    expect(spatial.map?.nodes.map(node => node.name)).toEqual(['Root', 'A', 'B'])
    expect(spatial.map?.edges).toHaveLength(1)
    expect(spatial.actors).toContainEqual({ actorId, nodeId: 'map-node:a-node-00001' })
    expect(spatial.movements).toContainEqual(expect.objectContaining({
      processId: submitted.process.id,
      actorId,
      origin: 'map-node:a-node-00001',
      destination: 'map-node:c-node-00001',
      route: ['map-node:a-node-00001', 'map-node:b-node-00001', 'map-node:c-node-00001'],
      remainingDuration: 30,
    }))
    run.close()
  })

  it('acquires multiple claims atomically and ages a waiter until resources release', async () => {
    const run = await kernel('fairness-seed')
    const actorA = worldlineId<'entity'>('entity:actor-a1')
    const actorB = worldlineId<'entity'>('entity:actor-b1')
    const first = run.submitAction({
      runId: run.view().summary.runId, actorId: actorA, type: 'character.work',
      expectedSequence: 0, controller: 'agent',
    })
    const second = run.submitAction({
      runId: first.view.summary.runId, actorId: actorB, type: 'character.work',
      expectedSequence: first.view.snapshot.sequence, controller: 'agent',
    })
    expect(second.process.state).toBe('admitted')
    expect(second.process.reservationIds).toEqual([])
    run.advance({ runId: second.view.summary.runId, duration: 15 })
    const view = run.view()
    expect(view.snapshot.processes.find(item => item.id === first.process.id)?.state).toBe('completed')
    expect(view.snapshot.processes.find(item => item.id === second.process.id)?.state).toBe('started')
    expect(view.health.fairnessInterventions).toBeGreaterThan(0)
    run.close()
  })

  it('reserves bounded route capacity before departure and wakes the next mover on release', async () => {
    const run = await kernel('route-capacity-seed')
    const runId = run.view().summary.runId
    const destination = 'map-node:c-node-00001'
    const first = run.submitAction({
      runId,
      actorId: worldlineId<'entity'>('entity:actor-a1'),
      type: 'character.move',
      parameters: { destination },
      expectedSequence: 0,
      controller: 'agent',
    })
    const second = run.submitAction({
      runId,
      actorId: worldlineId<'entity'>('entity:actor-b1'),
      type: 'character.move',
      parameters: { destination },
      expectedSequence: first.view.snapshot.sequence,
      controller: 'agent',
    })
    expect(first.process.reservationIds).toHaveLength(1)
    expect(second.process).toMatchObject({ state: 'admitted', reservationIds: [] })
    const released = run.advance({ runId, duration: 30 })
    expect(released.snapshot.processes.find(item => item.id === first.process.id)?.state)
      .toBe('completed')
    expect(released.snapshot.processes.find(item => item.id === second.process.id)?.state)
      .toBe('started')
    expect(released.snapshot.reservations.some(item => item.processId === second.process.id)).toBe(true)
    run.close()
  })

  it('replays identical seeds and commands to an identical snapshot', async () => {
    const left = await kernel('replay-seed')
    const right = await kernel('replay-seed')
    for (const run of [left, right]) {
      const initial = run.view()
      run.submitAction({
        runId: initial.summary.runId,
        actorId: worldlineId<'entity'>('entity:actor-a1'),
        type: 'character.work',
        expectedSequence: initial.snapshot.sequence,
        controller: 'agent',
      })
      run.advance({ runId: initial.summary.runId, duration: 180 })
    }
    expect(stableStringify(left.view().snapshot)).toBe(stableStringify(right.view().snapshot))
    left.close(); right.close()
  })

  it('preserves authored memory and records private observations for dotted stable IDs', async () => {
    const base = testBlueprint()
    const actorId = worldlineId<'entity'>('entity:actor.with-dot')
    const original = base.entities[0]
    if (original === undefined) throw new Error('test Blueprint has no actor')
    const blueprint: Blueprint = {
      ...base,
      entities: [{
        ...original,
        id: actorId,
        memory: {
          ...original.memory,
          goals: [{
            id: worldlineId<'memory'>('memory:authored-goal-0001'),
            actorId,
            logicalTime: 0,
            sourceEventIds: [],
            importance: 1,
            goal: 'Finish one unit of work.',
            status: 'active',
          }],
        },
      }],
    }
    const run = await kernel('memory-seed', blueprint)
    const initial = run.view()
    run.submitAction({
      runId: initial.summary.runId,
      actorId,
      type: 'character.work',
      expectedSequence: 0,
      controller: 'agent',
    })
    const completed = run.advance({ runId: initial.summary.runId, duration: 10 })
    const entity = (completed.snapshot.state['entities'] as Record<string, {
      state: { energy: number }
      memory: { episodic: unknown[]; experience: { outcome: string }[]; goals: unknown[] }
    }>)[actorId]
    expect(entity?.state.energy).toBe(1)
    expect(entity?.memory.goals).toHaveLength(1)
    expect(entity?.memory.episodic.length).toBeGreaterThan(0)
    expect(entity?.memory.experience).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'completed' }),
    ]))
    expect(completed.snapshot.state['entities']).not.toHaveProperty('entity:actor')
    run.close()
  })

  it('uses the same actor scope for preconditions, effects, and invariants', async () => {
    const base = testBlueprint()
    const actorA = base.entities[0]
    const actorB = base.entities[1]
    if (actorA === undefined || actorB === undefined) throw new Error('test Blueprint needs two actors')
    const blueprint: Blueprint = {
      ...base,
      entities: [
        { ...actorA, state: { ...actorA.state, letters: 1 } },
        actorB,
      ],
      actions: [{
        id: 'letter.deliver',
        description: '投递一封信',
        actorTypes: ['character'],
        preconditions: [{ op: 'gte', path: 'state.letters', value: 1 }],
        claims: [],
        duration: 1,
        effects: [{ op: 'increment', path: 'state.letters', amount: -1, min: 0 }],
        interruptible: true,
        maxWait: 10,
        maxRetries: 1,
        fallbacks: [],
        provenance: base.provenance,
      }],
      invariants: [{
        id: 'letters.nonnegative',
        description: '持有信件的角色不能出现负数',
        expression: { op: 'gte', path: 'state.letters', value: 0 },
        provenance: base.provenance,
      }],
    }
    const run = await kernel('actor-scope-seed', blueprint)
    const runId = run.view().summary.runId
    expect(run.choices({ runId, actorId: actorA.id }).choices).toHaveLength(1)
    expect(run.choices({ runId, actorId: actorB.id }).choices).toHaveLength(0)
    const submitted = run.submitAction({
      runId,
      actorId: actorA.id,
      type: 'letter.deliver',
      expectedSequence: 0,
      controller: 'agent',
    })
    const completed = run.advance({ runId, duration: 1 })
    expect(completed.snapshot.processes.find(item => item.id === submitted.process.id)?.state)
      .toBe('completed')
    expect((completed.snapshot.state.entities as Record<string, { state: { letters?: number } }>)[actorA.id]?.state.letters)
      .toBe(0)
    expect(run.records({ runId, stream: 'runtime-diagnostic', limit: 10 }).records).toEqual([])
    run.close()
  })

  it('rejects forged AI audit records and accepts only a current projected choice', async () => {
    const run = await kernel('ai-audit-seed')
    const view = run.view()
    const actorId = worldlineId<'entity'>('entity:actor-a1')
    const route: ModelRoute = { provider: 'mock', model: 'planner' }
    const choice = run.choices({ runId: view.summary.runId, actorId }).choices[0]
    if (choice === undefined) throw new Error('test actor has no projected choice')
    expect(() => run.recordAiInvocation({
      runId: view.summary.runId,
      purpose: 'character',
      actorId,
      modelRoute: route,
      contextSourceIds: [choice.id],
      inputTokens: 10,
      outputTokens: 2,
      estimatedCost: 0.001,
      outputDigest: 'not-a-digest',
      outcome: 'completed',
    })).toThrow(/lowercase SHA-256/u)
    const invocation = run.recordAiInvocation({
      runId: view.summary.runId,
      purpose: 'character',
      actorId,
      modelRoute: route,
      contextSourceIds: [choice.id],
      inputTokens: 10,
      outputTokens: 2,
      estimatedCost: 0.001,
      outputDigest: 'a'.repeat(64),
      outcome: 'completed',
    }).invocation
    const intent = {
      runId: view.summary.runId,
      actorId,
      invocationId: invocation.id,
      choiceId: choice.id,
      actionType: choice.actionType,
      parameters: choice.parameters,
      rationale: 'I selected the current projected action.',
      confidence: 0.75,
      modelRoute: route,
      contextSourceIds: [choice.id],
    }
    expect(() => run.recordAiIntent({ ...intent, actionType: 'forged.action' }))
      .toThrow(/projected legal choice/u)
    expect(() => run.recordAiIntent({
      ...intent,
      modelRoute: { provider: 'other', model: 'planner' },
    })).toThrow(/matching recorded invocation/u)
    expect(run.recordAiIntent(intent).intent).toMatchObject({
      choiceId: choice.id,
      actionType: choice.actionType,
      parameters: choice.parameters,
    })
    run.close()
  })

  it('advances plot goals only through retained state-director evidence, never an action id', async () => {
    const base = testBlueprint()
    const point = {
      id: 'plot-point:evidence-only',
      name: '确认彼此的约定',
      summary: '两位角色需要在真实互动中确认同一件事。',
      order: 1,
      entryCondition: '双方都在同一地点。',
      completionCriteria: '双方明确确认约定内容。',
      dramaticPressure: '地点即将关闭。',
      successOutcome: '两人开始共同面对下一次危机。',
      failureOutcome: '误会继续扩大。',
      recoveryHook: '遗留消息可在另一地点重建联系。',
      timing: {
        activateAt: 0,
        deadlineAt: 3_600,
        interventions: [{
          id: 'plot-intervention:closing-warning',
          at: 3_000,
          title: '闭馆提醒',
          description: '广播宣布地点将在十分钟后关闭。',
        }],
      },
      provenance: base.provenance,
    }
    const run = await kernel('story-evidence-seed', { ...base, plotPoints: [point] })
    const runId = run.view().summary.runId
    const actorId = worldlineId<'entity'>('entity:actor-a1')
    const work = run.choices({ runId, actorId }).choices
      .find(choice => choice.actionType === 'character.work')
    if (work === undefined) throw new Error('work capability is missing')
    run.setControl({ runId, actorId, mode: 'player' })
    run.submitAction({
      runId,
      actorId,
      type: work.actionType,
      parameters: work.parameters,
      expectedSequence: 0,
      controller: 'player',
    })
    run.advance({ runId, duration: 10 })
    expect(run.view().snapshot.storyProgress).toEqual({})

    const eventIds = run.records({ runId, stream: 'world-event', limit: 100 }).records
      .map(record => record.id)
    const text = '工作结束后，两个人仍没有谈到约定。'
    const route: ModelRoute = { provider: 'mock', model: 'director' }
    const narrator = run.recordAiInvocation({
      runId,
      purpose: 'narrator',
      actorId,
      modelRoute: route,
      contextSourceIds: eventIds,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 0,
      outputDigest: createHash('sha256').update(text).digest('hex'),
      outcome: 'completed',
    }).invocation
    const beat = run.recordNarrativeBeat({
      runId,
      invocationId: narrator.id,
      perspectiveActorId: actorId,
      eventIds: eventIds.map(id => worldlineId<'event'>(id)),
      observationIds: [],
      camera: 'limited-third-person',
      modelOutput: text,
      text,
      blocks: [{ type: 'narration', text }],
      media: [],
      modelRoute: route,
    }).beat
    const stateDirector = run.recordAiInvocation({
      runId,
      purpose: 'creative',
      actorId,
      modelRoute: route,
      contextSourceIds: [point.id, beat.id, 'runtime:world-state-shard', ...eventIds],
      inputTokens: 20,
      outputTokens: 8,
      estimatedCost: 0,
      outputDigest: 'b'.repeat(64),
      outcome: 'completed',
    }).invocation
    const characterDirector = run.recordAiInvocation({
      runId,
      purpose: 'creative',
      actorId,
      modelRoute: route,
      contextSourceIds: [beat.id, 'runtime:character-state-shard', ...eventIds],
      inputTokens: 20,
      outputTokens: 8,
      estimatedCost: 0,
      outputDigest: 'c'.repeat(64),
      outcome: 'completed',
    }).invocation
    const shards = (mutations: Parameters<typeof run.recordStoryState>[0]['shards'][number]['mutations']) => [{
      invocationId: stateDirector.id,
      domain: 'world' as const,
      subjectIds: [],
      mutations,
      memoryWrites: [],
    }, {
      invocationId: characterDirector.id,
      domain: 'characters' as const,
      subjectIds: base.entities.filter(entity => entity.type === 'character').map(entity => entity.id),
      mutations: [],
      memoryWrites: [],
    }]
    expect(() => run.recordStoryState({
      runId,
      beatId: beat.id,
      shards: shards([{
        scope: 'world',
        path: 'time',
        operation: 'set',
        value: 999,
        reason: '试图让状态导演越权修改运行时间。',
      }]),
      progress: {
        invocationId: stateDirector.id,
        pointId: point.id,
        status: 'active',
        rationale: '测试非法时间变更必须在提交前被拒绝。',
        evidence: ['正文中没有发生任何合法的时间推进。'],
        eventIds: beat.eventIds,
        observationIds: beat.observationIds,
      },
    })).toThrow('story state cannot modify Runtime time')
    const storyTurn = run.recordStoryState({
      runId,
      beatId: beat.id,
      shards: shards([]),
      progress: {
        invocationId: stateDirector.id,
        pointId: point.id,
        status: 'active',
        rationale: '动作已经完成，但约定的完成证据仍未出现。',
        evidence: ['保存的正文明确说明双方没有谈到约定。'],
        eventIds: beat.eventIds,
        observationIds: beat.observationIds,
      },
    })
    expect(storyTurn.progress?.status).toBe('active')
    expect(run.view().snapshot.storyProgress[point.id]).toEqual(storyTurn.progress)
    expect(run.records({ runId, stream: 'story-progress', limit: 10 }).records)
      .toHaveLength(1)
    expect(run.records({ runId, stream: 'story-state', limit: 10 }).records)
      .toHaveLength(1)
    run.close()
  })

  it('commits plot interventions and deadlines at exact Runtime times', async () => {
    const base = testBlueprint()
    const point = {
      id: 'plot-point:hard-clock', name: '在闸门关闭前通过', summary: '时间门控测试。', order: 1,
      entryCondition: '闸门仍然开放。', completionCriteria: '角色已经穿过闸门。',
      dramaticPressure: '警报逐步升级。', successOutcome: '角色抵达安全区。',
      failureOutcome: '闸门关闭并切断路线。', recoveryHook: '可寻找维护通道。',
      timing: {
        activateAt: 0, deadlineAt: 120,
        interventions: [{
          id: 'plot-intervention:alarm', at: 60, title: '一分钟警报',
          description: '红色警灯启动，闸门开始倒计时。',
        }],
      },
      provenance: base.provenance,
    }
    const run = await kernel('hard-clock-seed', { ...base, plotPoints: [point] })
    const runId = run.view().summary.runId
    run.advance({ runId, duration: 60 })
    const first = run.records({ runId, stream: 'world-event', limit: 100 }).records
      .map(record => record.payload)
    const activation = first.find(event => event.type === 'story.intervention'
      && event.logicalTime === 0)
    expect(activation?.data).toMatchObject({ phase: 'activate', pointId: point.id })
    const intervention = first.find(event => event.type === 'story.intervention'
      && event.logicalTime === 60)
    expect(intervention?.data).toMatchObject({ phase: 'intervention', title: '一分钟警报' })
    run.advance({ runId, duration: 60 })
    const all = run.records({ runId, stream: 'world-event', limit: 100 }).records
      .map(record => record.payload)
    const deadline = all.find(event => event.type === 'story.deadline'
      && event.logicalTime === 120)
    expect(deadline?.data).toMatchObject({ phase: 'deadline', description: point.failureOutcome })
    expect(run.view().snapshot.logicalTime).toBe(120)
    run.close()
  })
})
