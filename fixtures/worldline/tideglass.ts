import type {
  ActionDefinition,
  InvariantDefinition,
  JsonObject,
  MapNodeId,
  SystemDefinition,
  WorldMap,
} from '@deepseek-ai/dsh-worldline-standard'

/**
 * A deliberately demanding OC acceptance world. It combines asymmetric knowledge,
 * spatial travel, a worsening timed crisis, heterogeneous character state, mutable
 * world state, three evidence-driven plot points, and project-owned media.
 */
export const TIDEGLASS_WORLD_NAME = '潮痕档案馆：失声汛夜'

const node = (
  id: string,
  name: string,
  kind: WorldMap['nodes'][number]['kind'],
  x: number,
  y: number,
  parentId?: string,
  background?: string,
): WorldMap['nodes'][number] => ({
  id: `map-node:${id}` as MapNodeId,
  layerId: 'tide-level',
    kind,
    name,
    description: `${name} 是汐镜港潮灾运行地图中的完整地点；潮湿空气、机械回声与受限通路构成可感知环境，并直接影响调查、避险和移动。`,
  ...(parentId === undefined ? {} : { parentId: `map-node:${parentId}` as MapNodeId }),
  ...(background === undefined ? {} : { background }),
  position: { x, y },
  permissions: [],
  hazards: [],
  entryNodeIds: [],
})

const edge = (
  id: string,
  from: string,
  to: string,
  duration: number,
  hazards: readonly string[] = [],
): WorldMap['edges'][number] => ({
  id: `map-edge:${id}` as WorldMap['edges'][number]['id'],
  from: `map-node:${from}` as MapNodeId,
  to: `map-node:${to}` as MapNodeId,
  bidirectional: true,
  distance: duration,
  baseDuration: duration,
  capacity: 8,
  modes: ['walk'],
  permissions: [],
  hazards,
})

export const tideglassMap: WorldMap = {
  id: 'map:tideglass-archive' as WorldMap['id'],
  version: 1,
  name: '汐镜港与潮痕档案馆',
  rootNodeId: 'map-node:tideglass-city' as MapNodeId,
  layers: [{ id: 'tide-level', name: '潮面城区', visible: true, locked: false, order: 0 }],
  nodes: [
    node('tideglass-city', '汐镜港', 'world', 0, -180),
    node('archive-sorting', '档案馆分拣厅', 'room', -360, 40, 'tideglass-city', 'assets/files/locations/archive-sorting.svg'),
    node('tide-bridge', '第七潮桥', 'building', -80, 150, 'tideglass-city', 'assets/files/locations/tide-bridge.svg'),
    node('signal-tower', '旧信号塔', 'building', 220, 40, 'tideglass-city', 'assets/files/locations/signal-tower.svg'),
    node('market-shelter', '浮市避难所', 'building', 500, 170, 'tideglass-city'),
    node('submerged-stack', '水下七号库', 'room', 120, 320, 'tideglass-city'),
  ],
  edges: [
    edge('archive-bridge', 'archive-sorting', 'tide-bridge', 420, ['风浪']),
    edge('bridge-tower', 'tide-bridge', 'signal-tower', 360, ['湿滑索道']),
    edge('tower-market', 'signal-tower', 'market-shelter', 300),
    edge('bridge-stack', 'tide-bridge', 'submerged-stack', 480, ['水压', '停电']),
  ],
  provenance: [],
}

