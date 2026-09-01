import type {
  JsonObject,
  MapNodeId,
  SimulationPurpose,
  WorldMap,
} from '@deepseek-ai/dsh-worldline-standard'

export interface WorldlineAcceptanceScenario {
  readonly slug: string
  readonly name: string
  readonly characters: readonly { readonly name: string; readonly state: JsonObject }[]
  readonly purpose: SimulationPurpose
  readonly map: WorldMap
}

function purpose(summary: string, scope: readonly string[]): SimulationPurpose {
  return {
    summary,
    scope,
    duration: 90 * 86_400,
    resolution: 60,
    detail: 'L2',
    hardExpectations: ['Every accepted action is validated and retained in the Run ledger.'],
    statisticalExpectations: [],
    antiPatterns: ['instant ordinary movement', 'omniscient character knowledge'],
  }
}

function map(
  id: string,
  name: string,
  nodes: WorldMap['nodes'],
  edges: WorldMap['edges'] = [],
): WorldMap {
  const rootNodeId = nodes[0]?.id
  if (rootNodeId === undefined) throw new Error('acceptance map requires a root node')
  return {
    id: `map:${id}` as WorldMap['id'],
    version: 1,
    name,
    rootNodeId,
    layers: [{ id: 'ground', name: 'Ground', visible: true, locked: false, order: 0 }],
    nodes,
    edges,
    provenance: [],
  }
}

function node(id: string, name: string, kind: WorldMap['nodes'][number]['kind'], x: number, y: number, parentId?: string): WorldMap['nodes'][number] {
  const baseNode = {
    id: `map-node:${id}` as WorldMap['nodes'][number]['id'],
    layerId: 'ground',
    kind,
    name,
    position: { x, y },
    permissions: [],
    hazards: [],
    entryNodeIds: [],
  }
  return parentId === undefined
    ? baseNode
    : { ...baseNode, parentId: `map-node:${parentId}` as MapNodeId }
}

const townNames = [
  'Aster', 'Briar', 'Celia', 'Dorian', 'Ember', 'Faye', 'Galen', 'Hana', 'Iris',
  'Joren', 'Kira', 'Lio', 'Mara', 'Niko', 'Orin', 'Pia', 'Quill', 'Rhea', 'Soren',
  'Tala', 'Uma', 'Vale', 'Wren', 'Xara', 'Yori',
] as const

const townMap = map('lantern-town', 'Lantern Town', [
  node('lantern-root', 'Lantern Town', 'world', 0, 0),
  node('lantern-square', 'Market Square', 'city', 0, 0, 'lantern-root'),
  node('lantern-workshop', 'Shared Workshop', 'building', 180, 30, 'lantern-square'),
  node('lantern-inn', 'Moonwell Inn', 'building', -160, 60, 'lantern-square'),
])

const nestedNodes = [
  node('nested-world', 'Cloudward', 'world', 0, 0),
  node('nested-region', 'North March', 'region', 120, 30, 'nested-world'),
  node('nested-city', 'Glass City', 'city', 230, 80, 'nested-region'),
  node('nested-district', 'Archive Ward', 'building', 330, 120, 'nested-city'),
  node('nested-building', 'Memory Library', 'building', 420, 155, 'nested-district'),
  node('nested-room', 'Sealed Reading Room', 'room', 500, 185, 'nested-building'),
] as const

