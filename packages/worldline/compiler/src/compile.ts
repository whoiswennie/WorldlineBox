import { createHash } from 'node:crypto'
import type { ProjectSourceFile, ProjectSourceSnapshot } from '@deepseek-ai/dsh-worldline-project'
import {
  type ActionDefinition,
  type CanonLink,
  type CanonObject,
  type CanonObjectKind,
  type CertificateCategory,
  type CertificateResult,
  type CharacterMemory,
  type ClosureCertificate,
  type Effect,
  type EntityId,
  type Expression,
  type InvariantDefinition,
  type JsonObject,
  type JsonValue,
  type MapEdge,
  type MapLayer,
  type MapNode,
  type PlotPointDefinition,
  type Provenance,
  type RuntimeEntitySeed,
  type SimulationPurpose,
  type SourceAnchor,
  type SystemDefinition,
  type WorldMap,
  applyWorldlineEffects,
  contentFingerprint,
  evaluateScopedExpression,
  evaluateWorldlineInvariants,
  expressionPaths,
  inferCanonObjectKind,
  materializeInitialWorldState,
  readPath,
  stableStringify,
  validateWorldMap,
  worldlinePathScope,
  worldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import { load as parseYaml } from 'js-yaml'
import type {
  BuildDiagnostic,
  CompilerProposal,
  CreativeQuestion,
} from './types.ts'

/** Describes the compilation product value exchanged across the package boundary.
 */
export interface CompilationProduct {
  readonly snapshot: ProjectSourceSnapshot
  readonly purpose: SimulationPurpose
  readonly canon: readonly CanonObject[]
  readonly links: readonly CanonLink[]
  readonly maps: readonly WorldMap[]
  readonly entities: readonly RuntimeEntitySeed[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
  readonly plotPoints: readonly PlotPointDefinition[]
  readonly diagnostics: readonly BuildDiagnostic[]
  readonly questions: readonly CreativeQuestion[]
  readonly proposals: readonly CompilerProposal[]
  readonly certificate: ClosureCertificate
}

/** Structured runtime semantics kept outside human-readable Markdown sources. */
export interface RuntimeSemanticDocument {
  readonly facets?: JsonObject
  readonly maps?: readonly JsonObject[]
  readonly actions?: readonly JsonObject[]
  readonly systems?: readonly JsonObject[]
  readonly invariants?: readonly JsonObject[]
}

/** One current project runtime model stored in the Host-only control directory. */
export interface RuntimeSemanticModel {
  readonly documents: Readonly<Record<string, RuntimeSemanticDocument>>
}

const OBSOLETE_RUNTIME_FENCE_PATTERN = /```worldline-(?:action|map|system|invariant)\b/u

function markdownField(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^-\\s*${escaped}：\\s*(.+)$`, 'mu').exec(content)?.[1]?.trim() ?? ''
}

function plotPoint(file: ProjectSourceFile): PlotPointDefinition | undefined {
  if (!/^scenarios\/plot-points\/.*\.md$/u.test(file.path.replace(/\\/gu, '/'))) return undefined
  const name = /^#\s+(.+)$/mu.exec(file.content)?.[1]?.trim() ?? file.path
  const summary = file.content.replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/^#\s+.*$/mu, '').split(/^##\s+/mu)[0]?.trim() ?? ''
  const orderValue = Number(markdownField(file.content, '顺序'))
  const activateAt = Number(markdownField(file.content, '激活时刻（游戏秒）'))
  const deadlineAt = Number(markdownField(file.content, '截止时刻（游戏秒）'))
  const interventions = authoredValues(file.content, '时间干预').flatMap((value, index) => {
    const [rawAt, title, ...description] = value.split('|').map(item => item.trim())
    const at = Number(rawAt)
    if (!Number.isFinite(at) || title === undefined || title === '' || description.join('|') === '') return []
    return [{
      id: `plot-intervention:${contentFingerprint(`${file.id}:${String(index)}:${value}`)}`,
      at,
      title,
      description: description.join('|'),
    }]
  })
  return {
    id: `plot-point:${contentFingerprint(file.id)}`,
    name,
    summary,
    order: Number.isFinite(orderValue) && orderValue > 0 ? Math.floor(orderValue) : 1,
    entryCondition: markdownField(file.content, '进入条件'),
    completionCriteria: markdownField(file.content, '完成证据'),
    dramaticPressure: markdownField(file.content, '戏剧压力'),
    successOutcome: markdownField(file.content, '成功后果'),
    failureOutcome: markdownField(file.content, '失败后果'),
    recoveryHook: markdownField(file.content, '恢复钩子'),
    timing: {
      activateAt: Number.isFinite(activateAt) ? activateAt : Number.NaN,
      deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : Number.NaN,
      interventions,
    },
    provenance: [provenance(file)],
  }
}
const LINK_PATTERN = /\[\[((?:doc|document|entity):[a-zA-Z0-9._~-]{6,128})\]\]/gu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesSchemaType(value: unknown, type: unknown): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isRecord(value)
  return false
}

const STATE_PARTICIPATION_DRIVERS = new Set([
  'action', 'system', 'director', 'clock', 'movement',
])

function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function stateBandMatches(value: unknown, band: Record<string, unknown>): boolean {
  if ('equals' in band && band.equals !== value) return false
  if (typeof value === 'number') {
    if (typeof band.min === 'number' && value < band.min) return false
    if (typeof band.max === 'number' && value > band.max) return false
  }
  return 'equals' in band || typeof band.min === 'number' || typeof band.max === 'number'
}

function stateParticipationIssue(
  path: string,
  field: Record<string, unknown>,
  initialValue: unknown,
  scope: 'character' | 'world',
  actionActorPaths: ReadonlySet<string>,
  actionWorldPaths: ReadonlySet<string>,
  systemWorldPaths: ReadonlySet<string>,
): string | undefined {
  if (!nonEmptyText(field.label)) return '缺少面向作者与玩家的 label'
  if (path === 'locationId' && scope === 'character') return undefined
  const participation = isRecord(field.participation) ? field.participation : undefined
  if (participation === undefined) return '缺少 participation 语义契约'
  const drivers = Array.isArray(participation.drivers)
    ? participation.drivers.filter(item => typeof item === 'string')
    : []
  if (drivers.length === 0 || drivers.some(driver => !STATE_PARTICIPATION_DRIVERS.has(driver))) {
    return 'participation.drivers 必须显式声明 action/system/director/clock/movement'
  }
  for (const key of ['meaning', 'narrative', 'choices'] as const) {
    if (!nonEmptyText(participation[key])) return `participation.${key} 不能为空`
  }
  if (field.mutable === true && !drivers.includes('director')) {
    return 'mutable=true 表示状态导演可修改，因此 drivers 必须包含 director'
  }
  if (field.mutable === false && drivers.includes('director')) {
    return 'drivers 包含 director 时 mutable 必须为 true'
  }
  if (drivers.includes('clock') && (scope !== 'world' || !['year', 'season', 'day', 'time'].includes(path))) {
    return 'clock 只能驱动 world.year/season/day/time'
  }
  if (drivers.includes('movement') && (scope !== 'character' || path !== 'locationId')) {
    return 'movement 只能驱动角色 locationId'
  }
  if (drivers.includes('action')) {
    const covered = scope === 'character' ? actionActorPaths.has(path) : actionWorldPaths.has(path)
    if (!covered) return '声明由 action 驱动，但没有任何动作读取或改变该字段'
  }
  if (drivers.includes('system') && (scope !== 'world' || !systemWorldPaths.has(path))) {
    return '声明由 system 驱动，但没有任何周期系统读取或改变该字段'
  }
  const bands = Array.isArray(participation.bands) ? participation.bands.filter(isRecord) : []
  if (field.type === 'number' && !drivers.includes('clock')) {
    if (bands.length < 2) return '数值字段至少需要两个 participation.bands 阈值区间'
    if (!bands.some(band => stateBandMatches(initialValue, band))) return '初始值没有命中任何 participation.bands'
  }
  for (const band of bands) {
    if (!nonEmptyText(band.label) || !nonEmptyText(band.narrative)
      || !nonEmptyText(band.choices) || !stateBandMatches(initialValue, band)
        && !('equals' in band || typeof band.min === 'number' || typeof band.max === 'number')) {
      return '每个 band 必须包含 label/narrative/choices，并用 equals 或 min/max 声明命中条件'
    }
  }
  return undefined
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function jsonObject(value: unknown): JsonObject {
  return isRecord(value) ? value as JsonObject : {}
}

function mergeFacetObjects(left: JsonObject, right: JsonObject): JsonObject {
  const result: JsonObject = structuredClone(left)
  for (const [key, value] of Object.entries(right)) {
    const current = result[key]
    result[key] = isRecord(current) && isRecord(value)
      ? mergeFacetObjects(current, value)
      : structuredClone(value)
  }
  return result
}

function expressionArray(value: unknown): readonly Expression[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as readonly Expression[] : []
}

function effectArray(value: unknown): readonly Effect[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as readonly Effect[] : []
}

function sourceAnchor(file: ProjectSourceFile, start = 0, end = file.content.length): SourceAnchor {
  return {
    id: worldlineId<'source-anchor'>(`source-anchor:${contentFingerprint(`${file.id}:${start}:${end}`)}`),
    documentId: file.id,
    revision: file.revision,
    startOffset: start,
    endOffset: end,
    excerptHash: contentFingerprint(file.content.slice(start, end)),
    contextBefore: file.content.slice(Math.max(0, start - 80), start),
    contextAfter: file.content.slice(end, end + 80),
  }
}

function provenance(file: ProjectSourceFile, start?: number, end?: number): Provenance {
  return { kind: 'author', anchors: [sourceAnchor(file, start, end)] }
}

function titleOf(file: ProjectSourceFile): string {
  return /^#\s+(.+)$/mu.exec(file.content)?.[1]?.trim()
    ?? file.path.split('/').at(-1)?.replace(/\.[^.]+$/u, '')
    ?? file.path
}

function kindOf(file: ProjectSourceFile): { readonly kind: CanonObjectKind; readonly customKind?: string } {
  return inferCanonObjectKind(file.path, file.objectKind)
}

function cleanAuthoredValue(value: string): string {
  return value.trim()
    .replace(/^`([\s\S]+)`$/u, '$1')
    .replace(/^\*\*([\s\S]+)\*\*$/u, '$1')
    .trim()
}

function authoredValues(content: string, label: string): readonly string[] {
  const lines = content.replace(/\r\n/gu, '\n').split('\n')
  const pattern = new RegExp(`^(\\s*)[-*]\\s*${label}\\s*[：:]\\s*(.*)$`, 'u')
  const values: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index] ?? '')
    if (match === null) continue
    const baseIndent = match[1]?.length ?? 0
    const inline = cleanAuthoredValue(match[2] ?? '')
    if (inline !== '') values.push(inline)
    let cursor = index + 1
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? ''
      if (line.trim() === '') continue
      const item = /^(\s*)[-*]\s+(.+)$/u.exec(line)
      if (item === null || (item[1]?.length ?? 0) <= baseIndent) break
      const value = cleanAuthoredValue(item[2] ?? '')
      if (value !== '') values.push(value)
    }
    index = cursor - 1
  }
  return values.filter(value => value !== '待补充'
    && !/^[—–-](?:\s*[（(][^）)]*[）)])?$/u.test(value))
}

