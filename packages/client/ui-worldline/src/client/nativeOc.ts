import type { DocumentView } from '@deepseek-ai/dsh-worldline-project/types'
import type { CanonObjectKind, MapNode } from '@deepseek-ai/dsh-worldline-standard/types'
import { canonDirectory } from '@deepseek-ai/dsh-worldline-standard/project-layout'
import { DEFAULT_ARTWORK } from './default-artwork.ts'

export type NativeCanonSectionId =
  | 'characters'
  | 'places'
  | 'society'
  | 'systems'
  | 'items'
  | 'stories'

export type EditableCanonKind = Exclude<CanonObjectKind, 'charter' | 'custom'>

export type NativeCanonKindDefinition = {
  readonly kind: EditableCanonKind
  readonly label: string
  readonly directory: string
  readonly sectionTitle: string
  readonly prompt: string
}

export type NativeCanonSection = {
  readonly id: NativeCanonSectionId
  readonly label: string
  readonly description: string
  readonly kinds: readonly EditableCanonKind[]
}

export const NATIVE_CANON_KINDS: readonly NativeCanonKindDefinition[] = [
  { kind: 'character', label: '人物', directory: canonDirectory('character'), sectionTitle: '人物档案', prompt: '身份、外观、性格、目标、能力、关系、经历与初始状态。' },
  { kind: 'species', label: '物种', directory: canonDirectory('species'), sectionTitle: '物种档案', prompt: '生理特征、生命周期、文化差异、能力边界、栖息地与种群关系。' },
  { kind: 'place', label: '地点与环境', directory: canonDirectory('place'), sectionTitle: '地点档案', prompt: '空间层级、环境、天气影响、通路、容量、风险与可发生事件。' },
  { kind: 'organization', label: '组织', directory: canonDirectory('organization'), sectionTitle: '组织档案', prompt: '宗旨、权力结构、成员、资源、辖区、盟友、敌人及当前行动。' },
  { kind: 'relation', label: '关系', directory: canonDirectory('relation'), sectionTitle: '关系档案', prompt: '关系双方、性质、强度、公开程度、形成原因、变化条件与影响。' },
  { kind: 'rule', label: '机制与规则', directory: canonDirectory('rule'), sectionTitle: '运行机制', prompt: '触发条件、作用对象、状态变化、时间/天气/环境参与方式、代价与不变量。' },
  { kind: 'concept', label: '概念与术语', directory: canonDirectory('concept'), sectionTitle: '概念档案', prompt: '定义、适用范围、相关概念、例外、社会理解与叙事作用。' },
  { kind: 'fact', label: '世界事实', directory: canonDirectory('fact'), sectionTitle: '事实档案', prompt: '已经成立的事实、证据、知情范围、因果关系以及可被改变的条件。' },
  { kind: 'item', label: '物品', directory: canonDirectory('item'), sectionTitle: '物品档案', prompt: '外观、归属、位置、用途、状态、稀缺性、历史及对行动的影响。' },
  { kind: 'asset', label: '美术与声音资源', directory: canonDirectory('asset'), sectionTitle: '资源档案', prompt: '媒体类型、来源文件、用途、适用角色/地点/情境、生成提示词与替代文本。' },
  { kind: 'scenario', label: '剧情事件', directory: canonDirectory('scenario'), sectionTitle: '剧情推进', prompt: '进入条件、完成证据、戏剧压力、硬时间干预、成功/失败后果与恢复路径。' },
  { kind: 'timeline-event', label: '时间线事件', directory: canonDirectory('timeline-event'), sectionTitle: '时间线事件', prompt: '发生时间、持续时长、地点、参与者、前因、结果与对后续世界状态的影响。' },
]

