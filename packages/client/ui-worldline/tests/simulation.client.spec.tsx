// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { RunSpatialView, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import { runAutonomyCycle, SimulationWorkbench } from '../src/client/SimulationWorkbench.tsx'
import type { AiClient, RunsClient } from '../src/client/types.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function ownMethod(target: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(target, name)?.value
}

const runId = 'run:simulation-map-test' as RunView['summary']['runId']
const project = {
  manifest: { id: 'project:simulation-map-test', name: 'Map world' },
} as unknown as ProjectSummary
const view = {
  summary: {
    runId,
    projectId: project.manifest.id,
    branchId: 'worldline:main',
    blueprintDigest: 'a'.repeat(64),
    status: 'paused',
    logicalTime: 4,
    sequence: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  },
  snapshot: {
    logicalTime: 4,
    sequence: 2,
    state: { entities: {
      'entity:charter': { state: {} },
      'entity:traveller': { state: { locationId: 'map-node:start' } },
    } },
    processes: [],
    reservations: [],
    futureEvents: [{ id: 'future:clock', due: 60, order: 0, kind: 'system-wake', payload: { systemId: 'world.clock' } }],
    modelPolicy: { aiEnabled: false, routes: {} },
  },
  health: {
    futureQueueDepth: 1, activeProcesses: 1, waitingProcesses: 0, reservations: 1,
    longestWait: 0, noProgressSteps: 0, deadlocksResolved: 0, livelocksResolved: 0,
    fairnessInterventions: 0,
  },
  aiUsage: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  controls: {},
} as unknown as RunView
const spatial = {
  runId,
  sequence: 2,
  logicalTime: 4,
  availableMaps: [{ id: 'map:town', name: 'Town', nodeCount: 2 }],
  map: {
    id: 'map:town', name: 'Town', rootNodeId: 'map-node:start', layers: [],
    nodes: [
      { id: 'map-node:start', layerId: 'ground', kind: 'room', name: 'Start', position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
      { id: 'map-node:end', layerId: 'ground', kind: 'room', name: 'Destination', position: { x: 10, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
    ],
    edges: [{ id: 'map-edge:route', from: 'map-node:start', to: 'map-node:end', bidirectional: true, distance: 10, baseDuration: 12, modes: ['walk'], permissions: [], hazards: [] }],
    totalNodes: 2, totalEdges: 1, truncated: false,
  },
  actors: [{ actorId: 'entity:traveller', nodeId: 'map-node:start' }],
  movements: [{
    processId: 'process:move', actorId: 'entity:traveller', state: 'started',
    origin: 'map-node:start', destination: 'map-node:end', route: ['map-node:start', 'map-node:end'],
    edgeIndex: 0, edgeFraction: .35, remainingDuration: 8, estimatedArrival: 12, mode: 'walk',
  }],
} as unknown as RunSpatialView

function runsClient(): RunsClient {
  return {
    list: vi.fn(async () => [view.summary]),
    view: vi.fn(async () => view),
    definition: vi.fn(async () => ({
      runId,
      blueprintDigest: view.summary.blueprintDigest,
      purpose: { summary: 'Town runtime', scope: [], duration: 100, resolution: 1, detail: 'L2', hardExpectations: [], statisticalExpectations: [], antiPatterns: [] },
      entities: [
        { id: 'entity:charter', type: 'charter', lod: 'L0', policyIds: [] },
        { id: 'entity:traveller', type: 'character', lod: 'L2', policyIds: [] },
      ],
      actions: [{ id: 'character.move', description: 'Walk to a connected place', actorTypes: ['character'] }],
      systems: [{ id: 'world.clock', description: 'Advance town time', nextWake: 60, interval: 60, preconditions: [], effects: [], provenance: [] }],
      invariants: [{ id: 'world.safe', description: 'Town remains safe', expression: { op: 'literal', value: true }, provenance: [] }],
    })),
    spatial: vi.fn(async () => spatial),
    choices: vi.fn(async () => ({
      runId,
      actorId: 'entity:traveller',
      sequence: 2,
      choices: [{ id: 'choice:walk', actionType: 'character.move', parameters: { destination: 'map-node:end' }, label: 'Walk to Destination', description: 'Follow the connected route.', targetIds: ['map-node:end'], estimatedDuration: 12, costs: [], risks: [] }],
    })),
    submitAction: vi.fn(async () => ({})),
    advance: vi.fn(async () => view),
    records: vi.fn(async () => ({ records: [], nextSequence: 0, nextOrdinal: 0, hasMore: false })),
    checkpoints: vi.fn(async () => []),
  } as unknown as RunsClient
}

const t: TranslateNS<'worldlineStudio'> = key => zh[key as keyof typeof zh] ?? key

describe('Worldline simulation spatial projection', () => {
  it('runs one autonomous character action before advancing the clock', async () => {
    const running = {
      ...view,
      summary: { ...view.summary, status: 'running' },
      controls: { 'entity:charter': 'player', 'entity:traveller': 'autonomous' },
    } as RunView
    const runs = runsClient()
    Object.defineProperty(runs, 'view', { value: vi.fn(async () => running) })

    await runAutonomyCycle(runs, runId, undefined, 60)

    expect(ownMethod(runs, 'submitAction')).toHaveBeenCalledWith({
      runId,
      actorId: 'entity:traveller',
      type: 'character.move',
      parameters: { destination: 'map-node:end' },
      expectedSequence: 2,
      controller: 'agent',
    })
    expect(ownMethod(runs, 'advance')).toHaveBeenCalledWith({ runId, duration: 60, maxEvents: 10_000 })
  })

  it('shows the frozen Run map and an in-progress non-teleport movement', async () => {
    const runs = runsClient()
    render(<SimulationWorkbench
      project={project}
      runs={runs}
      ai={{ catalog: vi.fn(async () => ({ providers: [], models: [] })) } as unknown as AiClient}
      runRevision={0}
      onRunsChanged={() => {}}
      onOpenTextPlay={() => {}}
      onImportRun={() => undefined}
      onExportRun={() => undefined}
      t={t}
    />)

    expect(await screen.findByRole('img', { name: 'Town' })).toBeTruthy()
    expect(screen.getByText('Start')).toBeTruthy()
    expect(screen.getByText('Destination')).toBeTruthy()
    expect(screen.getByText(/35% · 8 剩余时间/u)).toBeTruthy()
    expect(await screen.findByText('world.clock')).toBeTruthy()
    expect(screen.getAllByText('角色观察').length).toBeGreaterThan(0)
    expect((await screen.findAllByText('Walk to Destination')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '执行干预' }))
    await waitFor(() => {
      expect(ownMethod(runs, 'submitAction')).toHaveBeenCalledWith({
        runId,
        actorId: 'entity:traveller',
        type: 'character.move',
        parameters: { destination: 'map-node:end' },
        expectedSequence: 2,
        controller: 'system',
      })
    })
  })
})