function authoredField(content: string, label: string): string | undefined {
  return authoredValues(content, label)[0]
}

function authoredSection(content: string, label: string): string | undefined {
  const normalized = content.replace(/\r\n/gu, '\n')
  const heading = new RegExp(`^##\\s+${label}\\s*$`, 'mu').exec(normalized)
  if (heading === null) return undefined
  const start = heading.index + heading[0].length
  const next = /^##\s+/mu.exec(normalized.slice(start))
  const body = normalized.slice(start, next === null ? undefined : start + next.index).trim()
  return body === '' ? undefined : body
}

function sectionSummary(content: string, label: string): string | undefined {
  const section = authoredSection(content, label)
  if (section === undefined) return undefined
  const paragraph = section.split(/\n\s*\n/gu)[0]?.replace(/^[-*]\s+/gmu, '').trim()
  return paragraph === '' ? undefined : paragraph
}

function characterAssetPath(file: ProjectSourceFile, value: string): string {
  const cleaned = value.replace(/^\.\//u, '')
  if (/^(?:https?:|data:|assets\/)/u.test(cleaned)) return cleaned
  if (!/^(?:visual|audio|knowledge)\//u.test(cleaned)) return cleaned
  const slug = file.path.replace(/\\/gu, '/').split('/').at(-1)?.replace(/\.[^.]+$/u, '') ?? 'character'
  return `assets/files/characters/${slug}/${cleaned}`
}

function sectionResourcePaths(file: ProjectSourceFile): readonly string[] {
  const section = authoredSection(file.content, '(?:角色)?资源')
  if (section === undefined) return []
  const matches = section.match(/(?:assets\/)?[-a-z0-9._/]+\.(?:avif|gif|jpe?g|png|svg|webp|flac|m4a|mp3|ogg|wav|md|pdf|txt)/giu) ?? []
  return [...new Set(matches.map(value => characterAssetPath(file, value)))]
}

function authoredYamlObject(content: string, name: string): JsonObject | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const source = new RegExp('```' + escaped + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```', 'u')
    .exec(content)?.[1]
  if (source === undefined) return undefined
  const parsed = parseYaml(source)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${name} must contain a YAML object`)
  }
  return parsed as JsonObject
}

/** Read the native editor's human Markdown without requiring JSON inside author documents. */
function nativeMarkdownFacets(file: ProjectSourceFile): Readonly<Record<string, JsonValue>> {
  const initialWorldState = authoredYamlObject(file.content, 'worldline-initial-world-state')
  const worldStateSchema = authoredYamlObject(file.content, 'worldline-world-state-schema')
  const worldFacets = {
    ...(initialWorldState === undefined ? {} : { initialWorldState }),
    ...(worldStateSchema === undefined ? {} : { worldStateSchema }),
  }
  if (!file.path.replace(/\\/gu, '/').startsWith('characters/')) return worldFacets
  const name = titleOf(file)
  const age = authoredField(file.content, '年龄')
  const gender = authoredField(file.content, '性别(?:／形态|/形态)?')
  const pronouns = authoredField(file.content, '(?:称谓(?:／代词|/代词)?|代词)')
  const identity = authoredField(file.content, '身份(?:／职业|/职业)?')
    ?? sectionSummary(file.content, '身份')
  const personality = authoredField(file.content, '性格') ?? sectionSummary(file.content, '性格')
  const keywords = authoredField(file.content, '关键词')
  const goal = authoredField(file.content, '目标') ?? sectionSummary(file.content, '目标')
  const discovered = sectionResourcePaths(file)
  const images = discovered.filter(value => /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu.test(value))
  const audioFiles = discovered.filter(value => /\.(?:flac|m4a|mp3|ogg|wav)$/iu.test(value))
  const knowledgeFiles = discovered.filter(value => /\.(?:md|pdf|txt)$/iu.test(value))
  const portraitValue = authoredField(file.content, '头像')
    ?? images.find(value => /(?:avatar|portrait|头像|立绘)/iu.test(value))
    ?? images[0]
  const portrait = portraitValue === undefined ? undefined : characterAssetPath(file, portraitValue)
  const expressionValue = authoredField(file.content, '默认立绘') ?? portrait
  const expression = expressionValue === undefined ? undefined : characterAssetPath(file, expressionValue)
  const authoredGallery = authoredValues(file.content, '形象画廊').flatMap(value => value.split(/[；;]/gu))
    .map(item => item.trim()).filter(Boolean)
  const gallery = (authoredGallery.length === 0 ? images.filter(value => value !== portrait) : authoredGallery)
    .map(value => characterAssetPath(file, value))
  const voice = authoredField(file.content, '语音')
    ?? audioFiles.find(value => /(?:voice|speech|语音)/iu.test(value))
  const theme = authoredField(file.content, '角色曲')
    ?? audioFiles.find(value => /(?:bgm|music|theme|角色曲)/iu.test(value))
  const knowledge = authoredField(file.content, '知识(?:资料|库)?')
    ?.split(/[；;、]/gu).map(item => item.trim()).filter(Boolean) ?? knowledgeFiles
  const profile = {
    ...(age === undefined ? {} : { age }),
    ...(gender === undefined ? {} : { gender }),
    ...(pronouns === undefined ? {} : { pronouns }),
    ...(identity === undefined ? {} : { identity }),
    ...(personality === undefined ? {} : { personality }),
    ...(keywords === undefined ? {} : {
      keywords: keywords.split(/[，,、]/gu).map(item => item.trim()).filter(Boolean),
    }),
  }
  const visual = {
    ...(portrait === undefined ? {} : { portrait }),
    ...(expression === undefined ? {} : { expression }),
    ...(gallery.length === 0 ? {} : { gallery }),
  }
  const audio = { ...(voice === undefined ? {} : { voice }), ...(theme === undefined ? {} : { theme }) }
  const stateSchema = authoredYamlObject(file.content, 'worldline-state-schema')
  const initialState = authoredYamlObject(file.content, 'worldline-initial-state')
  const memory = authoredYamlObject(file.content, 'worldline-memory')
  return {
    ...worldFacets,
    displayName: name,
    ...(Object.keys(profile).length === 0 ? {} : { profile }),
    ...((Object.keys(visual).length === 0
      && Object.keys(audio).length === 0
      && knowledge.length === 0)
      ? {}
      : { resources: { visual, audio, knowledge } }),
    ...(memory === undefined
      ? goal === undefined ? {} : { memory: { goals: [goal] } }
      : { memory: goal === undefined || Array.isArray(memory.goals)
        ? memory
        : { ...memory, goals: [goal] } }),
    ...(stateSchema === undefined ? {} : { stateSchema }),
    ...(initialState === undefined ? {} : { initialState }),
  }
}

