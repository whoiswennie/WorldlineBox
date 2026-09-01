import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stableStringify, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineKernel } from '../src/kernel.ts'
import { testBlueprint } from './fixture.ts'

const roots: string[] = []

async function kernel(seed = 'deterministic-seed'): Promise<WorldlineKernel> {
  const root = await mkdtemp(join(tmpdir(), 'worldline-kernel-'))
  roots.push(root)
  return new WorldlineKernel({
    projectId: worldlineId<'project'>('project:test-project-0001'),
    runId: worldlineId<'run'>(`run:${seed.replaceAll('_', '-').padEnd(8, '0')}`),
    blueprint: testBlueprint(),
    databasePath: join(root, 'world.sqlite'),
    seed,
    startPaused: false,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorldlineKernel', () => {
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
})
