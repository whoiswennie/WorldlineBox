import type {
  JsonObject,
  MapNodeId,
  SimulationPurpose,
  WorldMap,
} from '@deepseek-ai/dsh-worldline-standard'

export interface WorldlineAcceptanceScenario {
  readonly slug: string
  readonly name: string
  readonly characters: readonly {
    readonly name: string
    readonly state: JsonObject
    readonly biography?: string
    readonly goal?: string
    readonly belief?: string
    readonly skills?: readonly string[]
  }[]
  readonly purpose: SimulationPurpose
  readonly map: WorldMap
  /** Action that proves this scenario's authored conflict can actually execute. */
  readonly acceptanceAction?: string
  readonly expectedExecutables?: {
    readonly actions: number
    readonly systems: number
    readonly invariants: number
  }
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
    layers: [{ id: 'ground', name: '地表层', visible: true, locked: false, order: 0 }],
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

const stardewLocations = [
  node('pelican-world', '星露谷', 'world', 0, -420),
  node('valley-farm', '星露谷农场', 'region', -520, -100, 'pelican-world'),
  node('farmhouse', '农舍', 'building', -520, 90, 'valley-farm'),
  node('bus-stop', '巴士站', 'region', -300, -100, 'pelican-world'),
  node('town-square', '鹈鹕镇广场', 'city', 0, -80, 'pelican-world'),
  node('town-clinic', '哈维诊所', 'building', -190, 100, 'town-square'),
  node('general-store', '皮埃尔杂货店', 'building', 0, 100, 'town-square'),
  node('saloon', '星之果实餐吧', 'building', 190, 100, 'town-square'),
  node('blacksmith', '铁匠铺', 'building', 300, -60, 'town-square'),
  node('museum', '博物馆', 'building', 460, 30, 'town-square'),
  node('ocean-beach', '海滩', 'region', 300, 280, 'pelican-world'),
  node('fish-shop', '渔具店', 'building', 500, 280, 'ocean-beach'),
  node('coal-forest', '煤矿森林', 'region', -300, 300, 'pelican-world'),
  node('marnie-ranch', '玛妮牧场', 'building', -520, 300, 'coal-forest'),
  node('carpenter', '木匠店', 'building', -320, -320, 'pelican-world'),
  node('mountain', '山区', 'region', 0, -300, 'pelican-world'),
  node('mountain-mines', '矿井', 'building', 220, -300, 'mountain'),
  node('railroad', '铁路', 'region', 440, -300, 'mountain'),
  node('town-sewer', '下水道', 'building', 0, 300, 'pelican-world'),
  node('calico-desert', '卡利科沙漠', 'region', 700, -80, 'pelican-world'),
] as const

const stardewMap = map(
  'stardew-valley',
  '星露谷与鹈鹕镇',
  stardewLocations.map(item => ({ ...item, capacity: 64 })),
  [
  edge('farm-bus', 'valley-farm', 'bus-stop', 1_800),
  edge('bus-town', 'bus-stop', 'town-square', 1_200),
  edge('town-clinic', 'town-square', 'town-clinic', 300),
  edge('town-store', 'town-square', 'general-store', 300),
  edge('town-saloon', 'town-square', 'saloon', 300),
  edge('town-blacksmith', 'town-square', 'blacksmith', 600),
  edge('blacksmith-museum', 'blacksmith', 'museum', 300),
  edge('town-beach', 'town-square', 'ocean-beach', 1_200),
  edge('beach-fish', 'ocean-beach', 'fish-shop', 300),
  edge('farm-forest', 'valley-farm', 'coal-forest', 900),
  edge('forest-ranch', 'coal-forest', 'marnie-ranch', 300),
  edge('bus-carpenter', 'bus-stop', 'carpenter', 900),
  edge('carpenter-mountain', 'carpenter', 'mountain', 900),
  edge('mountain-mines', 'mountain', 'mountain-mines', 600),
  edge('mountain-railroad', 'mountain', 'railroad', 900),
  edge('town-sewer', 'town-square', 'town-sewer', 900),
  edge('bus-desert', 'bus-stop', 'calico-desert', 14_400),
  ].map(item => ({ ...item, capacity: 64 })),
)

const stardewResidents = [
  ['农场主', 'farmer', 'valley-farm', '经营农场，让土地、牲畜与社区共同繁荣。', '耕作的成果来自季节、劳动与邻里互助。', ['耕作', '采集']],
  ['阿比盖尔', 'adventurer', 'general-store', '探索矿井并守护自己的独立选择。', '勇气来自直面未知，而不是假装无所畏惧。', ['剑术', '长笛']],
  ['亚历克斯', 'athlete', 'town-square', '通过训练成为可靠的伙伴。', '真正的强大也包括照顾身边的人。', ['运动', '照料']],
  ['卡洛琳', 'gardener', 'general-store', '维护家庭与社区花园。', '耐心能让植物和关系一起生长。', ['园艺', '茶艺']],
  ['克林特', 'blacksmith', 'blacksmith', '完成镇民的锻造与工具升级需求。', '可靠的手艺必须经得住每天的重复检验。', ['锻造', '矿石鉴定']],
  ['德米特里厄斯', 'scientist', 'carpenter', '长期记录山谷生态与季节数据。', '结论必须来自可重复观察。', ['生态研究', '数据记录']],
  ['矮人', 'merchant', 'mountain-mines', '在矿井维持安全的地下交易。', '信任需要通过稳定交换逐步建立。', ['采矿', '贸易']],
  ['艾利欧特', 'writer', 'ocean-beach', '从镇民真实生活中完成小说。', '故事应尊重真实经历而不是凭空编造。', ['写作', '观察']],
  ['艾米丽', 'tailor', 'saloon', '通过裁缝和餐吧工作帮助镇民。', '每个人都值得被理解与善待。', ['裁缝', '服务']],
  ['艾芙琳', 'retiree', 'town-square', '照料公共花园并维系家人。', '社区记忆需要有人耐心保存。', ['烘焙', '园艺']],
  ['乔治', 'retiree', 'town-square', '保持独立生活并关心家人。', '尊严来自被平等对待。', ['生活经验']],
  ['格斯', 'innkeeper', 'saloon', '让餐吧每天供应食物并成为交流中心。', '一顿热饭能维系整个社区。', ['烹饪', '经营']],
  ['海莉', 'photographer', 'town-square', '记录四季与镇民生活的变化。', '认真观察能改变对他人的成见。', ['摄影', '社交']],
  ['哈维', 'doctor', 'town-clinic', '持续满足镇民的医疗与健康需求。', '健康与安全优先于便利。', ['医疗', '航空知识']],
  ['贾斯', 'student', 'marnie-ranch', '学习并在安全环境中成长。', '可信赖的大人会兑现承诺。', ['学习', '跳绳']],
  ['乔迪', 'homemaker', 'town-square', '照料家庭并保持家庭日程稳定。', '日常照料也是重要劳动。', ['烹饪', '家务']],
  ['肯特', 'veteran', 'town-square', '重新适应家庭和小镇生活。', '恢复需要时间与可信任的陪伴。', ['生存', '家庭照料']],
  ['科罗布斯', 'merchant', 'town-sewer', '维持下水道居所并谨慎理解人类。', '和平共处需要边界与互不伤害。', ['影子知识', '贸易']],
  ['莉亚', 'artist', 'coal-forest', '使用可持续材料完成雕塑。', '创作应与自然环境相互尊重。', ['雕塑', '采集']],
  ['雷欧', 'student', 'ocean-beach', '逐步融入镇民生活并保持自然联系。', '家既可以来自土地，也可以来自关系。', ['觅食', '攀爬']],
  ['刘易斯', 'mayor', 'town-square', '维持公共服务、节日与社区秩序。', '公共职责必须留下可审计的结果。', ['行政', '组织']],
  ['莱纳斯', 'forager', 'mountain', '以可持续方式在野外生活。', '自然给予的资源不应被过度索取。', ['觅食', '生存']],
  ['玛妮', 'rancher', 'marnie-ranch', '照料牲畜并稳定供应畜产品。', '动物福利是牧场经营的底线。', ['畜牧', '经营']],
  ['玛鲁', 'engineer', 'town-clinic', '兼顾诊所工作并推进实用发明。', '技术应当解决真实需求。', ['工程', '护理']],
  ['潘姆', 'driver', 'bus-stop', '维持巴士线路并改善自己的生活状态。', '稳定工作能够重新建立信任。', ['驾驶', '维修']],
  ['潘妮', 'teacher', 'town-square', '持续为孩子们提供教学。', '教育能给人选择未来的能力。', ['教学', '阅读']],
  ['皮埃尔', 'shopkeeper', 'general-store', '保障杂货店库存和农产品收购。', '本地经营依赖长期信誉。', ['经营', '库存']],
  ['罗宾', 'carpenter', 'carpenter', '按期完成镇民建筑与修缮需求。', '可靠工程来自计划和扎实手艺。', ['木工', '建筑']],
  ['山姆', 'musician', 'town-square', '兼顾工作、家人与乐队创作。', '热情需要日常练习才能变成作品。', ['音乐', '滑板']],
  ['桑迪', 'shopkeeper', 'calico-desert', '经营沙漠商店并维持跨区域往来。', '远距离关系也需要持续联系。', ['经营', '沙漠知识']],
  ['塞巴斯蒂安', 'programmer', 'carpenter', '完成编程工作并保持个人空间。', '独处和可靠关系并不矛盾。', ['编程', '摩托维修']],
  ['谢恩', 'worker', 'marnie-ranch', '履行工作并逐步改善健康状态。', '改变来自一次次可完成的小选择。', ['动物照料', '物流']],
  ['文森特', 'student', 'town-square', '学习、玩耍并与家人保持联系。', '好奇心应在安全边界内成长。', ['学习', '游戏']],
  ['威利', 'fisher', 'fish-shop', '维持渔具店并遵守可持续捕鱼原则。', '海洋资源必须留给下一个季节。', ['钓鱼', '航海']],
  ['法师', 'wizard', 'coal-forest', '观察山谷异常并避免魔法扰乱日常秩序。', '力量必须服从因果与边界。', ['魔法研究', '结界']],
] as const

const stardewCharacters: WorldlineAcceptanceScenario['characters'] = stardewResidents.map(([
  name, occupation, location, goal, belief, skills,
]) => ({
  name,
  biography: `${name}居住在鹈鹕镇生活圈，职业为${occupation}，拥有固定工作与社区需求。`,
  goal,
  belief,
  skills,
  state: {
    locationId: `map-node:${location}`,
    homeLocationId: `map-node:${location}`,
    workLocationId: `map-node:${location}`,
    occupation,
    energy: 10,
    workDays: 0,
    socialInteractions: 0,
    communityContributions: 0,
  },
}))

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
      node('ash-world', '灰烬边境', 'world', 0, -140),
      node('dawn-village', '晨钟村', 'city', -300, 100, 'ash-world'),
      node('scorched-pass', '燃痕山道', 'region', 0, 100, 'ash-world'),
      node('dragon-lair', '赤焰龙巢', 'building', 300, 100, 'ash-world'),
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
  {
    slug: 'stardew-valley-town',
    name: '星露谷物语：鹈鹕镇长期演算验收',
    characters: stardewCharacters,
    purpose: {
      summary: '在不依赖模型的情况下，让星露谷农场与鹈鹕镇居民连续自治一千个游戏日。',
      scope: ['农场经营', '职业履约', '人际互动', '移动轨迹', '角色记忆', '季节', '长期活性'],
      duration: 1_000 * 86_400,
      resolution: 300,
      detail: 'L3',
      hardExpectations: [
        '每名居民都必须长期产生职业、社交、休息或移动行为，不能永久停滞。',
        '角色记忆、关系和行动经验必须来自已经发生的可追溯事件。',
        '农场、环境、经济、社区与游戏内历法必须连续演进一千日。',
      ],
      statisticalExpectations: ['所有居民都有行动经验', '所有居民都建立至少一条互动关系', '地图产生跨地点轨迹'],
      antiPatterns: ['依赖外部模型推进', '角色长期无动作', '现实时间替代游戏时间', '无依据状态跳变'],
    },
    map: stardewMap,
    acceptanceAction: 'town.work',
    expectedExecutables: { actions: 5, systems: 3, invariants: 4 },
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
    preconditions: [{ op: 'gt', path: 'state.stamina', value: 0 }],
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
  if (scenario.slug === 'stardew-valley-town') return `# 鹈鹕镇长期运行规则

一天等于 86400 个游戏逻辑秒。角色行为、农场状态、季节与社区变化都只能由以下动作和周期系统推进。

\`\`\`worldline-action
${JSON.stringify({
    id: 'town.work', description: '履行角色当前职业的日常工作', operator: 'generic', actorTypes: ['character'],
    preconditions: [{ op: 'gt', path: 'state.energy', value: 0 }], duration: 21_600, maxWait: 86_400,
    retryBudget: 3, effects: [
      { op: 'increment', path: 'state.energy', amount: -1, min: 0, max: 10 },
      { op: 'increment', path: 'state.workDays', amount: 1, min: 0 },
      { op: 'increment', path: 'world.farm.laborUnits', amount: 1, min: 0 },
      { op: 'increment', path: 'world.economy.serviceUnits', amount: 1, min: 0 },
    ],
  }, null, 2)}
\`\`\`

\`\`\`worldline-action
${JSON.stringify({
    id: 'town.socialize', description: '与一名镇民进行有来有往的社区交流', operator: 'generic', actorTypes: ['character'],
    preconditions: [
      { op: 'gt', path: 'state.energy', value: 0 },
      { op: 'gte', path: 'target.state.socialInteractions', value: 0 },
    ], duration: 7_200, maxWait: 86_400, retryBudget: 3, effects: [
      { op: 'increment', path: 'state.energy', amount: -1, min: 0, max: 10 },
      { op: 'increment', path: 'state.socialInteractions', amount: 1, min: 0 },
      { op: 'increment', path: 'target.state.socialInteractions', amount: 1, min: 0 },
      { op: 'increment', path: 'world.community.interactions', amount: 1, min: 0 },
    ],
  }, null, 2)}
\`\`\`

\`\`\`worldline-action
${JSON.stringify({
    id: 'town.rest', description: '休息并恢复继续生活所需的精力', operator: 'generic', actorTypes: ['character'],
    duration: 28_800, maxWait: 86_400, retryBudget: 3,
    effects: [{ op: 'increment', path: 'state.energy', amount: 3, min: 0, max: 10 }],
  }, null, 2)}
\`\`\`

\`\`\`worldline-action
${JSON.stringify({
    id: 'town.community', description: '参加公共事务、节日筹备或邻里互助', operator: 'generic', actorTypes: ['character'],
    duration: 14_400, maxWait: 86_400, retryBudget: 3, effects: [
      { op: 'increment', path: 'state.communityContributions', amount: 1, min: 0 },
      { op: 'increment', path: 'world.community.contributions', amount: 1, min: 0 },
    ],
  }, null, 2)}
\`\`\`

\`\`\`worldline-action
${JSON.stringify({
    id: 'town.travel', description: '沿地图道路前往另一个真实地点', operator: 'move', actorTypes: ['character'],
    duration: 0, maxWait: 86_400, retryBudget: 3, effects: [],
  }, null, 2)}
\`\`\`

\`\`\`worldline-system
${JSON.stringify({
    id: 'town.environment.daily', description: '每日结算环境与农场生长', nextWake: 86_400, interval: 86_400,
    effects: [
      { op: 'increment', path: 'world.environment.daysElapsed', amount: 1, min: 0 },
      { op: 'increment', path: 'world.farm.cropGrowth', amount: 1, min: 0 },
      { op: 'increment', path: 'world.farm.soilCycles', amount: 1, min: 0 },
      { op: 'increment', path: 'world.economy.dailyDemand', amount: 1, min: 0 },
    ],
  }, null, 2)}
\`\`\`

\`\`\`worldline-system
${JSON.stringify({
    id: 'town.community.weekly', description: '每七日结算一次社区活动', nextWake: 7 * 86_400,
    interval: 7 * 86_400, effects: [{ op: 'increment', path: 'world.community.weeklyGatherings', amount: 1, min: 0 }],
  }, null, 2)}
\`\`\`

\`\`\`worldline-system
${JSON.stringify({
    id: 'town.season.transition', description: '每二十八日记录一次季节交替', nextWake: 28 * 86_400,
    interval: 28 * 86_400, effects: [{ op: 'increment', path: 'world.environment.seasonTransitions', amount: 1, min: 0 }],
  }, null, 2)}
\`\`\`

${[
    ['town.energy.nonnegative', '角色精力不能为负', 'state.energy'],
    ['town.work.nonnegative', '角色工作日不能为负', 'state.workDays'],
    ['town.farm.nonnegative', '农场生长不能倒退', 'world.farm.cropGrowth'],
    ['town.calendar.nonnegative', '游戏日不能为负', 'world.calendar.absoluteDay'],
  ].map(([id, description, path]) => `\`\`\`worldline-invariant\n${JSON.stringify({
    id, description, expression: { op: 'gte', path, value: 0 },
  }, null, 2)}\n\`\`\``).join('\n\n')}
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
    : character.biography
      ?? `${character.name}是${scenario.name}中拥有明确边界的原创角色，其知识和决策只能来自亲历观察。`
  const goal = character.goal ?? (character.name.includes('勇士')
    ? '守护晨钟村，并查明赤焰龙夺取王冠的真正原因。'
    : '守住最后一枚龙卵，同时决定是否相信前来挑战的勇士。')
  const belief = character.belief ?? (character.name.includes('勇士')
    ? '力量必须为守护负责，胜利不能以无辜者为代价。'
    : '凡人会夺走龙族遗物，但勇气也可能证明承诺。')
  return `# ${character.name}

${dragonStory}

<!-- worldline-facets ${JSON.stringify({
    initialState: character.state,
    memory: {
      episodic: [dragonStory],
      beliefs: { core: { subject: '世界信念', value: belief, confidence: 0.9 } },
      goals: [{ goal, status: 'active' }],
      skills: character.skills !== undefined
        ? character.skills.map((skill, index) => ({ skill, level: Math.max(1, 3 - index) }))
        : character.name.includes('勇士')
        ? [{ skill: '盾剑战斗', level: 3 }, { skill: '追踪', level: 2 }]
        : [{ skill: '龙焰控制', level: 4 }, { skill: '古代记忆', level: 3 }],
    },
  })} -->
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
  if (scenario.slug === 'stardew-valley-town') return `# 星露谷与鹈鹕镇世界宪章