function isUntouchedCharacterTemplate(file: ProjectSourceFile): boolean {
  if (!file.path.replace(/\\/gu, '/').startsWith('characters/')) return false
  return file.content.replace(/\r\n/gu, '\n').trim()
    === '# 主角\n\n写明身份、外观、性格、价值观、目标、能力、资源、关系、经历与初始位置。'
}

function facetsOf(file: ProjectSourceFile, runtime?: RuntimeSemanticDocument): Readonly<Record<string, JsonValue>> {
  const native = nativeMarkdownFacets(file)
  return {
    sourcePath: file.path,
    ...mergeFacetObjects(jsonObject(runtime?.facets), native),
  }
}

function entityIdOf(file: ProjectSourceFile): EntityId {
  return worldlineId<'entity'>(`entity:${contentFingerprint(file.id)}`)
}

function memoryBase(actorId: EntityId, category: string, index: number) {
  return {
    id: worldlineId<'memory'>(`memory:${contentFingerprint(`${actorId}:${category}:${String(index)}`)}`),
    actorId,
    logicalTime: 0,
    sourceEventIds: [],
    importance: 0.7,
  }
}

/** Normalize concise author facets into the runtime's structured memory authority. */
function authoredMemory(object: CanonObject): CharacterMemory {
  const source = isRecord(object.facets.memory) ? object.facets.memory : {}
  const episodicSource = Array.isArray(source.episodic) ? source.episodic : []
  const beliefSource = Array.isArray(source.beliefs)
    ? source.beliefs.map((value, index) => [String(index), value] as const)
    : isRecord(source.beliefs) ? Object.entries(source.beliefs) : []
  const goalSource = Array.isArray(source.goals) ? source.goals : []
  const relationshipSource = Array.isArray(source.relationships)
    ? source.relationships.map((value, index) => [String(index), value] as const)
    : isRecord(source.relationships) ? Object.entries(source.relationships) : []
  const experienceSource = Array.isArray(source.experience) ? source.experience : []
  const skillSource = Array.isArray(source.skills) ? source.skills : []
  const reflectionSource = Array.isArray(source.reflections) ? source.reflections : []
  return {
    episodic: episodicSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      const participants = Array.isArray(detail.participants)
        ? detail.participants.filter((item): item is string => typeof item === 'string')
        : [object.id]
      return {
        ...memoryBase(object.id, 'episodic', index),
        summary: typeof value === 'string' ? value : stringValue(detail.summary, `经历 ${String(index + 1)}`),
        participants: participants.map(item => worldlineId<'entity'>(item)),
        ...(typeof detail.placeId === 'string'
          ? { placeId: worldlineId<'map-node'>(detail.placeId) }
          : {}),
      }
    }),
    beliefs: beliefSource.map(([subject, value], index) => {
      const detail = isRecord(value) ? value : undefined
      return {
        ...memoryBase(object.id, 'belief', index),
        subject: detail === undefined ? subject : stringValue(detail.subject, subject),
        value: detail?.value ?? value,
        confidence: Math.min(1, Math.max(0, numberValue(detail?.confidence, 1))),
        contradictedBy: [],
      }
    }),
    goals: goalSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      const status = detail.status === 'met' || detail.status === 'failed' || detail.status === 'abandoned'
        ? detail.status
        : 'active'
      return {
        ...memoryBase(object.id, 'goal', index),
        goal: typeof value === 'string' ? value : stringValue(detail.goal, `目标 ${String(index + 1)}`),
        status,
        ...(typeof detail.deadline === 'number' ? { deadline: detail.deadline } : {}),
        ...(typeof detail.promisedTo === 'string'
          ? { promisedTo: worldlineId<'entity'>(detail.promisedTo) }
          : {}),
      }
    }),
    relationships: relationshipSource.map(([other, value], index) => {
      const detail = isRecord(value) ? value : {}
      const dimensions = isRecord(detail.dimensions)
        ? Object.fromEntries(Object.entries(detail.dimensions)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
        : typeof value === 'number' ? { affinity: value } : {}
      return {
        ...memoryBase(object.id, 'relationship', index),
        otherId: worldlineId<'entity'>(stringValue(detail.otherId, other)),
        dimensions,
      }
    }),
    experience: experienceSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      const outcome = detail.outcome === 'failed' || detail.outcome === 'cancelled'
        ? detail.outcome
        : 'completed'
      return {
        ...memoryBase(object.id, 'experience', index),
        actionType: typeof value === 'string' ? value : stringValue(detail.actionType, 'authored.experience'),
        outcome,
        conditions: jsonObject(detail.conditions),
      }
    }),
    skills: skillSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      return {
        ...memoryBase(object.id, 'skill', index),
        skill: typeof value === 'string' ? value : stringValue(detail.skill, `技能 ${String(index + 1)}`),
        level: numberValue(detail.level, 1),
        evidence: [],
      }
    }),
    reflections: reflectionSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      return {
        ...memoryBase(object.id, 'reflection', index),
        text: typeof value === 'string' ? value : stringValue(detail.text, `反思 ${String(index + 1)}`),
      }
    }),
  }
}

function canonObject(file: ProjectSourceFile, snapshot: ProjectSourceSnapshot, runtime?: RuntimeSemanticDocument): CanonObject {
  const kind = kindOf(file)
  return {
    id: entityIdOf(file),
    ...kind,
    documentId: file.id,
    title: titleOf(file),
    aliases: [],
    tags: file.tags,
    status: 'canon',
    worldIds: [snapshot.manifest.defaultWorldId],
    worldlineIds: [snapshot.manifest.defaultWorldlineId],
    facets: facetsOf(file, runtime),
    provenance: [provenance(file)],
  }
}

function parseAction(value: Record<string, unknown>, source: Provenance): ActionDefinition {
  let location: ActionDefinition['location']
  if (isRecord(value.location) && value.location.mode === 'anywhere') {
    location = { mode: 'anywhere' }
  } else if (isRecord(value.location) && value.location.mode === 'at'
    && Array.isArray(value.location.nodeIds)) {
    location = {
      mode: 'at',
      nodeIds: value.location.nodeIds.filter(item => typeof item === 'string')
        .map(item => worldlineId<'map-node'>(item)),
    }
  }
  return {
    id: stringValue(value.id, `action.${contentFingerprint(value)}`),
    description: stringValue(value.description, 'Author-defined action'),
    ...(value.operator === 'move' || value.operator === 'teleport' || value.operator === 'generic'
      ? { operator: value.operator }
      : {}),
    ...(location === undefined ? {} : { location }),
    actorTypes: Array.isArray(value.actorTypes) ? value.actorTypes.filter(item => typeof item === 'string') : ['character'],
    preconditions: expressionArray(value.preconditions),
    claims: Array.isArray(value.claims) ? value.claims.filter(isRecord).map(claim => ({
      resource: stringValue(claim.resource, 'world'),
      quantity: Math.max(0, numberValue(claim.quantity, 1)),
      mode: claim.mode === 'shared' || claim.mode === 'capacity' ? claim.mode : 'exclusive',
      duration: Math.max(0, numberValue(claim.duration, 0)),
    })) : [],
    duration: Math.max(0, numberValue(value.duration, 0)),
    effects: effectArray(value.effects),
    interruptible: value.interruptible !== false,
    maxWait: Math.max(0, numberValue(value.maxWait, 3_600)),
    maxRetries: Math.max(0, Math.floor(numberValue(value.maxRetries, 3))),
    fallbacks: Array.isArray(value.fallbacks) ? value.fallbacks.filter(item => typeof item === 'string') : [],
    provenance: [source],
  }
}

function parseSystem(value: Record<string, unknown>, source: Provenance): SystemDefinition {
  const interval = numberValue(value.interval, 0)
  return {
    id: stringValue(value.id, `system.${contentFingerprint(value)}`),
    description: stringValue(value.description, 'Author-defined world system'),
    nextWake: Math.max(0, numberValue(value.nextWake, interval)),
    ...(interval > 0 ? { interval } : {}),
    preconditions: expressionArray(value.preconditions),
    effects: effectArray(value.effects),
    provenance: [source],
  }
}