export const tideglassActions: readonly Omit<ActionDefinition, 'provenance'>[] = [
  {
    id: 'archive.investigate',
    description: '检查当前地点的记录、裂纹或信号，留下可核对证据。',
    operator: 'generic',
    location: { mode: 'anywhere' },
    actorTypes: ['character'],
    preconditions: [{ op: 'gt', path: 'state.stamina', value: 0 }],
    claims: [],
    duration: 180,
    effects: [
      { op: 'increment', path: 'state.stamina', amount: -1, min: 0 },
      { op: 'increment', path: 'world.signal.authenticityEvidence', amount: 1, min: 0, max: 5 },
    ],
    interruptible: true,
    maxWait: 900,
    maxRetries: 2,
    fallbacks: [],
  },
  {
    id: 'archive.confer',
    description: '与同地角色核对各自亲历的事实，以信任为代价缩小信息差。',
    operator: 'generic',
    location: { mode: 'anywhere' },
    actorTypes: ['character'],
    preconditions: [
      { op: 'gt', path: 'state.stamina', value: 0 },
      { op: 'gte', path: 'target.state.trust', value: 0 },
    ],
    claims: [],
    duration: 240,
    effects: [
      { op: 'increment', path: 'state.trust', amount: 1, min: 0, max: 10 },
      { op: 'increment', path: 'target.state.trust', amount: 1, min: 0, max: 10 },
    ],
    interruptible: true,
    maxWait: 900,
    maxRetries: 2,
    fallbacks: [],
  },
  {
    id: 'archive.reinforce',
    description: '使用现场材料加固潮桥或电力接点，消耗体力换取危机窗口。',
    operator: 'generic',
    location: { mode: 'at', nodeIds: ['map-node:tide-bridge' as MapNodeId] },
    actorTypes: ['character'],
    preconditions: [
      { op: 'gt', path: 'state.stamina', value: 1 },
      { op: 'eq', path: 'state.locationId', value: 'map-node:tide-bridge' },
    ],
    claims: [],
    duration: 300,
    effects: [
      { op: 'increment', path: 'state.stamina', amount: -2, min: 0 },
      { op: 'increment', path: 'world.bridge.integrity', amount: 8, min: 0, max: 100 },
    ],
    interruptible: true,
    maxWait: 900,
    maxRetries: 2,
    fallbacks: [],
  },
  {
    id: 'archive.travel',
    description: '沿已建模的桥道前往相邻地点，行程受真实距离和风浪影响。',
    operator: 'move',
    actorTypes: ['character'],
    preconditions: [{ op: 'gt', path: 'state.stamina', value: 0 }],
    claims: [],
    duration: 0,
    effects: [],
    interruptible: true,
    maxWait: 1_200,
    maxRetries: 2,
    fallbacks: [],
  },
  {
    id: 'archive.wait',
    description: '原地观察汛情和周围人的反应，世界危机仍会继续推进。',
    operator: 'generic',
    location: { mode: 'anywhere' },
    actorTypes: ['character'],
    preconditions: [],
    claims: [],
    duration: 120,
    effects: [],
    interruptible: true,
    maxWait: 600,
    maxRetries: 2,
    fallbacks: [],
  },
]

export const tideglassSystems: readonly Omit<SystemDefinition, 'provenance'>[] = [
  {
    id: 'storm.escalation',
    description: '每十分钟潮暴加剧，潮桥承压并缩短疏散窗口。',
    nextWake: 600,
    interval: 600,
    preconditions: [],
    effects: [
      { op: 'increment', path: 'world.storm.pressure', amount: 1, min: 0, max: 10 },
      { op: 'increment', path: 'world.bridge.integrity', amount: -2, min: 0, max: 100 },
    ],
  },
  {
    id: 'archive.power-drain',
    description: '每十五分钟水下库排水泵消耗一格馆藏电力。',
    nextWake: 900,
    interval: 900,
    preconditions: [{ op: 'gt', path: 'world.archive.powerReserve', value: 0 }],
    effects: [{ op: 'increment', path: 'world.archive.powerReserve', amount: -1, min: 0, max: 6 }],
  },
]

export const tideglassInvariants: readonly Omit<InvariantDefinition, 'provenance'>[] = [
  {
    id: 'archive.stamina.nonnegative',
    description: '任何角色的体力都不能为负数。',
    expression: { op: 'gte', path: 'state.stamina', value: 0 },
  },
  {
    id: 'archive.bridge.nonnegative',
    description: '潮桥完整度不能低于零。',
    expression: { op: 'gte', path: 'world.bridge.integrity', value: 0 },
  },
  {
    id: 'archive.time.nonnegative',
    description: '游戏内时间不能倒流。',
    expression: { op: 'gte', path: 'world.time', value: 0 },
  },
]

const { provenance: _tideglassMapProvenance, ...tideglassRuntimeMap } = tideglassMap

