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
})