function parseInvariant(value: Record<string, unknown>, source: Provenance): InvariantDefinition {
  const expression = isRecord(value.expression)
    ? value.expression as unknown as Expression
    : { op: 'exists' as const, path: '$' }
  return {
    id: stringValue(value.id, `invariant.${contentFingerprint(value)}`),
    description: stringValue(value.description, 'Author-defined safety invariant'),
    expression,
    provenance: [source],
  }
}

function parseMap(value: Record<string, unknown>, source: Provenance): WorldMap {
  const nodes = Array.isArray(value.nodes) ? value.nodes.filter(isRecord) as unknown as MapNode[] : []
  const layers = Array.isArray(value.layers) ? value.layers.filter(isRecord) as unknown as MapLayer[] : []
  const edges = Array.isArray(value.edges) ? value.edges.filter(isRecord) as unknown as MapEdge[] : []
  const root = stringValue(value.rootNodeId, String(nodes[0]?.id ?? 'map-node:missing'))
  return {
    id: worldlineId<'map'>(stringValue(value.id, `map:${contentFingerprint(value)}`)),
    version: 1,
    name: stringValue(value.name, '世界地图'),
    rootNodeId: worldlineId<'map-node'>(root),
    layers,
    nodes,
    edges,
    provenance: [source],
  }
}

function nativeLocationMap(files: readonly ProjectSourceFile[]): WorldMap | undefined {
  const locations = files.filter(file => file.path.replace(/\\/gu, '/').startsWith('maps/places/'))
  if (locations.length === 0) return undefined
  const nodes = locations.flatMap((file): MapNode[] => {
    const id = authoredField(file.content, '地点 ID')
    if (id === undefined) return []
    const rawKind = (authoredField(file.content, '地点类型') ?? 'region').toLowerCase()
    const kind = rawKind.includes('world') || rawKind.includes('世界') ? 'world'
      : rawKind.includes('plane') || rawKind.includes('位面') ? 'plane'
        : rawKind.includes('city') || rawKind.includes('城市') ? 'city'
          : rawKind.includes('building') || rawKind.includes('建筑') ? 'building'
            : rawKind.includes('room') || rawKind.includes('房间') || rawKind.includes('教室') ? 'room'
              : rawKind.includes('slot') || rawKind.includes('槽位') ? 'slot'
                : 'region'
    const coordinates = (authoredField(file.content, '地图坐标') ?? '0,0').match(/-?\d+(?:\.\d+)?/gu) ?? []
    const [rawX, rawY] = coordinates.map(Number)
    const parentId = authoredField(file.content, '上级地点')
    const capacityText = authoredField(file.content, '容纳人数')
    const capacity = Number(capacityText?.match(/\d+(?:\.\d+)?/u)?.[0])
    const background = authoredField(file.content, '场景背景')
    const description = file.content.replace(/<!--[^]*?-->/gu, '')
      .replace(/^#\s+.*$/mu, '').split(/^##\s+/mu)[0]?.trim() ?? ''
    return [{
      id: worldlineId<'map-node'>(id),
      layerId: 'ground',
      kind,
      name: titleOf(file),
      ...(description === '' ? {} : { description }),
      ...(background === undefined ? {} : { background }),
      position: { x: Number.isFinite(rawX) ? rawX ?? 0 : 0, y: Number.isFinite(rawY) ? rawY ?? 0 : 0 },
      ...(parentId === undefined || parentId === '—' ? {} : { parentId: worldlineId<'map-node'>(parentId) }),
      ...(Number.isFinite(capacity) && capacity >= 0 ? { capacity } : {}),
      permissions: [],
      hazards: [],
      entryNodeIds: [],
    }]
  })
  if (nodes.length === 0) return undefined
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges: MapEdge[] = []
  const edgeKeys = new Set<string>()
  for (const file of locations) {
    const from = authoredField(file.content, '地点 ID')
    if (from === undefined || !nodeIds.has(worldlineId<'map-node'>(from))) continue
    const connections = authoredValues(file.content, '相邻地点').flatMap(value => value.split(/[；;]/gu))
    for (const connection of connections) {
      const [target, rawDuration] = connection.split('|').map(item => item.trim())
      if (target === undefined || target === '' || !nodeIds.has(worldlineId<'map-node'>(target))) continue
      const key = [from, target].sort().join('|')
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      const duration = Number(rawDuration)
      edges.push({
        id: worldlineId<'map-edge'>(`map-edge:${contentFingerprint(key)}`),
        from: worldlineId<'map-node'>(from),
        to: worldlineId<'map-node'>(target),
        bidirectional: true,
        distance: 1,
        baseDuration: Number.isFinite(duration) && duration > 0 ? duration : 10,
        modes: ['walk'],
        permissions: [],
        hazards: [],
      })
    }
  }
  const root = nodes.find(node => node.kind === 'world') ?? nodes.find(node => node.parentId === undefined) ?? nodes[0]
  if (root === undefined) return undefined
  return {
    id: worldlineId<'map'>('map:native-world'),
    version: 1,
    name: '世界地图',
    rootNodeId: root.id,
    layers: [{ id: 'ground', name: '世界', visible: true, locked: false, order: 0 }],
    nodes,
    edges,
    provenance: locations.map(file => provenance(file)),
  }
}

function mergeNativeLocationMetadata(
  maps: readonly WorldMap[],
  authoredMap: WorldMap | undefined,
): readonly WorldMap[] {
  if (authoredMap === undefined) return maps
  if (maps.length === 0) return [authoredMap]
  const authoredNodes = new Map(authoredMap.nodes.map(node => [node.id, node]))
  return maps.map(map => ({
    ...map,
    nodes: map.nodes.map((node) => {
      const authored = authoredNodes.get(node.id)
      if (authored === undefined) return node
      return {
        ...node,
        name: authored.name,
        ...(authored.description === undefined ? {} : { description: authored.description }),
        kind: authored.kind,
        position: authored.position,
        ...(authored.parentId === undefined ? {} : { parentId: authored.parentId }),
        ...(authored.background === undefined ? {} : { background: authored.background }),
        ...(authored.capacity === undefined ? {} : { capacity: authored.capacity }),
      }
    }),
    provenance: [...map.provenance, ...authoredMap.provenance],
  }))
}

function defaultPurpose(snapshot: ProjectSourceSnapshot): SimulationPurpose {
  const runtimeTemplate = snapshot.manifest.template === 'social-simulation'
    || snapshot.manifest.template === 'civilization-sandbox'
    || snapshot.manifest.template === 'playable-scenario'
  return {
    summary: runtimeTemplate ? '验证这个项目能否作为自治世界持续运行。' : '编译具有完整来源覆盖的世界资料。',
    scope: runtimeTemplate ? ['world', 'characters', 'space', 'actions'] : ['world-reference'],
    duration: runtimeTemplate ? 86_400 : 0,
    resolution: 60,
    detail: runtimeTemplate ? 'L2' : 'L0',
    hardExpectations: [],
    statisticalExpectations: [],
    antiPatterns: ['无来源语义', '普通移动瞬间完成', '无限重试'],
  }
}

function question(id: string, prompt: string, rationale: string, impact: CreativeQuestion['impact']): CreativeQuestion {
  return { id: `question:${contentFingerprint(id)}`, prompt, rationale, impact, status: 'open', sourcePaths: [] }
}

function mergeQuestions(generated: CreativeQuestion[], previous: readonly CreativeQuestion[]): CreativeQuestion[] {
  const states = new Map(previous.map(item => [item.id, item]))
  return generated.map(item => states.get(item.id) ?? item)
}

function result(
  category: CertificateCategory,
  status: CertificateResult['status'],
  summary: string,
  evidence: readonly string[],
): CertificateResult {
  return { category, status, summary, evidence }
}

interface CertificateInput {
  readonly digest: string
  readonly runtimeRequested: boolean
  readonly canon: readonly CanonObject[]
  readonly maps: readonly WorldMap[]
  readonly entities: readonly RuntimeEntitySeed[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
  readonly diagnostics: readonly BuildDiagnostic[]
  readonly purpose: SimulationPurpose
  readonly audit: ExecutabilityAudit
}

interface UnreachableExecutable {
  readonly id: string
  readonly reason: string
}

interface ExecutabilityAudit {
  readonly reachableActions: readonly string[]
  readonly unreachableActions: readonly UnreachableExecutable[]
  readonly progressingSystems: readonly string[]
  readonly stalledSystems: readonly UnreachableExecutable[]
  readonly initialInvariantFailures: readonly string[]
  readonly committedSteps: number
  readonly mapReachable: boolean
}

function mapHasReachableDestination(maps: readonly WorldMap[], origin: string): boolean {
  const edges = maps.flatMap(map => map.edges)
  const visited = new Set([origin])
  const queue = [origin]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const edge of edges) {
      const next = edge.from === current
        ? edge.to
        : edge.bidirectional && edge.to === current ? edge.from : undefined
      if (next === undefined || edge.baseDuration <= 0 || visited.has(next)) continue
      return true
    }
  }
  return false
}