export const acceptanceScenarios: readonly WorldlineAcceptanceScenario[] = [
  {
    slug: 'twenty-five-person-town',
    name: 'Lantern Town Ensemble',
    characters: townNames.map((name, index) => ({
      name,
      state: { locationId: index % 2 === 0 ? 'map-node:lantern-square' : 'map-node:lantern-inn', energy: 10, occupation: index % 3 === 0 ? 'artisan' : 'resident' },
    })),
    purpose: purpose('Simulate ninety days of a 25-person town without collapsing people into statistics.', ['ensemble', 'economy', 'relationships']),
    map: townMap,
  },
  {
    slug: 'oc-hero-journey',
    name: 'Aster and the Quiet Star',
    characters: [{ name: 'Aster', state: { locationId: 'map-node:hero-sanctum', energy: 12, promise: 'return the fallen star' } }],
    purpose: purpose('Follow one original character through a bounded personal journey.', ['character', 'memory', 'choice']),
    map: map('hero-road', 'Quiet Star Road', [node('hero-root', 'Quiet Star Road', 'world', 0, 0), node('hero-sanctum', 'Star Sanctum', 'region', 70, 20, 'hero-root')]),
  },
  {
    slug: 'rural-life',
    name: 'Willowbank Seasons',
    characters: ['Mei', 'Rin', 'Toma', 'Suzu', 'Bo', 'Lin'].map((name, index) => ({ name, state: { locationId: 'map-node:willow-farm', energy: 8 + index, crop: 'rice' } })),
    purpose: purpose('Model everyday rural work, weather, commitments, and seasonal rhythms.', ['rural life', 'households', 'seasons']),
    map: map('willowbank', 'Willowbank', [node('willow-root', 'Willowbank', 'world', 0, 0), node('willow-farm', 'River Farm', 'region', 90, 35, 'willow-root')]),
  },
  {
    slug: 'alternate-history',
    name: 'The Unbroken Observatory',
    characters: ['Nadia', 'Cassian', 'Miro', 'Thea'].map((name, index) => ({ name, state: { locationId: 'map-node:observatory-hall', influence: index + 1, allegiance: index % 2 === 0 ? 'academy' : 'civic council' } })),
    purpose: purpose('Explore an alternate history where the imperial observatory survives the revolution.', ['alternate history', 'institutions', 'politics']),
    map: map('observatory', 'Unbroken Observatory', [node('observatory-root', 'Capital', 'world', 0, 0), node('observatory-hall', 'Grand Observatory', 'building', 130, 45, 'observatory-root')]),
  },
  {
    slug: 'nested-map',
    name: 'Cloudward Nested Atlas',
    characters: ['Archivist Nia', 'Courier Sol', 'Warden Ivo'].map(name => ({ name, state: { locationId: 'map-node:nested-room', access: 'archive' } })),
    purpose: purpose('Exercise nested world, region, city, district, building, and room containment.', ['nested space', 'access', 'navigation']),
    map: map('cloudward', 'Cloudward', nestedNodes),
  },
]

export function mechanismDocument(scenario: WorldlineAcceptanceScenario): string {
  return `# ${scenario.name} runtime

\`\`\`worldline-map
${JSON.stringify(scenario.map, null, 2)}
\`\`\`

\`\`\`worldline-action
${JSON.stringify({
    id: 'world.wait',
    description: 'Wait while authored systems advance.',
    operator: 'generic',
    actorTypes: ['character'],
    duration: 60,
    maxWait: 600,
    retryBudget: 3,
    effects: [{ op: 'increment', path: 'state.elapsed', amount: 60 }],
  }, null, 2)}
\`\`\`

\`\`\`worldline-system
${JSON.stringify({
    id: 'world.clock',
    description: 'Advance the authored world clock.',
    nextWake: 3_600,
    interval: 3_600,
    effects: [{ op: 'increment', path: 'world.time', amount: 3_600 }],
  }, null, 2)}
\`\`\`

\`\`\`worldline-invariant
${JSON.stringify({
    id: 'world.time.nonnegative',
    description: 'Logical world time never becomes negative.',
    expression: { op: 'gte', path: 'world.time', value: 0 },
  }, null, 2)}
\`\`\`
`
}

export function characterDocument(
  scenario: WorldlineAcceptanceScenario,
  character: WorldlineAcceptanceScenario['characters'][number],
): string {
  return `# ${character.name}

${character.name} is an authored OC in ${scenario.name}. Their knowledge and decisions remain bounded by observations.

<!-- worldline-facets ${JSON.stringify({ initialState: character.state })} -->
`
}
