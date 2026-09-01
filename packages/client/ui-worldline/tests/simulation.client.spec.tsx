// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { RunSpatialView, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import { SimulationWorkbench } from '../src/client/SimulationWorkbench.tsx'
import type { AiClient, RunsClient } from '../src/client/types.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

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
    state: { entities: { 'entity:traveller': { state: { locationId: 'map-node:start' } } } },
    processes: [],
    reservations: [],
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
    spatial: vi.fn(async () => spatial),
    records: vi.fn(async () => ({ records: [], nextSequence: 0, nextOrdinal: 0, hasMore: false })),
    checkpoints: vi.fn(async () => []),
  } as unknown as RunsClient
}

function t(key: keyof typeof zh): string { return zh[key] }

describe('Worldline simulation spatial projection', () => {
  it('shows the frozen Run map and an in-progress non-teleport movement', async () => {
    render(<SimulationWorkbench
      project={project}
      runs={runsClient()}
      ai={{ catalog: vi.fn(async () => ({ providers: [], models: [] })) } as unknown as AiClient}
      runRevision={0}
      onRunsChanged={() => {}}
      onOpenTextPlay={() => {}}
      t={t}
    />)

    expect(await screen.findByRole('img', { name: 'Town' })).toBeTruthy()
    expect(screen.getByText('Start')).toBeTruthy()
    expect(screen.getByText('Destination')).toBeTruthy()
    expect(screen.getByText(/35% · 8 剩余时间/u)).toBeTruthy()
  })
})