function executableScopeCandidates(
  action: ActionDefinition,
  entities: readonly RuntimeEntitySeed[],
): readonly { readonly actorId: EntityId; readonly targetId?: EntityId }[] {
  const needsTarget = [
    ...action.preconditions.flatMap(expressionPaths),
    ...action.effects.flatMap(effect => 'path' in effect ? [effect.path] : []),
  ].some(path => worldlinePathScope(path) === 'target')
  return entities.filter(entity => action.actorTypes.includes(entity.type)).flatMap((actor) => {
    if (!needsTarget) return [{ actorId: actor.id }]
    return entities.filter(target => target.id !== actor.id)
      .map(target => ({ actorId: actor.id, targetId: target.id }))
  })
}

/**
 * Bounded deterministic reachability proof used by the freeze certificate.
 *
 * Executables are not all expected to be legal in the initial world. A script
 * commonly makes a later action legal by committing an earlier action first.
 * Keep one witness state for every newly proven executable so later actions and
 * systems can build on those effects without exploring an unbounded state tree.
 */
function auditExecutability(input: {
  readonly canon: readonly CanonObject[]
  readonly entities: readonly RuntimeEntitySeed[]
  readonly maps: readonly WorldMap[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
}): ExecutabilityAudit {
  const initial = materializeInitialWorldState(input.canon, input.entities)
  const initialInvariantFailures = evaluateWorldlineInvariants(
    input.invariants,
    input.entities,
    initial,
  ).map(item => `${item.invariantId}${item.actorId === undefined ? '' : `@${item.actorId}`}: ${item.reason}`)
  const reachableActions: string[] = []
  const reachableActionIds = new Set<string>()
  const progressingSystems: string[] = []
  const progressingSystemIds = new Set<string>()
  const actionFailures = new Map<string, string>()
  const systemFailures = new Map<string, string>()
  const witnessStates: JsonObject[] = [initial]
  let mapReachable = !input.actions.some(action => action.operator === 'move')

  const tryAction = (action: ActionDefinition): boolean => {
    const candidates = executableScopeCandidates(action, input.entities)
    let failure = candidates.length === 0
      ? '没有匹配 actorTypes 的运行角色'
      : '有界前向状态仍不满足前置条件'
    for (const state of witnessStates.toReversed()) {
      for (const scope of candidates) {
        if (!action.preconditions.every(expression => evaluateScopedExpression(expression, state, scope))) continue
        if (action.operator === 'move') {
          const origin = readPath(state, `entities.${scope.actorId}.state.locationId`)
          if (typeof origin !== 'string' || !mapHasReachableDestination(input.maps, origin)) {
            failure = '可达角色状态没有正耗时的移动路径'
            continue
          }
          mapReachable = true
        }
        try {
          const applied = applyWorldlineEffects(state, action.effects, scope)
          const invariantFailures = evaluateWorldlineInvariants(
            input.invariants,
            input.entities,
            applied.state,
          )
          if (invariantFailures.length > 0) {
            failure = `动作效果违反不变量 ${invariantFailures.map(item => item.invariantId).join('、')}`
            continue
          }
          witnessStates.push(applied.state)
          reachableActionIds.add(action.id)
          reachableActions.push(action.id)
          actionFailures.delete(action.id)
          return true
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
      }
    }
    actionFailures.set(action.id, failure)
    return false
  }

  const trySystem = (system: SystemDefinition): boolean => {
    const scopedPaths = [
      ...system.preconditions.flatMap(expressionPaths),
      ...system.effects.flatMap(effect => 'path' in effect ? [effect.path] : []),
    ].filter(path => worldlinePathScope(path) !== 'world')
    if (scopedPaths.length > 0) {
      systemFailures.set(system.id, '周期系统不能使用 actor/target 作用域')
      return false
    }
    let failure = '有界前向状态仍不满足系统前置条件'
    for (const state of witnessStates.toReversed()) {
      if (!system.preconditions.every(expression => evaluateScopedExpression(expression, state, {}))) {
        continue
      }
      try {
        const applied = applyWorldlineEffects(state, system.effects, {})
        const failures = evaluateWorldlineInvariants(input.invariants, input.entities, applied.state)
        if (failures.length > 0) {
          failure = `系统效果违反不变量 ${failures.map(item => item.invariantId).join('、')}`
          continue
        }
        if (applied.deltas.length === 0 && applied.cognitionChanges.length === 0) {
          failure = '系统唤醒后没有产生状态、事实或认知变化'
          continue
        }
        witnessStates.push(applied.state)
        progressingSystemIds.add(system.id)
        progressingSystems.push(system.id)
        systemFailures.delete(system.id)
        return true
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    systemFailures.set(system.id, failure)
    return false
  }

  const maxRounds = Math.max(1, input.actions.length + input.systems.length)
  for (let round = 0; round < maxRounds; round += 1) {
    let progressed = false
    for (const action of input.actions) {
      if (reachableActionIds.has(action.id)) continue
      progressed = tryAction(action) || progressed
    }
    for (const system of input.systems) {
      if (progressingSystemIds.has(system.id)) continue
      progressed = trySystem(system) || progressed
    }
    if (!progressed) break
  }

  const unreachableActions = input.actions
    .filter(action => !reachableActionIds.has(action.id))
    .map(action => ({
      id: action.id,
      reason: actionFailures.get(action.id) ?? '有界前向状态无法到达该动作',
    }))
  const stalledSystems = input.systems
    .filter(system => !progressingSystemIds.has(system.id))
    .map(system => ({
      id: system.id,
      reason: systemFailures.get(system.id) ?? '有界前向状态无法唤醒该系统',
    }))

  return {
    reachableActions,
    unreachableActions,
    progressingSystems,
    stalledSystems,
    initialInvariantFailures,
    committedSteps: reachableActions.length + progressingSystems.length,
    mapReachable,
  }
}

function makeCertificate(input: CertificateInput): ClosureCertificate {
  const provenanceNodes = [...input.maps, ...input.actions, ...input.systems, ...input.invariants]
  const noOrphans = provenanceNodes.every(node => node.provenance.length > 0)
    && !input.diagnostics.some(item => item.severity === 'blocking')
  const allProvenance = [
    ...input.canon.flatMap(item => item.provenance),
    ...provenanceNodes.flatMap(item => item.provenance),
  ]
  const coverage = (kind: Provenance['kind']): number => allProvenance.length === 0
    ? 0
    : allProvenance.filter(item => item.kind === kind).length / allProvenance.length
  const mapErrors = input.maps.flatMap(map => validateWorldMap(map))
  const results: CertificateResult[] = [
    result('state', input.canon.length > 0 ? 'pass' : 'blocking', '正典状态可以完整实例化。', [`${input.canon.length} 个正典对象`]),
    result('time', !input.runtimeRequested || input.purpose.duration > 0 ? 'pass' : 'blocking', '演算时间范围有限且明确。', [`持续时间=${String(input.purpose.duration)}`]),
    result('space', !input.runtimeRequested || (input.maps.length > 0 && mapErrors.length === 0) ? 'pass' : 'blocking', '运行地图拓扑连通且有效。', mapErrors.length === 0 ? [`${input.maps.length} 张地图`] : mapErrors.map(item => item.message)),
    result('actions', !input.runtimeRequested || (input.actions.length > 0 && input.audit.unreachableActions.length === 0) ? 'pass' : 'blocking', '动作必须在有界前向剧情链中真实可达并能通过不变量。', input.audit.unreachableActions.length === 0 ? input.audit.reachableActions : input.audit.unreachableActions.map(item => `${item.id}: ${item.reason}`)),
    result('cognition', !input.runtimeRequested || input.entities.length > 0 ? 'pass' : 'blocking', '每个运行角色拥有隔离且保留作者设定的记忆。', [`${input.entities.length} 个运行实体`]),
    result('causality', !input.runtimeRequested || input.actions.some(action => action.effects.length > 0) || input.systems.some(system => system.effects.length > 0) ? 'pass' : 'blocking', '每次状态变化都有明确原因。', [`${input.actions.length + input.systems.length} 个效果来源`]),
    result('safety', !input.runtimeRequested || (input.invariants.length > 0 && input.audit.initialInvariantFailures.length === 0) ? 'pass' : 'blocking', '初始状态及有界预演必须满足所有不变量。', input.audit.initialInvariantFailures.length === 0 ? [`${input.invariants.length} 条不变量`] : input.audit.initialInvariantFailures),
    result('liveness', !input.runtimeRequested || (input.audit.committedSteps > 0 && input.audit.stalledSystems.length === 0) ? 'pass' : 'blocking', '有界预演必须产生有效进展，周期系统不得空转。', [...input.audit.reachableActions, ...input.audit.progressingSystems, ...input.audit.stalledSystems.map(item => `${item.id}: ${item.reason}`)]),
    result('fairness', !input.runtimeRequested || input.actions.every(action => action.maxRetries >= 0) ? 'pass' : 'blocking', '所有动作都声明了有限的最大重试次数。', input.actions.map(action => `${action.id}: 最多重试=${String(action.maxRetries)}`)),
    result('event-validity', !input.runtimeRequested || input.audit.committedSteps > 0 ? 'pass' : 'blocking', '只有通过作用域和不变量检查的效果才可形成权威事件。', [`有界预演提交了 ${String(input.audit.committedSteps)} 步`]),
    result('behavioral-validity', input.purpose.hardExpectations.length > 0 ? 'pass' : 'warning', '已经声明需要验证的行为预期。', input.purpose.hardExpectations),
    result('replay', 'pass', '蓝图输入不可变，有界预演使用同一套确定性表达式与效果语义。', [input.digest]),
    result('provenance', noOrphans ? 'pass' : 'blocking', '每个可执行节点都保留来源。', [`${provenanceNodes.length} 个可执行节点`]),
  ]
  return {
    blueprintDigest: input.digest,
    createdAt: new Date().toISOString(),
    sourceCoverage: {
      author: coverage('author'),
      'approved-supplement': coverage('approved-supplement'),
      'mechanism-pack': coverage('mechanism-pack'),
      import: coverage('import'),
      'agent-proposal': coverage('agent-proposal'),
      'runtime-proposal': coverage('runtime-proposal'),
    },
    results,
    deterministicWithoutAi: true,
    knownLimits: input.runtimeRequested ? [] : ['当前构建没有声明自治演算时间范围。'],
    performance: { sourceObjects: input.canon.length, executableNodes: provenanceNodes.length },
  }
}

function proposalProvenance(proposal: CompilerProposal): Provenance {
  return {
    kind: 'approved-supplement',
    anchors: proposal.anchors,
    proposalId: worldlineId<'proposal'>(proposal.id),
    approvedBy: proposal.reviewedBy ?? 'author',
    confidence: 1,
  }
}

function actionNeedsCharacterTarget(action: ActionDefinition): boolean {
  return action.preconditions.some(expression => (
    expressionPaths(expression).some(path => path.startsWith('target.state.'))
  )) || action.effects.some(effect => (
    (effect.op === 'set' || effect.op === 'increment')
    && effect.path.startsWith('target.state.')
  ))
}

function isSocialAction(action: ActionDefinition): boolean {
  return /(?:^|[._-])(?:talk|speak|ask|dialog|social|bond)(?:$|[._-])/iu.test(action.id)
    || /(?:交谈|对话|深交|建立关系)/u.test(action.description)
}

/** Compile one immutable source snapshot without IO or model calls.
 * @param snapshot - The snapshot supplied by the caller.
 * @param requestedPurpose - The requested purpose supplied by the caller.
 * @param previousQuestions - The previous questions supplied by the caller.
 * @param proposals - The proposals supplied by the caller.
 * @returns The result produced by the operation.
 */
export function compileSnapshot(
  snapshot: ProjectSourceSnapshot,
  requestedPurpose: SimulationPurpose | undefined,
  previousQuestions: readonly CreativeQuestion[],
  proposals: readonly CompilerProposal[],
  runtimeModel: RuntimeSemanticModel = { documents: {} },
): CompilationProduct {
  const purpose = requestedPurpose ?? defaultPurpose(snapshot)
  const diagnostics: BuildDiagnostic[] = []
  const canon: CanonObject[] = []
  for (const file of snapshot.files) {
    try {
      canon.push(canonObject(file, snapshot, runtimeModel.documents[file.path]))
    } catch (error) {
      diagnostics.push({
        code: 'invalid-authored-yaml',
        severity: 'blocking',
        message: error instanceof Error ? error.message : String(error),
        path: file.path,
        remediation: '修正 worldline YAML 代码块；YAML 必须是对象且语法有效。',
      })
      const kind = kindOf(file)
      canon.push({
        id: entityIdOf(file),
        ...kind,
        documentId: file.id,
        title: titleOf(file),
        aliases: [],
        tags: file.tags,
        status: 'canon',
        worldIds: [snapshot.manifest.defaultWorldId],
        worldlineIds: [snapshot.manifest.defaultWorldlineId],
        facets: { sourcePath: file.path, ...(runtimeModel.documents[file.path]?.facets ?? {}) },
        provenance: [provenance(file)],
      })
    }
  }
  const executableCharacterPaths = new Set(snapshot.files.filter(file => (
    !isUntouchedCharacterTemplate(file) || runtimeModel.documents[file.path] !== undefined
  )).map(file => file.path))
  const answeredCharter = previousQuestions.find(item => item.id === question('missing-charter', '', '', 'high').id
    && item.status === 'answered' && item.answer !== undefined)
  if (answeredCharter?.answer !== undefined && !canon.some(object => object.kind === 'charter')) {
    canon.push({
      id: worldlineId<'entity'>(`entity:${contentFingerprint(answeredCharter.id)}`),
      kind: 'charter',
      documentId: worldlineId<'document'>(`document:${contentFingerprint(answeredCharter.id)}`),
      title: '已批准的世界宪章补充',
      aliases: [],
      tags: ['approved-supplement'],
      status: 'canon',
      worldIds: [snapshot.manifest.defaultWorldId],
      worldlineIds: [snapshot.manifest.defaultWorldlineId],
      facets: { answer: answeredCharter.answer },
      provenance: [{ kind: 'approved-supplement', anchors: [], approvedBy: 'author', confidence: 1 }],
    })
  }
  const byDocument = new Map(snapshot.files.map(file => [file.id, entityIdOf(file)]))
  const byEntity = new Set(canon.map(object => object.id))
  const links: CanonLink[] = []
  const actions: ActionDefinition[] = []
  const systems: SystemDefinition[] = []
  const invariants: InvariantDefinition[] = []
  const maps: WorldMap[] = []
  const plotPoints = snapshot.files.flatMap((file) => {
    const point = plotPoint(file)
    return point === undefined ? [] : [point]
  }).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

  for (const file of snapshot.files.filter(item => /<!--\s*worldline-facets\b/u.test(item.content))) {
    diagnostics.push({
      code: 'obsolete-worldline-facets',
      severity: 'blocking',
      message: '检测到已移除的 worldline-facets 隐藏注释。',
      path: file.path,
      remediation: '角色状态改用 worldline-state-schema、worldline-initial-state 与 worldline-memory YAML；世界初态改用 worldline-initial-world-state YAML。',
    })
  }

  for (const file of snapshot.files.filter(item => OBSOLETE_RUNTIME_FENCE_PATTERN.test(item.content))) {
    diagnostics.push({
      code: 'obsolete-runtime-fence',
      severity: 'blocking',
      message: '检测到已移除的 Markdown Runtime 代码块。',
      path: file.path,
      remediation: '动作、系统与不变量改用 worldline_edit set-runtime；地图改用原生地点文档与地图编排器。',
    })
  }

  for (const file of snapshot.files) {
    for (const match of file.content.matchAll(LINK_PATTERN)) {
      const targetText = match[1]
      if (targetText === undefined) continue
      const target = targetText.startsWith('entity:')
        ? targetText as EntityId
        : byDocument.get(targetText as ProjectSourceFile['id'])
      if (target === undefined || !byEntity.has(target)) {
        diagnostics.push({ code: 'broken-link', severity: 'blocking', message: `无法解析稳定引用：${targetText}`, path: file.path })
        continue
      }
      links.push({
        id: worldlineId<'link'>(`link:${contentFingerprint(`${file.id}:${match.index}:${target}`)}`),
        from: entityIdOf(file),
        to: target,
        predicate: 'references',
        directed: true,
        provenance: [provenance(file, match.index, match.index + match[0].length)],
      })
    }
    const runtime = runtimeModel.documents[file.path]
    if (runtime !== undefined) {
      const source = provenance(file)
      for (const value of runtime.actions ?? []) actions.push(parseAction(value, source))
      for (const value of runtime.systems ?? []) systems.push(parseSystem(value, source))
      for (const value of runtime.invariants ?? []) invariants.push(parseInvariant(value, source))
      for (const value of runtime.maps ?? []) maps.push(parseMap(value, source))
    }
  }

  for (const proposal of proposals.filter(item => item.status === 'approved')) {
    const source = proposalProvenance(proposal)
    try {
      if (proposal.target === 'action') actions.push(parseAction(proposal.payload, source))
      if (proposal.target === 'system') systems.push(parseSystem(proposal.payload, source))
      if (proposal.target === 'invariant') invariants.push(parseInvariant(proposal.payload, source))
      if (proposal.target === 'map') maps.push(parseMap(proposal.payload, source))
      if (proposal.target === 'canon') {
        const proposedKind = inferCanonObjectKind(
          'proposal',
          stringValue(proposal.payload.kind, 'proposal'),
        )
        canon.push({
          id: worldlineId<'entity'>(stringValue(
            proposal.payload.id,
            `entity:${contentFingerprint(proposal.id)}`,
          )),
          ...proposedKind,
          documentId: worldlineId<'document'>(`document:${contentFingerprint(proposal.id)}`),
          title: stringValue(proposal.payload.title, proposal.title),
          aliases: [],
          tags: ['approved-supplement'],
          status: 'canon',
          worldIds: [snapshot.manifest.defaultWorldId],
          worldlineIds: [snapshot.manifest.defaultWorldlineId],
          facets: jsonObject(proposal.payload.facets),
          provenance: [source],
        })
      }
    } catch (error) {
      diagnostics.push({
        code: 'invalid-approved-proposal',
        severity: 'blocking',
        message: error instanceof Error ? error.message : String(error),
        objectId: proposal.id,
      })
    }
  }

  const mergedMaps = mergeNativeLocationMetadata(maps, nativeLocationMap(snapshot.files))
  maps.splice(0, maps.length, ...mergedMaps)

  const runtimeRequested = purpose.duration > 0
  const generatedQuestions: CreativeQuestion[] = []
  if (!canon.some(object => object.kind === 'charter')) {
    generatedQuestions.push(question('missing-charter', '这个世界有哪些永远不能被违背的事实？', '世界宪章会为后续所有规则建立权威边界。', 'high'))
  }
  if (runtimeRequested && maps.length === 0) {
    generatedQuestions.push(question('missing-map', '角色可以出现在哪里，又如何在地点之间移动？', '运行时移动需要明确的地图连接和耗时。', 'high'))
  }
  if (runtimeRequested && actions.length === 0) {
    generatedQuestions.push(question('missing-actions', '角色至少需要能够尝试哪些行动？', '自治世界至少需要一条可执行的动作契约。', 'high'))
  }
  if (runtimeRequested && invariants.length === 0) {
    generatedQuestions.push(question('missing-invariants', '每个世界状态都必须遵守哪些安全条件？', '缺少可执行不变量时，构建闭包无法证明世界安全。', 'high'))
  }

  const entities: RuntimeEntitySeed[] = canon.filter(object => (
    (object.kind === 'character'
      && (typeof object.facets.sourcePath !== 'string'
        || executableCharacterPaths.has(object.facets.sourcePath)))
    || object.facets.runtimeEntity === true
  )).map(object => ({
    id: object.id,
    type: object.kind,
    facets: { ...object.facets, displayName: object.title },
    state: isRecord(object.facets.initialState) ? object.facets.initialState : {},
    lod: object.kind === 'character' ? 'L2' : 'L0',
    policyIds: [],
    memory: authoredMemory(object),
  }))
  const audit = auditExecutability({ canon, entities, maps, actions, systems, invariants })
  if (runtimeRequested) {
    if (plotPoints.length > 0) {
      const initial = materializeInitialWorldState(canon, entities)
      const world = isRecord(initial.world) ? initial.world : undefined
      const calendar = world !== undefined && isRecord(world.calendar) ? world.calendar : undefined
      const seasons = Array.isArray(calendar?.seasons)
        ? calendar.seasons.filter(item => typeof item === 'string' && item.trim() !== '')
        : []
      if (calendar === undefined
        || !Number.isFinite(calendar.secondsPerDay) || Number(calendar.secondsPerDay) <= 0
        || !Number.isInteger(calendar.daysPerSeason) || Number(calendar.daysPerSeason) <= 0
        || seasons.length === 0
        || !Number.isFinite(calendar.startClockMinute) || Number(calendar.startClockMinute) < 0
        || Number(calendar.startClockMinute) >= 1_440
        || !Number.isInteger(calendar.startDayIndex) || Number(calendar.startDayIndex) < 1) {
        diagnostics.push({
          code: 'story-time-unconfigured',
          severity: 'blocking',
          message: '故事世界缺少明确、合法的历法与开场时间。',
          remediation: '在世界文档加入 worldline-initial-world-state YAML，明确 world.calendar.secondsPerDay、daysPerSeason、seasons、startDayIndex 与 startClockMinute。',
        })
      }
      for (const point of plotPoints) {
        const timing = point.timing
        const validWindow = Number.isFinite(timing.activateAt) && timing.activateAt >= 0
          && Number.isFinite(timing.deadlineAt) && timing.deadlineAt > timing.activateAt
        const validInterventions = timing.interventions.length > 0
          && timing.interventions.every(intervention => Number.isFinite(intervention.at)
            && intervention.at >= timing.activateAt && intervention.at <= timing.deadlineAt
            && intervention.title.trim() !== '' && intervention.description.trim() !== '')
          && new Set(timing.interventions.map(intervention => intervention.id)).size
            === timing.interventions.length
        if (!validWindow || !validInterventions) diagnostics.push({
          code: 'story-time-control-invalid',
          severity: 'blocking',
          message: `剧情点“${point.name}”缺少可由 Runtime 强制执行的时间窗口或干预节点。`,
          remediation: '在剧情点 Markdown 中填写激活时刻（游戏秒）、截止时刻（游戏秒），并至少写一条“时刻|标题|明确发生的世界事件”的时间干预。',
        })
      }
      const nodeIds = new Set(maps.flatMap(map => map.nodes.map(node => node.id)))
      for (const node of maps.flatMap(map => map.nodes)) {
        if (node.description === undefined || node.description.trim() === '') {
          diagnostics.push({
            code: 'story-place-description-missing',
            severity: 'blocking',
            message: `地点“${node.name}”缺少完整描述。`,
            objectId: node.id,
            remediation: '在对应 maps/places/*.md 的标题后、地点档案前写明空间风貌、感官环境、用途与叙事意义。',
          })
        }
      }
      const actionPaths = actions.flatMap(action => [
        ...action.preconditions.flatMap(expressionPaths),
        ...action.effects.flatMap(effect => 'path' in effect ? [effect.path] : []),
      ])
      const systemPaths = systems.flatMap(system => [
        ...system.preconditions.flatMap(expressionPaths),
        ...system.effects.flatMap(effect => 'path' in effect ? [effect.path] : []),
      ])
      const relativeActorPath = (path: string): string | undefined => path.startsWith('state.')
        ? path.slice('state.'.length)
        : path.startsWith('actor.state.')
          ? path.slice('actor.state.'.length)
          : path.startsWith('target.state.')
            ? path.slice('target.state.'.length)
            : undefined
      const actionActorPaths = new Set(actionPaths.flatMap(path => relativeActorPath(path) ?? []))
      const actionWorldPaths = new Set(actionPaths.flatMap(path => path.startsWith('world.')
        ? [path.slice('world.'.length)] : []))
      const systemWorldPaths = new Set(systemPaths.flatMap(path => path.startsWith('world.')
        ? [path.slice('world.'.length)] : []))
      for (const action of actions) {
        if (action.operator === 'move' || action.operator === 'teleport') continue
        if (action.location === undefined) {
          diagnostics.push({
            code: 'story-action-location-contract-missing',
            severity: 'blocking',
            message: `动作“${action.description || action.id}”没有明确空间契约。`,
            objectId: action.id,
            remediation: '非移动动作必须用 location: { mode: at, nodeIds: [...] } 声明可执行地点，或用 location: { mode: anywhere } 明确声明不受地点限制；跨地点必须先执行 move。',
          })
          continue
        }
        if (action.location.mode === 'at' && (action.location.nodeIds.length === 0
          || action.location.nodeIds.some(nodeId => !nodeIds.has(nodeId)))) {
          diagnostics.push({
            code: 'story-action-location-contract-invalid',
            severity: 'blocking',
            message: `动作“${action.description || action.id}”引用了空地点集或不存在的地图节点。`,
            objectId: action.id,
            remediation: 'location.nodeIds 至少包含一个当前运行地图中的稳定 map-node ID。',
          })
        }
      }
      for (const entity of entities.filter(item => item.type === 'character')) {
        const schema = isRecord(entity.facets.stateSchema) ? entity.facets.stateSchema : undefined
        if (schema === undefined || Object.keys(schema).length === 0) {
          diagnostics.push({
            code: 'story-state-schema-missing',
            severity: 'blocking',
            message: `角色 ${entity.id} 缺少可运行状态 schema。`,
            objectId: entity.id,
            remediation: '在角色文档加入 worldline-state-schema YAML，为每个状态字段声明 type 与 mutable。',
          })
        } else {
          for (const [path, field] of Object.entries(schema)) {
            if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*){0,5}$/u.test(path)
              || !isRecord(field) || typeof field.type !== 'string'
              || !['string', 'number', 'boolean', 'array', 'object'].includes(field.type)
              || typeof field.mutable !== 'boolean') {
              diagnostics.push({
                code: 'story-state-schema-invalid',
                severity: 'blocking',
                message: `角色 ${entity.id} 的状态字段 ${path} 没有合法的 type/mutable 契约。`,
                objectId: entity.id,
                remediation: '字段路径使用点分标识；type 只能是 string/number/boolean/array/object，mutable 必须是布尔值。',
              })
              continue
            }
            const initialValue = readPath(entity.state, path)
            if (!matchesSchemaType(initialValue, field.type)) {
              diagnostics.push({
                code: 'story-state-initial-mismatch',
                severity: 'blocking',
                message: `角色 ${entity.id} 的初始字段 ${path} 缺失或类型与 schema 不一致。`,
                objectId: entity.id,
                remediation: '在 worldline-initial-state 中为该字段填写与声明类型一致的初始值。',
              })
            }
            const participationIssue = stateParticipationIssue(
              path,
              field,
              initialValue,
              'character',
              actionActorPaths,
              actionWorldPaths,
              systemWorldPaths,
            )
            if (participationIssue !== undefined) {
              diagnostics.push({
                code: 'story-state-participation-invalid',
                severity: 'blocking',
                message: `角色 ${entity.id} 的状态字段 ${path} 没有完整参与推演：${participationIssue}。`,
                objectId: entity.id,
                remediation: '为字段声明 label 与 participation.drivers/meaning/narrative/choices；数值字段还需至少两个有明确阈值的 bands。',
              })
            }
          }
        }
        const locationId = typeof entity.state.locationId === 'string'
          ? entity.state.locationId.trim()
          : ''
        if (locationId === '' || !nodeIds.has(worldlineId<'map-node'>(locationId))) {
          diagnostics.push({
            code: 'story-location-unconfigured',
            severity: 'blocking',
            message: locationId === ''
              ? `角色 ${entity.id} 缺少明确的初始地点。`
              : `角色 ${entity.id} 的初始地点 ${locationId} 不存在于地图。`,
            objectId: entity.id,
            remediation: '在角色的 worldline-initial-state YAML 中填写有效的 locationId；不得用默认教学楼或其他猜测地点。',
          })
        }
        const locationSchema = schema?.locationId
        if (!isRecord(locationSchema) || locationSchema.type !== 'string'
          || locationSchema.mutable !== false) {
          diagnostics.push({
            code: 'story-location-schema-invalid',
            severity: 'blocking',
            message: `角色 ${entity.id} 的 locationId 必须声明为不可由状态导演修改的字符串。`,
            objectId: entity.id,
            remediation: '在 worldline-state-schema 中设置 locationId: { type: string, mutable: false }。',
          })
        }
      }
      const worldSchema = isRecord(initial.worldStateSchema) ? initial.worldStateSchema : undefined
      if (worldSchema === undefined || Object.keys(worldSchema).length === 0) {
        diagnostics.push({
          code: 'story-world-state-schema-missing',
          severity: 'blocking',
          message: '世界缺少可运行的 worldStateSchema。',
          remediation: '在世界文档加入 worldline-world-state-schema，为每个环境与世界字段声明类型、驱动来源和叙事参与语义。',
        })
      } else {
        for (const [path, field] of Object.entries(worldSchema)) {
          if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*){0,5}$/u.test(path)
            || !isRecord(field) || typeof field.type !== 'string'
            || !['string', 'number', 'boolean', 'array', 'object'].includes(field.type)
            || typeof field.mutable !== 'boolean') {
            diagnostics.push({
              code: 'story-world-state-schema-invalid',
              severity: 'blocking',
              message: `世界状态字段 ${path} 没有合法的 type/mutable 契约。`,
              remediation: '字段路径使用点分标识；type 只能是 string/number/boolean/array/object，mutable 必须是布尔值。',
            })
            continue
          }
          const world = isRecord(initial.world) ? initial.world : undefined
          const initialValue = readPath(world ?? {}, path)
          if (!matchesSchemaType(initialValue, field.type)) {
            diagnostics.push({
              code: 'story-world-state-initial-mismatch',
              severity: 'blocking',
              message: `世界状态初始字段 ${path} 缺失或类型与 schema 不一致。`,
              remediation: '在 worldline-initial-world-state.world 中填写与声明类型一致的初始值。',
            })
          }
          const participationIssue = stateParticipationIssue(
            path,
            field,
            initialValue,
            'world',
            actionActorPaths,
            actionWorldPaths,
            systemWorldPaths,
          )
          if (participationIssue !== undefined) {
            diagnostics.push({
              code: 'story-world-state-participation-invalid',
              severity: 'blocking',
              message: `世界状态字段 ${path} 没有完整参与推演：${participationIssue}。`,
              remediation: '为字段声明 label 与 participation.drivers/meaning/narrative/choices；数值字段还需至少两个有明确阈值的 bands。',
            })
          }
        }
      }
    }
    for (const action of actions.filter(isSocialAction)) {
      if (actionNeedsCharacterTarget(action)) continue
      diagnostics.push({
        code: 'social-action-targetless',
        severity: 'blocking',
        message: `社交动作“${action.description || action.id}”没有绑定另一名角色，因此不能形成在场对话或关系变化。`,
        objectId: action.id,
        remediation: '至少在前置条件或效果中使用 target.state.*；关系动作通常同时更新 state.bond 与 target.state.bond。Runtime 会据此只生成同地点角色目标。',
      })
    }
    for (const point of plotPoints) {
      const fields: readonly (readonly [string, string])[] = [
        ['进入条件', point.entryCondition],
        ['完成证据', point.completionCriteria],
        ['戏剧压力', point.dramaticPressure],
        ['成功后果', point.successOutcome],
        ['失败后果', point.failureOutcome],
        ['恢复钩子', point.recoveryHook],
      ]
      const missingFields = fields.filter(([, value]) => value.trim() === '')
        .map(([label]) => label)
      if (missingFields.length > 0) {
        diagnostics.push({
          code: 'plot-contract-incomplete',
          severity: 'blocking',
          message: `剧情事件“${point.name}”缺少新的目标契约字段：${missingFields.join('、')}`,
          objectId: point.id,
          remediation: '补齐进入条件、完成证据、戏剧压力、成功/失败后果与恢复钩子；剧情点不得绑定动作 ID。',
        })
      }
    }
    const duplicatedOrders = plotPoints.filter((point, index) => (
      plotPoints.findIndex(candidate => candidate.order === point.order) !== index
    ))
    for (const point of duplicatedOrders) diagnostics.push({
      code: 'plot-order-duplicate',
      severity: 'blocking',
      message: `剧本点“${point.name}”的顺序 ${String(point.order)} 与其他剧本点重复。`,
      objectId: point.id,
      remediation: '为每个剧本点设置唯一的推进顺序。',
    })
    diagnostics.push(...audit.initialInvariantFailures.map(message => ({
      code: 'initial-invariant-failed',
      severity: 'blocking' as const,
      message,
      remediation: '修正角色初始状态或不变量作用域，使冻结前的初始世界满足安全条件。',
    })))
    diagnostics.push(...audit.unreachableActions.map(item => ({
      code: 'action-unreachable',
      severity: 'blocking' as const,
      message: `${item.id}：${item.reason}`,
      objectId: item.id,
      remediation: '统一 actor/target/world 作用域，并保证至少一个匹配角色可完成该动作。',
    })))
    diagnostics.push(...audit.stalledSystems.map(item => ({
      code: 'system-no-progress',
      severity: 'blocking' as const,
      message: `${item.id}：${item.reason}`,
      objectId: item.id,
      remediation: '让周期系统产生可验证的状态、事实或认知变化，并保持不变量成立。',
    })))
    if (!audit.mapReachable) {
      diagnostics.push({
        code: 'map-route-unreachable',
        severity: 'blocking',
        message: '角色初始位置之间没有可执行的正耗时移动路径。',
        remediation: '检查角色 locationId、地图节点和边的 baseDuration。',
      })
    }
  }
  const digest = createHash('sha256').update(stableStringify({
    snapshot: snapshot.digest,
    purpose,
    canon,
    links,
    maps,
    actions,
    systems,
    invariants,
    plotPoints,
    runtimeModel,
  })).digest('hex')
  const certificate = makeCertificate({
    digest, runtimeRequested, canon, maps, entities, actions, systems, invariants,
    diagnostics, purpose, audit,
  })
  return {
    snapshot,
    purpose,
    canon,
    links,
    maps,
    entities,
    actions,
    systems,
    invariants,
    plotPoints,
    diagnostics,
    questions: mergeQuestions(generatedQuestions, previousQuestions),
    proposals,
    certificate,
  }
}