export const tideglassRuntime = {
  maps: [tideglassRuntimeMap] as unknown as JsonObject[],
  actions: tideglassActions as unknown as JsonObject[],
  systems: tideglassSystems as unknown as JsonObject[],
  invariants: tideglassInvariants as unknown as JsonObject[],
}

const stateSemantics: Readonly<Record<string, readonly [string, string, string, string]>> = {
  locationId: ['当前位置', '角色在权威地图中的实际落点', '场景、感官与在场人物服从此地点', '只提供当前位置或可达目的地允许的行动'],
  stamina: ['体力', '继续调查、移动和抢险的身体余量', '低体力通过呼吸、动作稳定性和反应速度表现', '体力越低越重视休整、协作与低消耗路线'],
  emotion: ['情绪', '角色此刻判断风险和表达关系的心理姿态', '语气、注意点和身体反应服从当前情绪', '选择措辞与风险偏好随情绪变化'],
  inventory: ['随身物品', '角色真实持有且可用于行动的资源', '只让已持有物品进入动作和感官描写', '可用物品决定调查、加固与核验手段'],
  evidence: ['证据', '角色持有的可核验事实链', '证据改变角色说服方式与确定程度', '证据不足时优先核验而非公开定论'],
  trust: ['信任', '角色愿意共享风险和信息的程度', '信任改变距离、保留和回应方式', '低信任偏向验证，高信任允许协作承诺'],
  routeSense: ['潮路感知', '辨别逆流与安全路线的能力', '通过水声、风向和潮纹观察表现', '感知越强越可能提出核验路线的行动'],
  guilt: ['负罪感', '私人牵连对公开证据的阻力', '高负罪感表现为迟疑和关键句保留', '负罪越高越重视保全证据与渐进披露'],
  disclosedSplice: ['拼接结论已披露', '拼接证据是否进入共享认知', '披露后对话可直接讨论拼接事实', '未披露时提供坦白或独自核验方向'],
  bridgeEstimate: ['桥梁估算', '机械师对潮桥剩余承载的专业判断', '数值通过裂缝、震动与机械噪声体现', '估算越低越优先疏散、加固和资源取舍'],
  admittedReport: ['报告责任已承认', '隐去缺陷的责任是否进入公共证据', '承认改变人物姿态与他人回应', '未承认时保留质询或实物核验路线'],
  signalClarity: ['信号清晰度', '校验广播能被公众辨认的程度', '清晰度通过噪声、失真与回声表现', '低清晰度优先修复和短距离验证'],
  broadcastReady: ['广播就绪', '真实信号是否具备可播出条件', '就绪状态改变设备灯号与报务员节奏', '未就绪时必须补齐校验或供电条件'],
  'storm.pressure': ['潮暴压力', '风浪对全城通行和设施的实时负荷', '压力通过雨幕、结构震动和潮声侵入场景', '压力越高越偏向避险、加固与缩短路线'],
  'storm.phase': ['潮暴阶段', '全城当前执行的灾害等级', '阶段决定警报、人员行为和可见环境', '高阶段压缩调查时间并提高救援优先级'],
  'bridge.integrity': ['潮桥完整度', '第七潮桥可继续承载的结构余量', '完整度通过裂纹、倾斜和异响表现', '完整度越低越需要加固、限流或放弃通行'],
  'bridge.allocation': ['电力分配', '最后电力优先服务疏散还是档案', '分配改变灯光、泵机和桥面设备响应', '选择必须正视另一侧会失去什么'],
  'signal.authenticityEvidence': ['信号真实性证据', '广播被篡改已有多少独立核验', '证据增长让角色语气从怀疑转向可公开判断', '证据不足先核验，充分后可公开纠正'],
  'evacuation.status': ['疏散状态', '居民当前依据哪种指令行动', '状态通过人流、广播和警戒反应表现', '错误疏散时优先纠偏、拦截与验证'],
  'archive.powerReserve': ['档案电力', '水下馆藏与设备还能维持的能源余量', '低电力通过灯光衰减和泵机停顿表现', '余量越低越迫使保存、转移或放弃的取舍'],
}