<!-- worldline-facets ${JSON.stringify({
    initialWorldState: {
      world: {
        calendar: {
          secondsPerDay: 86_400,
          daysPerSeason: 28,
          seasons: ['春', '夏', '秋', '冬'],
          absoluteDay: 1,
          year: 1,
          season: '春',
          dayOfSeason: 1,
          timeOfDaySeconds: 0,
        },
        environment: { daysElapsed: 0, seasonTransitions: 0 },
        farm: { laborUnits: 0, cropGrowth: 0, soilCycles: 0 },
        economy: { serviceUnits: 0, dailyDemand: 0 },
        community: { interactions: 0, contributions: 0, weeklyGatherings: 0 },
      },
    },
  })} -->

1. 游戏内一天固定为 86400 个逻辑秒，四季各 28 日；现实时间不参与世界结算。
2. 每位居民拥有职业、精力、目标、信念、技能、地点、行动经验与人际关系，不能退化成无名统计量。
3. 工作、社交、移动、休息、农场生长和社区事件都必须由已声明动作或周期系统产生。
4. 文字叙事只能根据 Run 事件、观察、地图与记忆组织表达，不得凭空改写权威状态。
5. 一千日验收要求所有居民保持活性、不陷入永久等待，并留下可回放的因果记录。
`
  return `# ${scenario.name}世界宪章

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
  if (scenario.slug === 'stardew-valley-town') return `# 鹈鹕镇起始时间线

- 第一年春季第一日：农场主抵达星露谷农场，土地、居民职业和道路网络进入可运行状态。
- 镇民保留各自住所、工作地点、目标与技能；尚未发生的互动不能提前进入任何角色记忆。
- 世界从这个统一事实快照开始，之后每次变化都必须能够追溯到动作或周期系统。
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
  if (scenario.slug === 'stardew-valley-town') return `# 一千日小镇长期演算

从第一年春季第一日开始，无需外部模型干预，让所有居民按照可执行动作持续工作、社交、休息、参与社区事务并沿真实地图移动。

验收条件：运行到第 1001 个游戏日；每位居民都有工作、社交、移动或社区行为留下的行动经验和记忆；职业、精力、关系与地点始终有效；农场、环境、经济和社区指标持续推进；无失败进程、无永久等待、无状态越界；叙事只复述权威记录。
`
  return `# ${scenario.name} opening

Start from the authored map, actors, rules, and observable success criteria.
`
}
