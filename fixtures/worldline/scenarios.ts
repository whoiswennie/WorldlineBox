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
  /** Action that proves this scenario's authored conflict can actually execute. */
  readonly acceptanceAction?: string
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

function edge(
  id: string,
  from: string,
  to: string,
  duration: number,
  hazards: readonly string[] = [],
): WorldMap['edges'][number] {
  return {
    id: `map-edge:${id}` as WorldMap['edges'][number]['id'],
    from: `map-node:${from}` as MapNodeId,
    to: `map-node:${to}` as MapNodeId,
    bidirectional: true,
    distance: duration,
    baseDuration: duration,
    capacity: 2,
    modes: ['walk'],
    permissions: [],
    hazards,
  }
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
    slug: 'warrior-and-dragon',
    name: '勇士与恶龙：灰烬王冠',
    characters: [
      {
        name: '勇士艾琳',
        state: {
          locationId: 'map-node:dragon-lair',
          stamina: 5,
          wounds: 0,
          oath: '守护晨钟村并带回灰烬王冠',
        },
      },
      {
        name: '赤焰龙烬冠',
        state: {
          locationId: 'map-node:dragon-lair',
          stamina: 12,
          wounds: 0,
          desire: '守住最后一枚龙卵与灰烬王冠',
        },
      },
    ],
    purpose: {
      ...purpose(
        '让勇士穿越燃痕山道，在信息受限和资源有限的条件下与恶龙交锋。',
        ['原创角色', '冒险', '战斗', '因果', '选择'],
      ),
      duration: 3_600,
      resolution: 5,
      hardExpectations: [
        '勇士与恶龙必须是两个独立且有稳定身份的角色。',
        '每次交锋都必须产生可追溯的动作、状态变化和世界事件。',
        '勇士的体力与双方伤势不得出现负数。',
      ],
      antiPatterns: ['无代价胜利', '瞬间移动', '角色知晓未观察到的秘密'],
    },
    map: map('ash-crown', '灰烬边境', [
      node('ash-world', '灰烬边境', 'world', 0, 0),
      node('dawn-village', '晨钟村', 'city', -240, 80, 'ash-world'),
      node('scorched-pass', '燃痕山道', 'region', 0, 20, 'ash-world'),
      node('dragon-lair', '赤焰龙巢', 'building', 250, -30, 'ash-world'),
    ], [
      edge('village-pass', 'dawn-village', 'scorched-pass', 600, ['落石']),
      edge('pass-lair', 'scorched-pass', 'dragon-lair', 900, ['龙焰', '浓烟']),
    ]),
    acceptanceAction: 'battle.strike',
  },
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
  if (scenario.slug === 'warrior-and-dragon') return `# 灰烬王冠运行规则

勇士和恶龙都受体力、伤势、空间与时间约束。胜负只能来自已记录的动作和系统结算。

\`\`\`worldline-action
${JSON.stringify({
    id: 'battle.strike',
    description: '在龙巢中发动一次有体力代价的正面攻击。',
    operator: 'generic',
    actorTypes: ['character'],
    preconditions: [],
    duration: 10,
    maxWait: 60,
    retryBudget: 2,
    effects: [
      { op: 'increment', path: 'state.stamina', amount: -1, min: 0 },
      { op: 'set', path: 'conflict.heroWounds', value: 0 },
      { op: 'increment', path: 'conflict.dragonWounds', amount: 1, min: 0 },
    ],
  }, null, 2)}
\`\`\`

\`\`\`worldline-action
${JSON.stringify({
    id: 'battle.guard',
    description: '稳住阵脚并恢复一点体力。',
    operator: 'generic',
    actorTypes: ['character'],
    duration: 5,
    maxWait: 30,
    retryBudget: 2,
    effects: [{ op: 'increment', path: 'state.stamina', amount: 1, min: 0, max: 5 }],
  }, null, 2)}
\`\`\`

\`\`\`worldline-system
${JSON.stringify({
    id: 'dragon.counterfire',
    description: '恶龙每三十秒掀起一次可追溯的龙焰反击。',
    nextWake: 30,
    interval: 30,
    effects: [{ op: 'increment', path: 'conflict.heroWounds', amount: 1, min: 0 }],
  }, null, 2)}
\`\`\`

\`\`\`worldline-invariant
${JSON.stringify({
    id: 'battle.dragon-wounds.nonnegative',
    description: '恶龙伤势计数不得为负。',
    expression: { op: 'gte', path: 'conflict.dragonWounds', value: 0 },
  }, null, 2)}
\`\`\`

\`\`\`worldline-invariant
${JSON.stringify({
    id: 'battle.hero-wounds.nonnegative',
    description: '勇士伤势计数不得为负。',
    expression: { op: 'gte', path: 'conflict.heroWounds', value: 0 },
  }, null, 2)}
\`\`\`
`
  return `# ${scenario.name} runtime

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

export function mapDocument(scenario: WorldlineAcceptanceScenario): string {
  return `# ${scenario.map.name}