function participatingSchema(
  source: string,
  drivers: Readonly<Record<string, readonly string[]>> = {},
): string {
  return source.split(/\r?\n/gu).map((line) => {
    const match = /^([A-Za-z][A-Za-z0-9.]*):\s*\{\s*type:\s*(\w+),\s*mutable:\s*(true|false)(?:,\s*minimum:\s*(-?\d+))?(?:,\s*maximum:\s*(-?\d+))?\s*\}$/u.exec(line.trim())
    if (match === null) return line
    const [, path = '', type = 'string', mutable = 'true', rawMin, rawMax] = match
    const semantics = stateSemantics[path]
    if (semantics === undefined) throw new Error(`missing Tideglass state semantics for ${path}`)
    const [label, meaning, narrative, choices] = semantics
    const selectedDrivers = path === 'locationId' ? ['movement'] : drivers[path] ?? ['director']
    const midpoint = Math.floor((Number(rawMin ?? 0) + Number(rawMax ?? 10)) / 2)
    const numericBands = type !== 'number' ? '' : `
    bands:
      - { max: ${String(midpoint)}, label: 受压, narrative: ${narrative}, choices: ${choices} }
      - { min: ${String(midpoint + 1)}, label: 充足, narrative: ${narrative}, choices: ${choices} }`
    return `${path}:
  type: ${type}
  mutable: ${mutable}${rawMin === undefined ? '' : `\n  minimum: ${rawMin}`}${rawMax === undefined ? '' : `\n  maximum: ${rawMax}`}
  label: ${label}
  participation:
    drivers: [${selectedDrivers.join(', ')}]
    meaning: ${meaning}
    narrative: ${narrative}
    choices: ${choices}${numericBands}`
  }).join('\n')
}

const characterDocument = (input: {
  readonly name: string
  readonly description: string
  readonly identity: string
  readonly personality: string
  readonly goal: string
  readonly knowledge: string
  readonly portrait: string
  readonly voice?: string
  readonly stateSchema: string
  readonly initialState: string
  readonly memory: string
}): string => `# ${input.name}

${input.description}

## 基本信息

- 身份／职业：${input.identity}
- 性格：${input.personality}
- 目标：${input.goal}

## 记忆与知识

${input.knowledge}

## 角色资源

- 头像：${input.portrait}
${input.voice === undefined ? '' : `- 语音：${input.voice}\n`}
\`\`\`worldline-state-schema
${participatingSchema(input.stateSchema.trim(), {
  stamina: ['action', 'director'],
  trust: ['action', 'director'],
})}
\`\`\`

\`\`\`worldline-initial-state
${input.initialState.trim()}
\`\`\`

\`\`\`worldline-memory
${input.memory.trim()}
\`\`\`
`

