import type {
  EntityId,
  JsonObject,
  JsonValue,
  ProjectTemplate,
  RunSnapshot,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type { RunSpatialView } from '@deepseek-ai/dsh-worldline-runtime/types'
import { PROJECT_ASSET_PATH } from '../contract.ts'

const LABELS: Readonly<Record<string, string>> = {
  active: '已启用',
  approved: '已批准',
  autonomous: '自主行动',
  blank: '空白世界',
  blocked: '存在阻断',
  buildable: '可构建',
  cancelled: '已取消',
  character: '角色推理',
  charter: '世界宪章',
  'character-story': '角色故事',
  civilization: '文明',
  'civilization-sandbox': '文明沙盘',
  compiler: '世界编译',
  completed: '已完成',
  concept: '概念',
  cognition: '角色认知',
  canon: '正典',
  document: '文档',
  facet: '结构属性',
  belief: '认知',
  goal: '目标',
  policy: '行为策略',
  action: '动作',
  actions: '动作',
  lifecycle: '生命周期',
  environment: '环境',
  capability: '能力',
  ontology: '概念体系',
  relationship: '关系',
  provenance: '来源',
  event: '事件',
  scope: '作用范围',
  creative: '创作辅助',
  degraded: '降级运行',
  draft: '创作中',
  entity: '实体',
  failed: '失败',
  fairness: '公平调度',
  'first-person': '第一人称',
  frozen: '已冻结',
  healthy: '运行正常',
  high: '高',
  item: '物品',
  organization: '组织',
  species: '物种',
  relation: '关系',
  fact: '事实',
  timeline: '时间线事件',
  asset: '资源',
  custom: '自定义对象',
  'limited-third-person': '限知第三人称',
  low: '低',
  map: '地图',
  maps: '地图',
  medium: '中',
  narrator: '场景叙事',
  objective: '客观镜头',
  observation: '角色观察',
  open: '待回答',
  pass: '通过',
  paused: '已暂停',
  pending: '待审查',
  place: '地点',
  'playable-scenario': '可游玩剧本',
  player: '玩家接管',
  ready: '可运行',
  rejected: '已拒绝',
  rule: '规则',
  running: '推演中',
  scenario: '剧本',
  systems: '系统',
  invariants: '不变量',
  'social-simulation': '社会推演',
  stopped: '已停止',
  world: '世界',
  plane: '位面',
  region: '区域',
  city: '城市',
  building: '建筑',
  room: '房间',
  slot: '位置槽',
  walk: '步行',
  suggestions: '仅给出建议',
  summary: '记忆摘要',
  telemetry: '运行遥测',
  template: '本地叙事',
  'world-encyclopedia': '世界百科',
  'world-event': '世界事件',
  'decision-trace': '决策依据',
  'ai-intent': 'AI 意图',
  'ai-invocation': 'AI 调用',
  'narrative-beat': '叙事片段',
  'runtime-diagnostic': '运行诊断',
  queued: '等待中',
  closure: '闭包审查',
  purpose: '用途',
  'expectation profile': '预期档案',
  invariant: '不变量',
  space: '空间',
  process: '进程',
  practice: '实践',
  resource: '资源',
  ownership: '所有权',
  state: '状态',
  system: '系统',
  evidence: '证据',
  time: '时间',
  causality: '因果关系',
  safety: '安全性',
  liveness: '活性',
  'event-validity': '事件有效性',
  'behavioral-validity': '行为有效性',
  replay: '确定性回放',
  warning: '需要关注',
  'state delta': '状态变化',
  director: '导演规则',
  control: '控制方式',
  termination: '结束条件',
  projection: '投影',
  'media cue': '媒体提示',
  license: '授权',
  binding: '绑定',
  'epistemic state': '认知状态',
}

/** Generate a unique seed for an independent playthrough of the frozen Blueprint. */
export function newWorldlineSeed(): string {
  const random = globalThis.crypto.randomUUID()
  return `worldline-${Date.now().toString(36)}-${random}`
}

const TEMPLATE_DESCRIPTIONS: Readonly<Record<ProjectTemplate, string>> = {
  blank: '从一页空白宪章开始，自由定义世界。',
  'world-encyclopedia': '适合系统整理地点、组织、物种与历史。',
  'character-story': '围绕原创角色、关系与个人故事展开。',
  'social-simulation': '关注人群、制度、经济与社会互动。',
  'civilization-sandbox': '用于文明尺度的长期演化与推演。',
  'playable-scenario': '从设定到演算和文字游玩的完整起点。',
}

/** Perform worldline label through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function worldlineLabel(value: string): string {
  return LABELS[value.toLowerCase()] ?? value
}

/** Perform template label through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function templateLabel(value: ProjectTemplate): string {
  return worldlineLabel(value)
}

/** Perform template description through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function templateDescription(value: ProjectTemplate): string {
  return TEMPLATE_DESCRIPTIONS[value]
}

/** Perform chinese date through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function chineseDate(value: string | number | Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function mediaSource(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return text(value)
  const entry = object(value)
  return text(entry?.['url']) ?? text(entry?.['path']) ?? text(entry?.['src'])
}

/** Build a browser-safe URL for one project-owned resource or preserve an explicit URL. */
export function projectMediaUrl(projectId: string, source: string | undefined): string | undefined {
  if (source === undefined) return undefined
  if (/^(?:https?:|data:|blob:|\/)/iu.test(source)) return source
  if (!source.replace(/\\/gu, '/').startsWith('assets/')) return undefined
  const query = new URLSearchParams({ projectId, path: source.replace(/\\/gu, '/') })
  return `${PROJECT_ASSET_PATH}?${query.toString()}`
}

export interface CharacterResources {
  readonly portrait?: string
  readonly expression?: string
  readonly voice?: string
  readonly theme?: string
  readonly knowledge: readonly string[]
}

function variantKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/gu, '')
}

