import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SimulationPurpose } from '@deepseek-ai/dsh-worldline-standard'
import WorldlineCompiler from '../../compiler/src/index.ts'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorkerWorldlineRuns from '../src/index.ts'

const roots: string[] = []

interface RuntimeHost {
  readonly context: Context
  readonly dispose: () => Promise<void>
}

async function start(root: string, compiler = false): Promise<RuntimeHost> {
  const context = new Context()
  const projects = context.plugin(LocalWorldlineProjects, {
    root,
    maxEntries: 5000,
    maxSearchFiles: 50_000,
  })
  await projects.await()
  const compilerFiber = compiler ? context.plugin(WorldlineCompiler) : undefined
  await compilerFiber?.await()
  const runs = context.plugin(WorkerWorldlineRuns, {
    maxOldGenerationSizeMb: 128,
    requestTimeoutMs: 15_000,
  })
  await runs.await()
  return {
    context,
    dispose: async () => {
      await runs.dispose()
      await compilerFiber?.dispose()
      await projects.dispose()
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const purpose: SimulationPurpose = {
  summary: 'Exercise an independently persisted world Runtime.',
  scope: ['characters', 'space', 'actions'],
  duration: 600,
  resolution: 1,
  detail: 'L2',
  hardExpectations: ['Movement crosses authored edges in positive logical time.'],
  statisticalExpectations: [],
  antiPatterns: ['instant ordinary movement'],
}

const mechanisms = `# Runtime mechanisms

\`\`\`worldline-map
{
  "id": "map:worker-integration-0001",
  "name": "Worker integration map",
  "rootNodeId": "map-node:root-worker-0001",
  "layers": [{ "id": "ground", "name": "Ground", "visible": true, "locked": false, "order": 0 }],
  "nodes": [
    {
      "id": "map-node:root-worker-0001", "layerId": "ground", "kind": "world", "name": "Root",
      "position": { "x": 0, "y": 0 }, "permissions": [], "hazards": [], "entryNodeIds": []
    },
    {
      "id": "map-node:start-worker-0001", "parentId": "map-node:root-worker-0001",
      "layerId": "ground", "kind": "room", "name": "Start", "position": { "x": 0, "y": 0 },
      "permissions": [], "hazards": [], "entryNodeIds": []
    },
    {
      "id": "map-node:end-worker-00001", "parentId": "map-node:root-worker-0001",
      "layerId": "ground", "kind": "room", "name": "End", "position": { "x": 1, "y": 0 },
      "permissions": [], "hazards": [], "entryNodeIds": []
    }
  ],
  "edges": [{
    "id": "map-edge:worker-route-0001", "from": "map-node:start-worker-0001",
    "to": "map-node:end-worker-00001", "bidirectional": true, "distance": 1,
    "baseDuration": 10, "modes": ["walk"], "permissions": [], "hazards": []
  }]
}
\`\`\`

\`\`\`worldline-action
{
  "id": "character.move", "operator": "move", "description": "Walk over authored edges",
  "actorTypes": ["character"], "duration": 0, "maxWait": 60, "retryBudget": 3,
  "effects": []
}
\`\`\`

\`\`\`worldline-system
{
  "id": "world.clock", "description": "Advance the authored clock", "nextWake": 60,
  "interval": 60, "effects": [{ "op": "increment", "path": "world.time", "amount": 60 }]
}
\`\`\`

\`\`\`worldline-invariant
{
  "id": "world.time.nonnegative", "description": "Time remains nonnegative",
  "expression": { "op": "gte", "path": "world.time", "value": 0 }
}
\`\`\`
`

describe('WorkerWorldlineRuns integration', () => {
  it('runs, checkpoints, branches and cold-recovers an immutable compiled world', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-worker-integration-'))
    roots.push(root)
    const first = await start(root, true)
    const project = await first.context.worldlineProjects.create({
      name: 'Worker Integration',
      template: 'blank',
    })
    await first.context.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'characters/traveller.md',
      content: '# Traveller\n\n<!-- worldline-facets {"initialState":{"locationId":"map-node:start-worker-0001"}} -->',
      createParents: true,
      objectKind: 'character',
    })
    await first.context.worldlineProjects.write({
      projectId: project.manifest.id,
      path: 'mechanisms/runtime.md',
      content: mechanisms,
      createParents: true,
      objectKind: 'rule',
    })
    const preview = await first.context.worldlineCompiler.compile({
      projectId: project.manifest.id,
      purpose,
    })
    expect(preview.canFreeze).toBe(true)
    const frozen = await first.context.worldlineCompiler.freeze({
      projectId: project.manifest.id,
      purpose,
      expectedSourceDigest: preview.sourceDigest,
    })
    const actor = frozen.blueprint.entities.find(entity => entity.type === 'character')
    if (actor === undefined) throw new Error('compiled Blueprint has no character actor')

    const created = await first.context.worldlineRuns.create({
      projectId: project.manifest.id,
      seed: 'integration-seed',
      startPaused: false,
    })
    const liveHandles = (first.context.worldlineRuns as unknown as {
      readonly handles: Map<string, { readonly worker: { terminate: () => Promise<number> } }>
    }).handles
    const crashedHandle = liveHandles.get(created.summary.runId)
    if (crashedHandle === undefined) throw new Error('created Run has no live Worker handle')
    await crashedHandle.worker.terminate()
    const recoveredAfterCrash = await first.context.worldlineRuns.view({ runId: created.summary.runId })
    expect(recoveredAfterCrash.snapshot).toMatchObject({
      runId: created.summary.runId,
      logicalTime: created.snapshot.logicalTime,
      blueprintDigest: frozen.blueprint.digest,
    })
    expect(recoveredAfterCrash.summary.status).toBe('paused')
    expect(liveHandles.get(created.summary.runId)).not.toBe(crashedHandle)
    await first.context.worldlineRuns.resume({ runId: created.summary.runId })
    const definition = await first.context.worldlineRuns.definition({ runId: created.summary.runId })
    expect(definition).toMatchObject({
      blueprintDigest: frozen.blueprint.digest,
      systems: [{ id: 'world.clock' }],
      invariants: [{ id: 'world.time.nonnegative' }],
    })
    expect(definition.actions.map(action => action.id)).toContain('character.move')
    const submitted = await first.context.worldlineRuns.submitAction({
      runId: created.summary.runId,
      actorId: actor.id,
      type: 'character.move',
      parameters: { destination: 'map-node:end-worker-00001' },
      expectedSequence: created.snapshot.sequence,
      controller: 'agent',
    })
    const spatial = await first.context.worldlineRuns.spatial({
      runId: created.summary.runId,
      maxNodes: 100,
    })
    expect(spatial.map?.nodes.length).toBeGreaterThan(0)
    expect(spatial.actors).toContainEqual(expect.objectContaining({ actorId: actor.id }))
    expect(spatial.movements).toContainEqual(expect.objectContaining({
      processId: submitted.process.id,
      destination: 'map-node:end-worker-00001',
      remainingDuration: 10,
    }))
    const advanced = await first.context.worldlineRuns.advance({
      runId: created.summary.runId,
      duration: 10,
    })
    expect(advanced.snapshot.logicalTime).toBe(10)
    expect((advanced.snapshot.state['entities'] as Record<string, {
      state: { locationId: string }
    }>)[actor.id]?.state.locationId).toBe('map-node:end-worker-00001')

    const checkpoint = await first.context.worldlineRuns.checkpoint({
      runId: created.summary.runId,
      label: 'Arrived',
    })
    const branch = await first.context.worldlineRuns.branch({
      runId: created.summary.runId,
      checkpointId: checkpoint.checkpoint.id,
      seed: 'branch-seed',
    })
    expect(branch.summary).toMatchObject({
      parentRunId: created.summary.runId,
      forkSequence: checkpoint.checkpoint.sequence,
      status: 'paused',
    })
    const events = await first.context.worldlineRuns.records({
      runId: created.summary.runId,
      stream: 'world-event',
      limit: 100,
    })
    expect(events.records.length).toBeGreaterThan(0)
    const explanation = await first.context.worldlineRuns.explain({
      runId: created.summary.runId,
      eventId: String(events.records.at(-1)?.id),
    })
    expect(explanation.event?.id).toBe(events.records.at(-1)?.id)
    const firstPage = await first.context.worldlineRuns.records({
      runId: created.summary.runId,
      limit: 1,
    })
    const secondPage = await first.context.worldlineRuns.records({
      runId: created.summary.runId,
      afterSequence: firstPage.nextSequence,
      afterOrdinal: firstPage.nextOrdinal,
      limit: 1,
    })
    expect(secondPage.records[0]?.id).not.toBe(firstPage.records[0]?.id)
    const controlled = await first.context.worldlineRuns.setControl({
      runId: created.summary.runId,
      actorId: actor.id,
      mode: 'player',
    })
    const originalCreatedAt = controlled.summary.createdAt
    await first.dispose()

    const recovered = await start(root)
    const restored = await recovered.context.worldlineRuns.view({ runId: created.summary.runId })
    expect(restored.snapshot).toMatchObject({
      logicalTime: 10,
      blueprintDigest: frozen.blueprint.digest,
    })
    expect(restored.health).toMatchObject({ writerThread: true, wal: true })
    expect(restored.summary.createdAt).toBe(originalCreatedAt)
    expect(restored.controls[actor.id]).toBe('player')
    await recovered.context.worldlineRuns.resume({ runId: created.summary.runId })
    const continued = await recovered.context.worldlineRuns.submitAction({
      runId: created.summary.runId,
      actorId: actor.id,
      type: 'character.move',
      parameters: { destination: 'map-node:start-worker-0001' },
      expectedSequence: restored.snapshot.sequence,
      controller: 'player',
    })
    expect(continued.process.state).toBe('started')
    const summaries = await recovered.context.worldlineRuns.list()
    expect(summaries.map(item => item.runId)).toEqual(expect.arrayContaining([
      created.summary.runId,
      branch.summary.runId,
    ]))
    expect(submitted.process.movement?.route.at(-1)).toBe('map-node:end-worker-00001')
    await recovered.dispose()
  })
})
