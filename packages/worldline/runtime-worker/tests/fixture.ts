import type { Blueprint } from '@deepseek-ai/dsh-worldline-standard'
import { WWS_VERSION, worldlineId } from '@deepseek-ai/dsh-worldline-standard'

export function testBlueprint(): Blueprint {
  const actorA = worldlineId<'entity'>('entity:actor-a1')
  const actorB = worldlineId<'entity'>('entity:actor-b1')
  const source = {
    kind: 'mechanism-pack' as const,
    anchors: [],
    mechanism: { id: 'test.core', version: '1.0.0' },
  }
  return {
    id: worldlineId<'blueprint'>('blueprint:test-blueprint-0001'),
    digest: 'a'.repeat(64),
    format: WWS_VERSION,
    projectId: worldlineId<'project'>('project:test-project-0001'),
    worldId: worldlineId<'world'>('world:test-world-000001'),
    worldlineId: worldlineId<'worldline'>('worldline:test-line-000001'),
    projectRevision: 'sha256:test-project-revision' as Blueprint['projectRevision'],
    createdAt: '2026-01-01T00:00:00.000Z',
    purpose: {
      summary: 'Test deterministic time, resources and movement.',
      scope: ['test'],
      duration: 1000,
      resolution: 1,
      detail: 'L2',
      hardExpectations: ['actions finish'],
      statisticalExpectations: [],
      antiPatterns: ['instant movement'],
    },
    canon: [],
    links: [],
    maps: [{
      id: worldlineId<'map'>('map:test-map-000001'),
      version: 1,
      name: 'Test map',
      rootNodeId: worldlineId<'map-node'>('map-node:root-000001'),
      layers: [{ id: 'ground', name: 'Ground', visible: true, locked: false, order: 0 }],
      nodes: [
        { id: worldlineId<'map-node'>('map-node:root-000001'), layerId: 'ground', kind: 'world', name: 'Root', position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
        { id: worldlineId<'map-node'>('map-node:a-node-00001'), parentId: worldlineId<'map-node'>('map-node:root-000001'), layerId: 'ground', kind: 'room', name: 'A', position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
        { id: worldlineId<'map-node'>('map-node:b-node-00001'), parentId: worldlineId<'map-node'>('map-node:root-000001'), layerId: 'ground', kind: 'room', name: 'B', position: { x: 1, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
        { id: worldlineId<'map-node'>('map-node:c-node-00001'), parentId: worldlineId<'map-node'>('map-node:root-000001'), layerId: 'ground', kind: 'room', name: 'C', position: { x: 2, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
      ],
      edges: [
        { id: worldlineId<'map-edge'>('map-edge:a-b-000001'), from: worldlineId<'map-node'>('map-node:a-node-00001'), to: worldlineId<'map-node'>('map-node:b-node-00001'), bidirectional: true, distance: 1, baseDuration: 10, capacity: 1, modes: ['walk'], permissions: [], hazards: [] },
        { id: worldlineId<'map-edge'>('map-edge:b-c-000001'), from: worldlineId<'map-node'>('map-node:b-node-00001'), to: worldlineId<'map-node'>('map-node:c-node-00001'), bidirectional: true, distance: 2, baseDuration: 20, capacity: 1, modes: ['walk'], permissions: [], hazards: [] },
      ],
      provenance: [source],
    }],
    entities: [actorA, actorB].map(id => ({
      id,
      type: 'character',
      facets: {},
      state: { locationId: 'map-node:a-node-00001', energy: 0 },
      lod: 'L2' as const,
      policyIds: [],
      memory: { episodic: [], beliefs: [], goals: [], relationships: [], experience: [], skills: [], reflections: [] },
    })),
    actions: [
      {
        id: 'character.move', description: 'Move over connected positive-duration edges', operator: 'move',
        actorTypes: ['character'], preconditions: [], claims: [], duration: 0, effects: [],
        interruptible: true, maxWait: 100, retryBudget: 3, fallbacks: [], provenance: [source],
      },
      {
        id: 'character.work', description: 'Use the shared workshop exclusively', actorTypes: ['character'],
        preconditions: [], claims: [{ resource: 'workshop', quantity: 1, mode: 'exclusive', duration: 10 }],
        duration: 10, effects: [{ op: 'increment', path: 'state.energy', amount: 1 }],
        interruptible: true, maxWait: 100, retryBudget: 5, fallbacks: [], provenance: [source],
      },
    ],
    systems: [{
      id: 'world.clock', description: 'Advance an authored clock', nextWake: 60, interval: 60,
      preconditions: [], effects: [{ op: 'increment', path: 'world.time', amount: 60 }], provenance: [source],
    }],
    invariants: [{
      id: 'world.time.nonnegative', description: 'Time is nonnegative',
      expression: { op: 'gte', path: 'world.time', value: 0 }, provenance: [source],
    }],
    provenance: [source],
    modelPolicy: { routes: {}, aiEnabled: false, revision: 'sha256:test-model-policy' as Blueprint['projectRevision'] },
    certificate: {
      blueprintDigest: 'a'.repeat(64),
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceCoverage: { author: 0, 'approved-supplement': 0, 'mechanism-pack': 1, import: 0, 'agent-proposal': 0, 'runtime-proposal': 0 },
      results: [],
      deterministicWithoutAi: true,
      knownLimits: [],
      performance: {},
    },
  }
}