function runtimeVisualVariants(entity: JsonObject | undefined): readonly string[] {
  const state = object(entity?.['state'])
  const mental = object(state?.['mental'])
  const values = [
    state?.['expression'], state?.['emotion'], state?.['mood'], state?.['status'],
    state?.['currentEmotion'], state?.['emotionalState'], mental?.['expression'],
    mental?.['emotion'], mental?.['mood'], mental?.['status'],
  ]
  return [...new Set(values.flatMap(value => (
    typeof value === 'string' && value.trim() !== '' ? [value.trim()] : []
  )))]
}

function expressionSource(expressions: JsonObject | undefined, entity: JsonObject | undefined): string | undefined {
  if (expressions === undefined) return undefined
  const entries = Object.entries(expressions)
  for (const candidate of runtimeVisualVariants(entity)) {
    const direct = mediaSource(expressions[candidate])
    if (direct !== undefined) return direct
    const normalized = variantKey(candidate)
    const matching = entries.find(([key]) => variantKey(key) === normalized)
    const source = mediaSource(matching?.[1])
    if (source !== undefined) return source
  }
  return mediaSource(expressions['default'])
}

/** Resolve the resource index authored for one character without exposing its internal shape. */
export function characterResources(projectId: string, entity: JsonObject | undefined): CharacterResources {
  const facets = object(entity?.['facets'])
  const resources = object(facets?.['resources']) ?? object(facets?.['resourceIndex'])
  const visual = object(resources?.['visual']) ?? object(resources?.['art'])
  const audio = object(resources?.['audio'])
  const expressions = object(visual?.['expressions'])
  const knowledge = Array.isArray(resources?.['knowledge'])
    ? resources['knowledge'].flatMap(item => mediaSource(item) ?? []).slice(0, 20)
    : []
  const portrait = projectMediaUrl(projectId, mediaSource(visual?.['portrait']) ?? mediaSource(resources?.['portrait']))
  const expression = projectMediaUrl(projectId, expressionSource(expressions, entity) ?? mediaSource(visual?.['expression']))
  const voice = projectMediaUrl(projectId, mediaSource(audio?.['voice']) ?? mediaSource(resources?.['voice']))
  const theme = projectMediaUrl(projectId, mediaSource(audio?.['theme']) ?? mediaSource(resources?.['theme']))
  return {
    ...(portrait === undefined ? {} : { portrait }),
    ...(expression === undefined ? {} : { expression }),
    ...(voice === undefined ? {} : { voice }),
    ...(theme === undefined ? {} : { theme }),
    knowledge,
  }
}

/** Human-facing calendar projection. The deterministic clock remains internal. */
export interface GameCalendar {
  readonly configured: boolean
  readonly year: number
  readonly season: string
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly dateLabel: string
  readonly timeLabel: string
  readonly fullLabel: string
}