\`\`\`worldline-map
${JSON.stringify(scenario.map, null, 2)}
\`\`\`
`
}

export function characterDocument(
  scenario: WorldlineAcceptanceScenario,
  character: WorldlineAcceptanceScenario['characters'][number],
): string {
  const dragonStory = scenario.slug === 'warrior-and-dragon'
    ? character.name.includes('勇士')
      ? '她以守护晨钟村为誓言，擅长观察地形与克制恐惧；体力耗尽时不能继续攻击。'
      : '它守护最后一枚龙卵，不是无缘无故的灾兽；龙焰强大，但行动仍受时间与世界规则约束。'
    : `${character.name} is an authored OC in ${scenario.name}. Their knowledge and decisions remain bounded by observations.`
  return `# ${character.name}

${dragonStory}

<!-- worldline-facets ${JSON.stringify({ initialState: character.state })} -->
`
}

/** Authoritative charter used by full-project acceptance journeys. */
export function charterDocument(scenario: WorldlineAcceptanceScenario): string {
  if (scenario.slug === 'warrior-and-dragon') return `# 灰烬边境世界宪章

<!-- worldline-facets ${JSON.stringify({
    initialWorldState: { conflict: { heroWounds: 0, dragonWounds: 0 } },
  })} -->

1. 角色只能依据亲历事件与明确观察行动，不能读取未获得的秘密。
2. 距离、行动耗时、体力与伤势必须由地图和机制结算，任何角色都不能无代价胜利。
3. 勇士与恶龙都是拥有目标、资源和后果的独立角色；作者事实高于叙事修辞。
4. 叙事只能复述已经写入 Run 的事件，不得反向修改世界状态。
`
  return `# ${scenario.name} charter

Authored facts, bounded knowledge, explicit time, and retained causal events govern this world.
`
}

/** Causal history used by full-project acceptance journeys. */
export function timelineDocument(scenario: WorldlineAcceptanceScenario): string {
  if (scenario.slug === 'warrior-and-dragon') return `# 灰烬王冠时间线

- 第零日：赤焰龙烬冠夺走王冠并退守龙巢，晨钟村的北部粮道被龙焰截断。
- 第一日清晨：勇士艾琳接受村民委托，携带旧盾进入燃痕山道。
- 第一日黄昏：艾琳抵达龙巢；故事从双方第一次能够观察到彼此的时刻开始。
`
  return `# ${scenario.name} timeline

The opening state follows from authored events recorded here.
`
}

/** Playable opening and success criteria used by full-project acceptance journeys. */
export function openingScenarioDocument(scenario: WorldlineAcceptanceScenario): string {
  if (scenario.slug === 'warrior-and-dragon') return `# 龙巢前的抉择

勇士艾琳与赤焰龙烬冠同处龙巢。玩家控制艾琳，目标是在体力不低于零的前提下完成至少一次有效攻击，并承受世界时间推进带来的龙焰反击。

验收条件：构建闭包通过；Run 中出现 battle.strike 的完成事件；恶龙伤势增加；三十秒后勇士伤势增加；故事舞台只能叙述这些已经记录的事实。
`
  return `# ${scenario.name} opening

Start from the authored map, actors, rules, and observable success criteria.
`
}