export const NATIVE_CANON_SECTIONS: readonly NativeCanonSection[] = [
  { id: 'characters', label: '人物与物种', description: '独立个体、群体生物学与文化边界', kinds: ['character', 'species'] },
  { id: 'places', label: '地点与环境', description: '空间、天气、环境条件与通路', kinds: ['place'] },
  { id: 'society', label: '组织与关系', description: '组织结构、阵营网络与关系变化', kinds: ['organization', 'relation'] },
  { id: 'systems', label: '规则与世界知识', description: '机制、概念与已成立事实', kinds: ['rule', 'concept', 'fact'] },
  { id: 'items', label: '物品与资源', description: '可交互物品以及美术、声音资源索引', kinds: ['item', 'asset'] },
  { id: 'stories', label: '剧情与时间线', description: '剧情目标、硬时间干预与历史事件', kinds: ['scenario', 'timeline-event'] },
]

export type NativeDossierDraft = {
  readonly path?: string
  readonly revision?: DocumentView['revision']
  readonly documentId?: DocumentView['id']
  kind: EditableCanonKind
  name: string
  summary: string
  body: string
}

export function nativeCanonDefinition(kind: EditableCanonKind): NativeCanonKindDefinition {
  const definition = NATIVE_CANON_KINDS.find(item => item.kind === kind)
  const fallback = NATIVE_CANON_KINDS[0]
  if (definition !== undefined) return definition
  if (fallback === undefined) throw new Error('Native OC canon kind registry is empty.')
  return fallback
}

export function emptyDossierDraft(kind: EditableCanonKind): NativeDossierDraft {
  return { kind, name: '', summary: '', body: '' }
}

export function dossierDraft(document: DocumentView, kind: EditableCanonKind): NativeDossierDraft {
  const visible = document.content.replace(/<!--[\s\S]*?-->/gu, '').trim()
  const withoutTitle = visible.replace(/^#\s+.*(?:\r?\n)?/u, '').trimStart()
  const sectionIndex = withoutTitle.search(/^##\s+/mu)
  return {
    path: document.path,
    revision: document.revision,
    documentId: document.id,
    kind,
    name: title(document),
    summary: (sectionIndex < 0 ? withoutTitle : withoutTitle.slice(0, sectionIndex)).trim(),
    body: sectionIndex < 0 ? '' : withoutTitle.slice(sectionIndex).trim(),
  }
}

export function dossierMarkdown(draft: NativeDossierDraft): string {
  const definition = nativeCanonDefinition(draft.kind)
  const body = draft.body.trim()
  const sections = body === '' ? `## ${definition.sectionTitle}\n\n${definition.prompt}`
    : /^##\s+/u.test(body) ? body : `## ${definition.sectionTitle}\n\n${body}`
  return `# ${draft.name.trim() || `未命名${definition.label}`}\n\n${draft.summary.trim() || definition.prompt}\n\n${sections}\n`
}

export function dossierPath(draft: NativeDossierDraft, timestamp = Date.now()): string {
  const definition = nativeCanonDefinition(draft.kind)
  const slug = draft.name.trim().toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/gu, '') || `${draft.kind}-${String(timestamp)}`
  return `${definition.directory}/${slug}.md`
}

export type NativeLocationDraft = {
  readonly path?: string
  readonly revision?: DocumentView['revision']
  readonly documentId?: DocumentView['id']
  id: string
  name: string
  summary: string
  kind: MapNode['kind']
  parentId: string
  x: number
  y: number
  capacity: string
  connections: string
  background: string
  gallery: string
}

function cleanValue(value: string): string {
  return value.trim()
    .replace(/^`([\s\S]+)`$/u, '$1')
    .replace(/^\*\*([\s\S]+)\*\*$/u, '$1')
    .trim()
}

function emptyAuthoredValue(value: string): boolean {
  return value === '' || value === '待补充'
    || /^[—–-](?:\s*[（(][^）)]*[）)])?$/u.test(value)
}