export interface WorldEnvironmentFact {
  readonly label: string
  readonly value: string
  readonly level: 'normal' | 'notice' | 'danger'
}

interface ClientCalendarProjection {
  readonly elapsedDays: number
  readonly year: number
  readonly season: string
  readonly dayOfSeason: number
  readonly hour: number
  readonly minute: number
}

function positiveInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

// Client packages cannot value-import Host standard packages. Keep this wire-only projection
// behaviorally locked to standard.projectAuthoredCalendar through the calendar regression suite.
function projectClientCalendar(state: JsonObject, logicalTime: number): ClientCalendarProjection | undefined {
  const world = object(state['world'])
  const calendar = object(world?.['calendar'])
  const secondsPerDay = calendar?.['secondsPerDay']
  const daysPerSeason = positiveInteger(calendar?.['daysPerSeason'])
  const startDayIndex = positiveInteger(calendar?.['startDayIndex'])
  const startClockMinute = calendar?.['startClockMinute']
  const seasons = Array.isArray(calendar?.['seasons'])
    ? calendar['seasons'].flatMap(item => typeof item === 'string' && item.trim() !== ''
      ? [item.trim()] : [])
    : []
  if (typeof secondsPerDay !== 'number' || !Number.isFinite(secondsPerDay) || secondsPerDay <= 0
    || daysPerSeason === undefined || startDayIndex === undefined
    || typeof startClockMinute !== 'number' || !Number.isFinite(startClockMinute)
    || startClockMinute < 0 || startClockMinute >= 1_440 || seasons.length === 0) return undefined

  const yearLength = daysPerSeason * seasons.length
  const startAbsoluteDay = startDayIndex - 1
  const derivedWithinYear = modulo(startAbsoluteDay, yearLength)
  const requestedSeason = text(calendar?.['startSeason']) ?? text(world?.['season'])
  const requestedSeasonIndex = requestedSeason === undefined ? -1 : seasons.indexOf(requestedSeason)
  const requestedDay = positiveInteger(calendar?.['startDayOfSeason'])
    ?? positiveInteger(world?.['day'])
  const hasNamedStart = requestedSeasonIndex >= 0
    && requestedDay !== undefined && requestedDay <= daysPerSeason
  const startSeasonIndex = hasNamedStart
    ? requestedSeasonIndex : Math.floor(derivedWithinYear / daysPerSeason)
  const startDay = hasNamedStart ? requestedDay : derivedWithinYear % daysPerSeason + 1
  const startWithinYear = startSeasonIndex * daysPerSeason + startDay - 1
  const startYear = positiveInteger(calendar?.['startYear'])
    ?? positiveInteger(world?.['year'])
    ?? Math.floor(startAbsoluteDay / yearLength) + 1
  const elapsed = startClockMinute / 1_440 * secondsPerDay + logicalTime
  const elapsedDays = Math.floor(elapsed / secondsPerDay)
  const progressedWithinYear = startWithinYear + elapsedDays
  const projectedWithinYear = modulo(progressedWithinYear, yearLength)
  const scaledSeconds = modulo(elapsed, secondsPerDay) / secondsPerDay * 86_400
  return {
    elapsedDays,
    year: startYear + Math.floor(progressedWithinYear / yearLength),
    season: seasons[Math.floor(projectedWithinYear / daysPerSeason)] ?? seasons[0] ?? '',
    dayOfSeason: projectedWithinYear % daysPerSeason + 1,
    hour: Math.floor(scaledSeconds / 3_600) % 24,
    minute: Math.floor(scaledSeconds % 3_600 / 60),
  }
}

function numberAt(value: JsonObject | undefined, path: readonly string[]): number | undefined {
  let current: JsonValue | undefined = value
  for (const key of path) current = object(current)?.[key]
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined
}

function valueAt(value: JsonObject | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const key of path.split('.')) current = object(current)?.[key]
  return current
}

const STATE_LABELS: Readonly<Record<string, string>> = {
  age: '年龄', occupation: '职业', job: '工作', energy: '精力', stamina: '体力', health: '健康',
  hunger: '饥饿', stress: '压力', sanity: '理智', infection: '感染', injury: '伤势', emotion: '情绪',
  affection: '好感', bond: '羁绊', trust: '信任', relationship: '关系', friendship: '好感',
  gold: '金币', money: '金钱', mood: '心情', status: '状态', locationId: '地点 ID',
  currentGoal: '当前目标', goal: '目标', season: '季节', weather: '天气', inventory: '随身物品',
  items: '随身物品', equipment: '装备', resources: '资源', evidence: '证据', guilt: '负罪感',
}