export const tideglassDocuments: readonly {
  readonly path: string
  readonly documentId: string
  readonly content: string
}[] = [
  {
    path: 'canon/charter.md',
    documentId: 'document:tideglass-charter',
    content: `# 汐镜港世界宪章

汐镜港依靠潮玻璃保存人的记忆。潮玻璃可以存证，但不会自动说出真相；角色只能知道亲历、被告知或已核验的事实。

汛夜中，第七潮桥只能在“居民疏散”和“水下馆藏供电”之间优先一方。没有无代价的第三条路；失败必须留下可继续的后果。

\`\`\`worldline-initial-world-state
world:
  time: 0
  calendar:
    secondsPerDay: 86400
    daysPerSeason: 24
    seasons: [平潮季, 涌潮季, 退潮季]
    week: 8
    weekday: 周四
    startDayIndex: 35
    startClockMinute: 1040
  storm:
    pressure: 3
    phase: 橙色预警
  bridge:
    integrity: 54
    allocation: 未决定
  signal:
    authenticityEvidence: 0
  evacuation:
    status: 等待真实指令
  archive:
    powerReserve: 4
\`\`\`

\`\`\`worldline-world-state-schema
${participatingSchema(`storm.pressure: { type: number, mutable: true, minimum: 0, maximum: 10 }
storm.phase: { type: string, mutable: true }
bridge.integrity: { type: number, mutable: true, minimum: 0, maximum: 100 }
bridge.allocation: { type: string, mutable: true }
signal.authenticityEvidence: { type: number, mutable: true, minimum: 0, maximum: 5 }
evacuation.status: { type: string, mutable: true }
archive.powerReserve: { type: number, mutable: true, minimum: 0, maximum: 6 }`, {
  'storm.pressure': ['system', 'director'],
  'bridge.integrity': ['action', 'system', 'director'],
  'signal.authenticityEvidence': ['action', 'director'],
  'archive.powerReserve': ['system', 'director'],
})}
\`\`\`
`,
  },
  {
    path: 'timelines/canon.md',
    documentId: 'document:tideglass-timeline',
    content: `# 失声汛夜前史

- 潮历四十三年涌潮季第十一日：港务厅录制了一条将在汛夜播放的疏散指令。
- 次日午后：官方母带被替换，伪指令要求居民逆着潮流穿过第七潮桥。
- 第三日 17:20：潮暴进入橙色预警，谢澜带着一枚来路不明的封存潮玻璃进入档案馆分拣厅。故事从这一分钟开始。
`,
  },
  {
    path: 'mechanisms/core.md',
    documentId: 'document:tideglass-mechanisms',
    content: `# 汛夜因果规则

调查、对话、加固、移动和等待都消耗游戏内时间。潮暴与排水泵会在角色犹豫时继续运行；桥梁完整度、体力和电力不得凭叙述跳变。
`,
  },
  {
    path: 'characters/xielan.md',
    documentId: 'document:tideglass-xielan',
    content: characterDocument({
      name: '谢澜',
      description: '十九岁的潮邮员，也是玩家视角。她擅长从潮纹辨认路径，却不知道失踪姐姐为何在潮玻璃中留下自己的声音。',
      identity: '潮邮员／紧急投递人',
      personality: '敏锐、固执，对被替别人决定极为警惕',
      goal: '验证伪疏散信号，并决定该把姐姐的封存记忆交给谁',
      knowledge: '她亲历了北码头逆流，知道伪指令指向的路线会在一小时内被淹没；她不知道录音是谁篡改的。',
      portrait: 'assets/files/characters/xielan/portrait.svg',
      voice: 'assets/files/characters/xielan/voice.wav',
      stateSchema: `locationId: { type: string, mutable: false }
stamina: { type: number, mutable: true, minimum: 0, maximum: 10 }
emotion: { type: string, mutable: true }
inventory: { type: array, mutable: true }
evidence: { type: array, mutable: true }
trust: { type: number, mutable: true, minimum: 0, maximum: 10 }
routeSense: { type: number, mutable: true, minimum: 0, maximum: 5 }`,
      initialState: `locationId: map-node:archive-sorting
stamina: 8
emotion: 强作镇定
inventory: [封存潮玻璃, 铜制路牌, 防水笔]
evidence: [北码头逆流记录]
trust: 2
routeSense: 4`,
      memory: `episodic:
  - 姐姐失踪前叮嘱谢澜：别让任何人替整座城市选择应该忘记什么。
beliefs:
  verifiedRoute: 北码头已经开始逆流
goals:
  - goal: 在潮暴前证明哪一条疏散信号是真的
    status: active`,
    }),
  },
  {
    path: 'characters/wenqi.md',
    documentId: 'document:tideglass-wenqi',
    content: characterDocument({
      name: '闻栖',
      description: '二十四岁的记忆修复师。她能辨认录音拼接痕迹，已发现伪疏散带中有父亲的签名噪声，因而担心公开真相会让父亲背负罪名。',
      identity: '档案馆记忆修复师',
      personality: '克制、严谨，会在证据不完整时保留关键句',
      goal: '保住证据链，同时确认父亲是参与伪造还是留下了警告',
      knowledge: '她知道伪指令由三段不同潮压下的录音拼接，但不知道信号塔是否仍保留母带。',
      portrait: 'assets/files/characters/wenqi/portrait.svg',
      stateSchema: `locationId: { type: string, mutable: false }
stamina: { type: number, mutable: true, minimum: 0, maximum: 10 }
emotion: { type: string, mutable: true }
inventory: { type: array, mutable: true }
trust: { type: number, mutable: true, minimum: 0, maximum: 10 }
guilt: { type: number, mutable: true, minimum: 0, maximum: 10 }
disclosedSplice: { type: boolean, mutable: true }`,
      initialState: `locationId: map-node:archive-sorting
stamina: 6
emotion: 回避目光
inventory: [拼接频谱, 修复手套]
trust: 1
guilt: 7
disclosedSplice: false`,
      memory: `episodic:
  - 闻栖独自检出伪录音中的签名噪声，尚未向任何人说明。
beliefs:
  splice: 疏散指令至少被拼接了两次
goals:
  - goal: 找到能分辨父亲责任的原始母带
    status: active`,
    }),
  },
  {
    path: 'characters/luoque.md',
    documentId: 'document:tideglass-luoque',
    content: characterDocument({
      name: '罗阙',
      description: '三十一岁的潮桥机械师。他是唯一知道第七潮桥实际承载极限的人：剩余电力只够保一边，而他曾在公开报告中隐去这个缺陷。',
      identity: '第七潮桥机械师',
      personality: '寡言、务实，遇到道德判断时会退回数字后面',
      goal: '在桥梁失稳前完成一次真实的资源选择，并承担报告造假的后果',
      knowledge: '他知道桥梁完整度低于四十时不能与水下库同时供电；他不知道伪信号由谁制作。',
      portrait: 'assets/files/characters/luoque/portrait.svg',
      stateSchema: `locationId: { type: string, mutable: false }
stamina: { type: number, mutable: true, minimum: 0, maximum: 10 }
emotion: { type: string, mutable: true }
inventory: { type: array, mutable: true }
trust: { type: number, mutable: true, minimum: 0, maximum: 10 }
bridgeEstimate: { type: number, mutable: true, minimum: 0, maximum: 100 }
admittedReport: { type: boolean, mutable: true }`,
      initialState: `locationId: map-node:tide-bridge
stamina: 7
emotion: 专注而防备
inventory: [手摇发电机, 裂缝量尺, 绝缘绳]
trust: 1
bridgeEstimate: 54
admittedReport: false`,
      memory: `episodic:
  - 罗阙在上次检修中删去了桥梁共供电失效的测试数据。
beliefs:
  loadLimit: 汛夜只能优先保住疏散或馆藏之一
goals:
  - goal: 阻止桥梁在错误调度下断裂
    status: active`,
    }),
  },
  {
    path: 'characters/xianjiu.md',
    documentId: 'document:tideglass-xianjiu',
    content: characterDocument({
      name: '弦九',
      description: '二十二岁的临时报务员。她将真实母带的末尾谐波藏在信号塔校时音里，但不确定这份备份是否足以说服城里的人。',
      identity: '旧信号塔临时报务员',
      personality: '快速、外放，在危险中用玩笑遮掩恐惧',
      goal: '让真实信号重新被听见，但不把未核验的猜测冒充成事实',
      knowledge: '她知道真母带的校验尾音藏在信号塔，但不知道档案馆中的潮玻璃内容。',
      portrait: 'assets/files/characters/xianjiu/portrait.svg',
      stateSchema: `locationId: { type: string, mutable: false }
stamina: { type: number, mutable: true, minimum: 0, maximum: 10 }
emotion: { type: string, mutable: true }
inventory: { type: array, mutable: true }
trust: { type: number, mutable: true, minimum: 0, maximum: 10 }
signalClarity: { type: number, mutable: true, minimum: 0, maximum: 10 }
broadcastReady: { type: boolean, mutable: true }`,
      initialState: `locationId: map-node:signal-tower
stamina: 5
emotion: 用玩笑压住紧张
inventory: [校时音叉, 应急耳机]
trust: 3
signalClarity: 6
broadcastReady: false`,
      memory: `episodic:
  - 弦九在停电前把母带末尾谐波混入了每半小时播放的校时音。
beliefs:
  checksum: 真实指令的末尾谐波与伪带不同
goals:
  - goal: 在信号塔彻底停机前播出可验证的信号
    status: active`,
    }),
  },
  {
    path: 'facts/opening-context.md',
    documentId: 'document:tideglass-opening',
    content: `# 分拣厅的失声来件

潮历四十三年涌潮季第十一日 17:20，谢澜与闻栖同处档案馆分拣厅。广播正在重复一条与谢澜亲历的潮流相矛盾的疏散指令；窗外的水位还在上升。

开场不能假定任何人已知道别人的秘密。主线提供强压力和恢复钩子，但玩家可以调查、对话、移动、加固、等待或自由表达意图。
`,
  },
  {
    path: 'scenarios/plot-points/01-false-signal.md',
    documentId: 'document:tideglass-plot01',
    content: `# 听出伪指令

谢澜对广播路线的亲历与闻栖手中的拼接痕迹可以互相印证，但两人必须先决定是否相信对方。

## 剧情推进

- 顺序：1
- 激活时刻（游戏秒）：0
- 截止时刻（游戏秒）：2400
- 时间干预：1800|首轮潮警|港区钟塔鸣响，提醒广播校验窗口只剩十分钟
- 进入条件：伪疏散广播正在播放，谢澜与闻栖同处分拣厅
- 完成证据：至少两条来自不同角色亲历或持有物的证据互相印证广播被篡改
- 戏剧压力：潮暴每十分钟加剧，错误广播正在引导居民走向逆流桥面
- 成功后果：信号塔成为可验证的下一目标，闻栖的拼接结论进入共享证据链
- 失败后果：两人分头行动，居民开始涌向危险路线
- 恢复钩子：即使错过分拣厅对话，信号塔的校时音与北码头逆流记录仍可重建证据链
`,
  },
  {
    path: 'scenarios/plot-points/02-bridge-choice.md',
    documentId: 'document:tideglass-plot02',
    content: `# 一座桥的两边

证实广播有假之后，人们必须面对潮桥与水下档案库共用最后电力的事实。

## 剧情推进

- 顺序：2
- 激活时刻（游戏秒）：2400
- 截止时刻（游戏秒）：5400
- 时间干预：4500|桥梁封闭预告|警戒队宣布十五分钟后封闭主桥
- 进入条件：广播被篡改已有可追溯证据，潮桥仍未分配最后电力
- 完成证据：桥梁极限被明确告知并记录，且疏散与保存档案之间的代价已被真实承担
- 戏剧压力：桥梁完整度随每次潮暴结算下降，排水泵同时持续消耗电力
- 成功后果：已选择的资源分配成为最终广播中不得隐瞒的事实
- 失败后果：桥梁或水下库先行失效，最终广播必须承认不可逆损失
- 恢复钩子：即使罗阙拒绝承认报告问题，裂缝量尺、手摇发电机和桥面伤痕仍可构成第二条核验路径
`,
  },
  {
    path: 'scenarios/plot-points/03-public-memory.md',
    documentId: 'document:tideglass-plot03',
    content: `# 让城市听见代价

真实广播不只需要更正路线，还必须公开谁承担了什么、又失去了什么。

## 剧情推进

- 顺序：3
- 激活时刻（游戏秒）：5400
- 截止时刻（游戏秒）：9000
- 时间干预：8100|末班潮讯|伪月台发出最后一次全城广播校验倒计时
- 进入条件：广播伪造与桥梁资源代价都已进入共享证据链
- 完成证据：真实校验音、实际疏散路线和资源损失被同时告知公众，且没有将猜测写成定论
- 戏剧压力：信号塔与档案馆都即将断电，只剩一次全城广播窗口
- 成功后果：居民依据可核验信息行动，失去的档案与保全的生命都被记入公共记忆
- 失败后果：城市依旧在伪指令中分裂，幸存者只能在后续调查中重建真相
- 恢复钩子：广播失败后，封存潮玻璃可作为不完整但可流传的私人见证，开启灾后追查线
`,
  },
]

export const tideglassAssetDestinations = [
  'assets/files/characters/xielan/portrait.svg',
  'assets/files/characters/xielan/voice.wav',
  'assets/files/characters/wenqi/portrait.svg',
  'assets/files/characters/luoque/portrait.svg',
  'assets/files/characters/xianjiu/portrait.svg',
  'assets/files/locations/archive-sorting.svg',
  'assets/files/locations/tide-bridge.svg',
  'assets/files/locations/signal-tower.svg',
] as const