function fields(content: string, label: string): readonly string[] {
  const lines = content.replace(/\r\n/gu, '\n').split('\n')
  const pattern = new RegExp(`^(\\s*)[-*]\\s*${label}\\s*[：:]\\s*(.*)$`, 'u')
  const values: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index] ?? '')
    if (match === null) continue
    const baseIndent = match[1]?.length ?? 0
    const inline = cleanValue(match[2] ?? '')
    if (!emptyAuthoredValue(inline)) values.push(inline)
    let cursor = index + 1
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? ''
      if (line.trim() === '') continue
      const item = /^(\s*)[-*]\s+(.+)$/u.exec(line)
      if (item === null || (item[1]?.length ?? 0) <= baseIndent) break
      const value = cleanValue(item[2] ?? '')
      if (!emptyAuthoredValue(value)) values.push(value)
    }
    index = cursor - 1
  }
  return values
}

function field(content: string, label: string): string {
  return fields(content, label)[0] ?? ''
}

function title(document: DocumentView): string {
  return /^#\s+(.+)$/mu.exec(document.content)?.[1]?.trim()
    ?? document.path.split('/').at(-1)?.replace(/\.md$/iu, '')
    ?? '未命名地点'
}

export function emptyLocationDraft(): NativeLocationDraft {
  return {
    id: `map-node:place-${String(Date.now())}`,
    name: '',
    summary: '',
    kind: 'region',
    parentId: '',
    x: 180,
    y: 140,
    capacity: '',
    connections: '',
    background: DEFAULT_ARTWORK.place,
    gallery: '',
  }
}