function readableStateLabel(path: string, field: JsonObject | undefined): string {
  const explicit = text(field?.['label']) ?? text(field?.['title'])
  if (explicit !== undefined) return explicit
  const key = path.split('.').at(-1) ?? path
  return STATE_LABELS[path] ?? STATE_LABELS[key]
    ?? key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[-_]/gu, ' ')
}

function readableStateValue(value: JsonValue): string {
  if (Array.isArray(value)) {
    const items = value.slice(0, 12).map((item) => {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return String(item)
      const entry = object(item)
      return text(entry?.['name']) ?? text(entry?.['title']) ?? text(entry?.['id'])
        ?? JSON.stringify(item)
    })
    return items.length === 0 ? '无' : items.join('、')
  }
  const entries = object(value)
  if (entries !== undefined) {
    const items = Object.entries(entries).slice(0, 12).flatMap(([name, amount]) => {
      if (amount === false || amount === null || amount === 0) return []
      if (amount === true) return [name]
      if (typeof amount === 'number' || typeof amount === 'string') return [`${name} × ${String(amount)}`]
      const nested = object(amount)
      return [text(nested?.['name']) ?? text(nested?.['title']) ?? `${name}：${JSON.stringify(amount)}`]
    })
    return items.length === 0 ? '无' : items.join('、')
  }
  if (value === null) return '无'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

function activeParticipationBand(value: JsonValue, field: JsonObject | undefined): JsonObject | undefined {
  const participation = object(field?.['participation'])
  const bands: JsonObject[] = Array.isArray(participation?.['bands'])
    ? participation['bands'].map(item => object(item))
      .filter((item): item is JsonObject => item !== undefined)
    : []
  return bands.find((band) => {
    if (band['equals'] !== undefined && JSON.stringify(band['equals']) !== JSON.stringify(value)) return false
    if (typeof value === 'number') {
      if (typeof band['min'] === 'number' && value < band['min']) return false
      if (typeof band['max'] === 'number' && value > band['max']) return false
    }
    return band['equals'] !== undefined || typeof band['min'] === 'number' || typeof band['max'] === 'number'
  })
}

function participatingStateValue(value: JsonValue, field: JsonObject | undefined): string {
  const rendered = readableStateValue(value)
  const band = activeParticipationBand(value, field)
  const label = text(band?.['label'])
  return label === undefined ? rendered : `${rendered} · ${label}`
}

/** Project live world simulation state into a compact, reader-facing environment strip. */
export function worldEnvironmentFacts(
  snapshot: Pick<RunSnapshot, 'state'>,
): readonly WorldEnvironmentFact[] {
  const state = snapshot.state
  const world = object(state['world'])
  const conflict = object(state['conflict'])
  const severity = numberAt(world, ['weather', 'severity'])
  const exposure = numberAt(world, ['hazards', 'exposureRisk'])
  const disaster = numberAt(world, ['disaster', 'stage'])
  const greyTide = numberAt(conflict, ['greyTide']) ?? numberAt(world, ['intel', 'greyTide'])
  const infected = numberAt(conflict, ['infectedCount'])
  const weather = severity === undefined ? undefined
    : severity <= 0 ? '晴朗'
      : severity <= 2 ? '天候转差'
        : severity <= 5 ? '风雨逼近' : '异常天象'
  const stage = disaster === undefined ? undefined
    : disaster <= 0 ? '日常'
      : disaster === 1 ? '预兆'
        : disaster === 2 ? '异变' : disaster <= 4 ? '警戒' : '灾变'
  const weatherLevel = (severity ?? 0) >= 3 ? 'danger' as const : 'normal' as const
  const disasterLevel = (disaster ?? 0) >= 3 ? 'danger' as const
    : disaster === 2 ? 'notice' as const : 'normal' as const
  const specialized: (WorldEnvironmentFact & { readonly path: string })[] = [
    ...(weather === undefined ? [] : [{
      path: 'weather.severity', label: '天气', value: weather, level: weatherLevel,
    } as const]),
    ...(stage === undefined ? [] : [{
      path: 'disaster.stage', label: '阶段', value: stage, level: disasterLevel,
    } as const]),
    ...(greyTide === undefined ? [] : [{
      path: 'intel.greyTide', label: '灰潮', value: String(greyTide), level: greyTide >= 6 ? 'danger' : greyTide >= 3 ? 'notice' : 'normal',
    } as const]),
    ...(infected === undefined || infected <= 0 ? [] : [{
      path: 'conflict.infectedCount', label: '灰骸', value: String(infected), level: infected >= 5 ? 'danger' : 'notice',
    } as const]),
    ...(exposure === undefined || exposure <= 0 ? [] : [{
      path: 'hazards.exposureRisk', label: '暴露', value: String(exposure), level: exposure >= 20 ? 'danger' : 'notice',
    } as const]),
  ]
  const schema = object(state['worldStateSchema'])
  const occupied = new Set(specialized.map(item => item.path))
  const generic = Object.entries(schema ?? {}).flatMap(([path, rawField]) => {
    if (['year', 'season', 'day', 'time'].includes(path)
      || path.startsWith('calendar.') || occupied.has(path)) return []
    const value = valueAt(world, path)
    if (value === undefined) return []
    const field = object(rawField)
    const band = activeParticipationBand(value, field)
    const tone = text(band?.['tone'])
    return [{
      label: readableStateLabel(path, field),
      value: participatingStateValue(value, field),
      level: tone === 'danger' ? 'danger' as const : tone === 'notice' ? 'notice' as const : 'normal' as const,
    }]
  })
  return [...specialized.map(({ path: _path, ...fact }) => fact), ...generic]
}

/** Convert one runtime snapshot to the world's configured game date and clock. */
export function gameCalendar(snapshot: Pick<RunSnapshot, 'logicalTime' | 'state'>): GameCalendar {
  const world = object(snapshot.state['world'])
  const configured = object(world?.['calendar'])
  const projected = projectClientCalendar(snapshot.state, snapshot.logicalTime)
  if (configured === undefined || projected === undefined) {
    return {
      configured: false,
      year: 0,
      season: '',
      day: 0,
      hour: 0,
      minute: 0,
      dateLabel: '历法未配置',
      timeLabel: '--:--',
      fullLabel: '历法与开场时间未配置',
    }
  }
  const authoredWeek = typeof configured['week'] === 'number'
    ? Math.max(1, Math.floor(configured['week'])) : undefined
  const authoredWeekday = text(configured['weekday'])
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const weekdayIndex = authoredWeekday === undefined ? -1 : weekdays.indexOf(authoredWeekday)
  const dateLabel = authoredWeek !== undefined && weekdayIndex >= 0
    ? (() => {
      const shifted = weekdayIndex + projected.elapsedDays
      const week = authoredWeek + Math.floor(shifted / weekdays.length)
      const weekday = weekdays[((shifted % weekdays.length) + weekdays.length) % weekdays.length]
      return `第 ${String(week)} 周 · ${weekday}`
    })()
    : `第 ${String(projected.year)} 年 · ${projected.season} ${String(projected.dayOfSeason)} 日`
  const timeLabel = `${String(projected.hour).padStart(2, '0')}:${String(projected.minute).padStart(2, '0')}`
  return {
    configured: true,
    year: projected.year,
    season: projected.season,
    day: projected.dayOfSeason,
    hour: projected.hour,
    minute: projected.minute,
    dateLabel,
    timeLabel,
    fullLabel: `${dateLabel} ${timeLabel}`,
  }
}

/** Present an in-world duration without runtime units. */
export function gameDuration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds))
  if (value < 60) return `${String(value)} 秒`
  if (value < 3_600) return `${String(Math.round(value / 60))} 分钟`
  if (value < 86_400) {
    const hours = Math.floor(value / 3_600)
    const minutes = Math.round(value % 3_600 / 60)
    return minutes === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(minutes)} 分钟`
  }
  return `${String(Math.round(value / 86_400))} 天`
}

/** Resolve an entity name from authored facets/state, never exposing a stable id by default. */
export function entityName(
  entities: JsonObject | undefined,
  entityId: EntityId | string | undefined,
  fallbackIndex = 0,
): string {
  if (entityId === undefined) return '未选择角色'
  const entity = object(entities?.[entityId])
  const facets = object(entity?.['facets'])
  const state = object(entity?.['state'])
  const sourcePath = text(facets?.['sourcePath'])
  const fromPath = sourcePath?.split(/[\\/]/u).at(-1)?.replace(/\.md$/iu, '').replace(/[-_]/gu, ' ')
  return text(facets?.['displayName'])
    ?? text(facets?.['name'])
    ?? text(facets?.['title'])
    ?? text(state?.['displayName'])
    ?? text(state?.['name'])
    ?? (fromPath !== undefined && !/^(protagonist|villagers?|character)$/iu.test(fromPath) ? fromPath : undefined)
    ?? `角色 ${String(fallbackIndex + 1).padStart(2, '0')}`
}

/** Resolve a map node name from the current spatial projection. */
export function placeName(spatial: RunSpatialView | undefined, nodeId: string | undefined): string {
  if (nodeId === undefined) return '未知地点'
  return spatial?.map?.nodes.find(node => node.id === nodeId)?.name ?? '旅途中'
}

/** Return the authored entity records from a runtime snapshot. */
export function snapshotEntities(snapshot: Pick<RunSnapshot, 'state'> | undefined): JsonObject | undefined {
  return object(snapshot?.state['entities'])
}

function entityId(value: string): EntityId {
  return value as EntityId
}

/** Return only actual people/actors, excluding canon, map, rule, and scenario projections. */
export function characterEntityIds(entities: JsonObject | undefined): EntityId[] {
  return Object.entries(entities ?? {}).flatMap(([id, value]) => {
    const entity = object(value)
    const facets = object(entity?.['facets'])
    const type = text(entity?.['type']) ?? text(facets?.['objectType']) ?? ''
    const sourcePath = text(facets?.['sourcePath'])?.replace(/\\/gu, '/') ?? ''
    return ['character', 'person', 'npc', 'actor'].includes(type.toLowerCase())
      || sourcePath.startsWith('characters/')
      ? [entityId(id)]
      : []
  })
}

/** Extract a short, readable set of state facts for a character card. */
export function characterFacts(entity: JsonObject | undefined): readonly { readonly label: string; readonly value: string }[] {
  const state = object(entity?.['state'])
  if (state === undefined) return []
  const facets = object(entity?.['facets'])
  const schema = object(facets?.['stateSchema'])
  const paths = schema === undefined ? Object.keys(state) : Object.keys(schema)
  return paths.flatMap((path) => {
    const value = valueAt(state, path)
    if (value === undefined) return []
    const field = object(schema?.[path])
    return [{ label: readableStateLabel(path, field), value: participatingStateValue(value, field) }]
  }).slice(0, 16)
}

export interface CharacterMemorySection {
  readonly label: string
  readonly entries: readonly string[]
}

/** Expose retained character memory by meaning instead of reducing it to an opaque count. */
export function characterMemorySections(entity: JsonObject | undefined): readonly CharacterMemorySection[] {
  const memory = object(entity?.['memory'])
  const labels: Readonly<Record<string, string>> = {
    episodic: '近期经历', beliefs: '认知与判断', goals: '当前目标', relationships: '人物关系',
    experience: '经验', skills: '技能', reflections: '反思',
  }
  return Object.entries(labels).flatMap(([key, label]) => {
    const values = memory?.[key]
    if (!Array.isArray(values)) return []
    const entries = values.slice(-6).flatMap((item) => {
      if (typeof item === 'string') return [item]
      const entry = object(item)
      const rendered = text(entry?.['summary']) ?? text(entry?.['content']) ?? text(entry?.['text'])
        ?? text(entry?.['belief']) ?? text(entry?.['goal']) ?? text(entry?.['name'])
      return rendered === undefined ? [] : [rendered]
    })
    return entries.length === 0 ? [] : [{ label, entries }]
  })
}

/** Expose the authored identity/personality fields for the selected character. */
export function characterProfileFacts(entity: JsonObject | undefined): readonly { readonly label: string; readonly value: string }[] {
  const facets = object(entity?.['facets'])
  const profile = object(facets?.['profile'])
  const fields: readonly (readonly [string, string])[] = [
    ['identity', '身份'], ['age', '年龄'], ['gender', '性别／形态'], ['pronouns', '称谓'],
    ['personality', '性格'], ['keywords', '关键词'],
  ]
  return fields.flatMap(([key, label]) => {
    const value = profile?.[key]
    return value === undefined ? [] : [{ label, value: readableStateValue(value) }]
  })
}