export function locationDraft(document: DocumentView): NativeLocationDraft {
  const visible = document.content.replace(/<!--[\s\S]*?-->/gu, '').trim()
  const summary = visible.replace(/^#\s+.*$/mu, '').split(/^##\s+/mu)[0]?.trim() ?? ''
  const rawKind = field(visible, '地点类型').toLowerCase()
  const kindAliases: Readonly<Record<string, MapNode['kind']>> = {
    world: 'world', '世界': 'world', plane: 'plane', '位面': 'plane', region: 'region', '区域': 'region',
    city: 'city', '城市': 'city', building: 'building', '建筑': 'building', room: 'room', '房间': 'room',
    slot: 'slot', '点位': 'slot',
  }
  const kind = Object.entries(kindAliases).find(([label]) => rawKind === label || rawKind.includes(label))?.[1] ?? 'region'
  const coordinates = (field(visible, '地图坐标').match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number)
  const capacity = field(visible, '容纳人数').match(/\d+(?:\.\d+)?/u)?.[0] ?? ''
  return {
    path: document.path,
    revision: document.revision,
    documentId: document.id,
    id: field(visible, '地点 ID') || `map-node:place-${String(Date.now())}`,
    name: title(document),
    summary,
    kind,
    parentId: field(visible, '上级地点'),
    x: Number.isFinite(coordinates[0]) ? coordinates[0] ?? 180 : 180,
    y: Number.isFinite(coordinates[1]) ? coordinates[1] ?? 140 : 140,
    capacity,
    connections: fields(visible, '相邻地点').flatMap(value => value.split(/[；;]/gu)).map(value => value.trim()).filter(Boolean).join('\n'),
    background: field(visible, '场景背景'),
    gallery: fields(visible, '场景画廊').flatMap(value => value.split(/[；;]/gu)).map(value => value.trim()).filter(Boolean).join('\n'),
  }
}

export function locationMarkdown(draft: NativeLocationDraft): string {
  const connections = draft.connections.split(/\r?\n/gu).map(item => item.trim()).filter(Boolean).join('；')
  const gallery = draft.gallery.split(/\r?\n/gu).map(item => item.trim()).filter(Boolean).join('；')
  return `# ${draft.name.trim() || '未命名地点'}

${draft.summary.trim() || '这个地点的故事仍在书写中。'}

## 地点档案

- 地点 ID：${draft.id}
- 地点类型：${draft.kind}
- 上级地点：${draft.parentId.trim() || '—'}
- 地图坐标：${String(Math.round(draft.x))}, ${String(Math.round(draft.y))}
- 容纳人数：${draft.capacity.trim() || '—'}
- 相邻地点：${connections || '—'}
- 场景背景：${draft.background.trim() || '—'}
- 场景画廊：${gallery || '—'}
`
}

export function locationConnection(value: string): { readonly targetId: string; readonly duration: number } | undefined {
  const [targetId, rawDuration] = value.split('|').map(item => item.trim())
  if (targetId === undefined || targetId === '') return undefined
  const duration = Number(rawDuration)
  return { targetId, duration: Number.isFinite(duration) && duration > 0 ? duration : 10 }
}

export type NativePlotDraft = {
  readonly path?: string
  readonly revision?: DocumentView['revision']
  readonly documentId?: DocumentView['id']
  name: string
  summary: string
  entryCondition: string
  completionCriteria: string
  dramaticPressure: string
  successOutcome: string
  failureOutcome: string
  recoveryHook: string
  order: number
  activateAt: number
  deadlineAt: number
  interventions: string
}

export function emptyPlotDraft(): NativePlotDraft {
  return {
    name: '', summary: '', entryCondition: '', completionCriteria: '', dramaticPressure: '',
    successOutcome: '', failureOutcome: '', recoveryHook: '', order: 1,
    activateAt: 0, deadlineAt: 3_600, interventions: '',
  }
}

export function plotDraft(document: DocumentView): NativePlotDraft {
  const visible = document.content.replace(/<!--[\s\S]*?-->/gu, '').trim()
  const summary = visible.replace(/^#\s+.*$/mu, '').split(/^##\s+/mu)[0]?.trim() ?? ''
  const order = Number(field(visible, '顺序'))
  const activateAt = Number(field(visible, '激活时刻（游戏秒）'))
  const deadlineAt = Number(field(visible, '截止时刻（游戏秒）'))
  return {
    path: document.path,
    revision: document.revision,
    documentId: document.id,
    name: title(document),
    summary,
    entryCondition: field(visible, '进入条件'),
    completionCriteria: field(visible, '完成证据'),
    dramaticPressure: field(visible, '戏剧压力'),
    successOutcome: field(visible, '成功后果'),
    failureOutcome: field(visible, '失败后果'),
    recoveryHook: field(visible, '恢复钩子'),
    order: Number.isFinite(order) && order > 0 ? Math.floor(order) : 1,
    activateAt: Number.isFinite(activateAt) && activateAt >= 0 ? activateAt : 0,
    deadlineAt: Number.isFinite(deadlineAt) && deadlineAt > 0 ? deadlineAt : 3_600,
    interventions: fields(visible, '时间干预').join('\n'),
  }
}

export function plotMarkdown(draft: NativePlotDraft): string {
  const interventionLines = draft.interventions.split(/\r?\n/gu)
    .map(item => item.trim()).filter(Boolean)
    .map(item => `- 时间干预：${item}`).join('\n')
  return `# ${draft.name.trim() || '未命名剧情点'}

${draft.summary.trim() || '这个剧情点仍在书写中。'}

## 剧情推进

- 顺序：${String(Math.max(1, Math.floor(draft.order)))}
- 激活时刻（游戏秒）：${String(Math.max(0, Math.floor(draft.activateAt)))}
- 截止时刻（游戏秒）：${String(Math.max(1, Math.floor(draft.deadlineAt)))}
${interventionLines || '- 时间干预：'}
- 进入条件：${draft.entryCondition.trim()}
- 完成证据：${draft.completionCriteria.trim()}
- 戏剧压力：${draft.dramaticPressure.trim()}
- 成功后果：${draft.successOutcome.trim()}
- 失败后果：${draft.failureOutcome.trim()}
- 恢复钩子：${draft.recoveryHook.trim()}
`
}
