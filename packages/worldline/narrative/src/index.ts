import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-worldline-ai'
import type {} from '@deepseek-ai/dsh-worldline-runtime'
import type {
  CheckpointView,
  RunView,
  SubmitRunActionResult,
} from '@deepseek-ai/dsh-worldline-runtime/types'
import {
  projectAuthoredCalendar,
  stableStringify,
  validateContextPack,
  worldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import type {
  ContextPack,
  ContextPackSection,
  ActionDeck,
  ChoiceProjection,
  EntityId,
  JsonObject,
  JsonValue,
  MediaCue,
  NarrativeBeat,
  NarrativeBlock,
  NarrativeStateCue,
  Observation,
  SceneFrame,
  StoryProgressEvidence,
  StoryStageRenderer,
  WorldEvent,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type {
  BranchTextPlayRequest,
  ChooseTextActionRequest,
  FreeTextActionRequest,
  FreeTextActionResult,
  NarrateRequest,
  NarrativeStreamChunk,
  RephraseRequest,
  RetryTextActionRequest,
  SaveTextPlayRequest,
  ScriptProgressView,
  StoryChoiceSuggestions,
  StoryStageStatus,
  TextPlayRequest,
  TextPlayView,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { worldlineNarrative: WorldlineNarrative }
}

interface NarrativeSources {
  readonly events: readonly WorldEvent[]
  readonly observations: readonly Observation[]
}

interface NarratorPreparation {
  readonly pack: ContextPack
  readonly recentPresentation: readonly (readonly NarrativeBlock[])[]
}

const STATE_CUE_LABELS: Readonly<Record<string, string>> = {
  health: '生命',
  stamina: '体力',
  energy: '精力',
  stress: '压力',
  hunger: '饥饿',
  emotion: '情绪',
  mood: '心境',
  status: '状态',
  affection: '好感',
  trust: '信任',
  bond: '羁绊',
  relationship: '关系',
  injury: '伤势',
  infection: '感染',
  abilityLevel: '异能强度',
  abilityControl: '异能控制',
  locationId: '地点',
  severity: '环境强度',
  stage: '灾变阶段',
  greyTide: '灰潮',
  infectedCount: '感染者',
  exposureRisk: '暴露风险',
}

function stateCueValue(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value.slice(0, 80)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }
  return stableStringify(value).slice(0, 80)
}

function stateCueTone(path: string, before: JsonValue | undefined, after: JsonValue | undefined):
NarrativeStateCue['tone'] {
  const lower = path.toLocaleLowerCase()
  if (typeof before !== 'number' || typeof after !== 'number' || before === after) return 'neutral'
  const increaseIsGood = /(?:health|stamina|energy|affection|trust|bond|abilitycontrol)$/u.test(lower)
  const increaseIsBad = /(?:stress|hunger|injury|infection|severity|stage|greytide|infectedcount|exposurerisk)$/u
    .test(lower)
  if (increaseIsGood) return after > before ? 'positive' : 'warning'
  if (increaseIsBad) return after > before ? 'danger' : 'positive'
  return 'neutral'
}

/** Project exact Runtime deltas into a small whitelist that the narrator may place in the visual
 * stream. These cues never mutate the Run and never accept model-authored values. */
export function authoritativeStateCues(sources: NarrativeSources): readonly NarrativeStateCue[] {
  const byPath = new Map<string, NarrativeStateCue>()
  for (const event of sources.events) {
    for (const delta of event.deltas) {
      const value = stateCueValue(delta.after)
      if (value === undefined || stateCueValue(delta.before) === value) continue
      const parts = delta.path.split('.')
      const key = parts.at(-1) ?? delta.path
      const before = stateCueValue(delta.before)
      const actorId = parts[0] === 'entities' && typeof parts[1] === 'string'
        && parts[1].startsWith('entity:') ? worldlineId<'entity'>(parts[1]) : undefined
      const scope: NarrativeStateCue['scope'] = actorId !== undefined
        ? 'character'
        : parts.some(part => /relationship/iu.test(part))
          ? 'relationship'
          : parts.some(part => /(?:world|conflict|environment|weather|hazard)/iu.test(part))
            ? 'environment'
            : 'story'
      byPath.set(delta.path, {
        scope,
        label: STATE_CUE_LABELS[key] ?? key,
        ...(before === undefined ? {} : { before }),
        value,
        tone: stateCueTone(delta.path, delta.before, delta.after),
        ...(actorId === undefined ? {} : { actorId }),
        path: delta.path,
      })
    }
  }
  return [...byPath.values()].slice(-8)
}

const NARRATOR_MAX_INPUT_TOKENS = 12_000
const NARRATOR_MAX_OUTPUT_TOKENS = 900
const NARRATOR_MAX_TOOL_TOKENS = 600
const NARRATOR_MAX_CHARACTERS = 900
const NARRATOR_RECENT_MEMORIES = 12
const NARRATOR_MAX_CONTINUITY_ATTEMPTS = 3
const CHOICE_PLANNER_MAX_INPUT_TOKENS = 5_000

// Three complete plans include long opaque opportunity IDs plus scene-specific prose.
// Keep the output ceiling above the tool schema's legitimate worst-case envelope so a
// provider cannot truncate the third plan into malformed JSON.
const CHOICE_PLANNER_MAX_OUTPUT_TOKENS = 640
const CHOICE_PLANNER_MAX_CHARACTERS = 2_000
const CREATIVE_STRUCTURE_ATTEMPTS = 2

const ChoicePlanSchema = z.object({
  choices: z.array(z.object({
    opportunityId: z.string().min(1),
    label: z.string().min(1).max(64),
    intent: z.string().min(4).max(240),
    storyRole: z.enum(['advance', 'character', 'deviate']),
  })).length(3),
})

const IntentPlanSchema = z.object({ opportunityId: z.string().min(1).nullable() })
const StateUpdateSchema = z.object({
  mutations: z.array(z.object({
    scope: z.enum(['character', 'world']),
    actorId: z.string().min(1).optional(),
    path: z.string().min(1).max(200),
    operation: z.enum(['set', 'increment', 'append', 'remove']),
    value: z.json(),
    reason: z.string().min(4).max(240),
  })).max(64),
  memoryWrites: z.array(z.object({
    actorId: z.string().min(1),
    summary: z.string().min(4).max(500),
    importance: z.number().min(0).max(1),
  })).max(32),
})

type StateUpdate = z.infer<typeof StateUpdateSchema>

function directorMutablePaths(schema: JsonValue | undefined): readonly string[] {
  return Object.entries(object(schema) ?? {}).flatMap(([path, rawField]) => {
    const field = object(rawField)
    const participation = object(field?.['participation'])
    const drivers = Array.isArray(participation?.['drivers'])
      ? participation.drivers.filter(driver => typeof driver === 'string')
      : []
    return field?.['mutable'] === true && drivers.includes('director') ? [path] : []
  })
}

function stateDirectorResultSchema(
  domain: 'world' | 'characters',
  worldPaths: readonly string[],
  characterPaths: ReadonlyMap<string, readonly string[]>,
): z.ZodType<StateUpdate> {
  const worldPathSet = new Set(worldPaths)
  const characterPathSets = new Map(
    [...characterPaths].map(([actorId, paths]) => [actorId, new Set(paths)] as const),
  )
  return StateUpdateSchema.superRefine((result, context) => {
    result.mutations.forEach((mutation, index) => {
      const issue = (field: string, message: string): void => {
        context.addIssue({
          code: 'custom',
          path: ['mutations', index, field],
          message,
        })
      }
      if (domain === 'world') {
        if (mutation.scope !== 'world') issue('scope', '世界分支只能提交 scope=world')
        if (mutation.actorId !== undefined) issue('actorId', '世界分支不能填写 actorId')
        if (!worldPathSet.has(mutation.path)) {
          issue('path', `path 必须逐字复制 worldState.schema 的可变键：${worldPaths.join(', ')}`)
        }
        return
      }
      if (mutation.scope !== 'character') issue('scope', '角色分支只能提交 scope=character')
      if (mutation.actorId === undefined) {
        issue('actorId', '角色分支的每条 mutation 都必须填写 actorId')
        return
      }
      const paths = characterPathSets.get(mutation.actorId)
      if (paths === undefined) {
        issue('actorId', 'actorId 必须来自 completeCharacterRoster')
      } else if (!paths.has(mutation.path)) {
        issue('path', `path 必须逐字复制角色 ${mutation.actorId} 的 stateSchema 可变键：${[...paths].join(', ')}`)
      }
    })
    result.memoryWrites.forEach((write, index) => {
      if (domain === 'world') {
        context.addIssue({
          code: 'custom',
          path: ['memoryWrites', index],
          message: '世界分支的 memoryWrites 必须为空',
        })
      } else if (!characterPathSets.has(write.actorId)) {
        context.addIssue({
          code: 'custom',
          path: ['memoryWrites', index, 'actorId'],
          message: '记忆的 actorId 必须来自 completeCharacterRoster',
        })
      }
    })
  })
}

const ProgressAssessmentSchema = z.object({
  status: z.enum(['active', 'completed', 'failed']),
  rationale: z.string().min(8).max(2_000),
  evidence: z.array(z.string().min(3).max(800)).min(1).max(8),
})

function storyStateTool(
  domain: 'world' | 'characters',
  allowedPaths: readonly string[],
  actorIds: readonly string[] = [],
): readonly ToolSchema[] {
  const canMutate = allowedPaths.length > 0 && (domain === 'world' || actorIds.length > 0)
  const pathSchema: Record<string, unknown> = {
    type: 'string',
    description: domain === 'world'
      ? 'Copy one exact relative key from worldState.schema; never prefix it with world. or state.'
      : 'Copy one exact relative key from that actor stateSchema; never prefix it with state. or entities.',
    ...(allowedPaths.length === 0 ? {} : { enum: [...allowedPaths] }),
  }
  const mutationProperties: Record<string, unknown> = {
    scope: { type: 'string', enum: [domain === 'world' ? 'world' : 'character'] },
    ...(domain === 'characters' ? {
      actorId: { type: 'string', enum: [...actorIds] },
    } : {}),
    path: pathSchema,
    operation: { type: 'string', enum: ['set', 'increment', 'append', 'remove'] },
    value: {},
    reason: { type: 'string', minLength: 4, maxLength: 240 },
  }
  return [{
    name: 'story_propose_state_update',
    description: domain === 'world'
      ? 'Propose the complete schema-constrained world-state update for saved prose.'
      : 'Propose the complete schema-constrained character-roster update for saved prose.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mutations', 'memoryWrites'],
      properties: {
        mutations: {
          type: 'array', maxItems: canMutate ? 64 : 0,
          items: {
            type: 'object', additionalProperties: false,
            required: domain === 'world'
              ? ['scope', 'path', 'operation', 'value', 'reason']
              : ['scope', 'actorId', 'path', 'operation', 'value', 'reason'],
            properties: mutationProperties,
          },
        },
        memoryWrites: {
          type: 'array', maxItems: domain === 'world' ? 0 : 32,
          items: {
            type: 'object', additionalProperties: false,
            required: ['actorId', 'summary', 'importance'],
            properties: {
              actorId: {
                type: 'string',
                ...(domain === 'characters' ? { enum: [...actorIds] } : {}),
              },
              summary: { type: 'string', minLength: 4, maxLength: 500 },
              importance: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
  }]
}

const STORY_PROGRESS_TOOL: readonly ToolSchema[] = [{
  name: 'story_assess_progress',
  description: 'Assess the current plot point from retained authoritative events and prose.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'rationale', 'evidence'],
    properties: {
      status: { type: 'string', enum: ['active', 'completed', 'failed'] },
      rationale: { type: 'string', minLength: 8, maxLength: 2_000 },
      evidence: {
        type: 'array', minItems: 1, maxItems: 8,
        items: { type: 'string', minLength: 3, maxLength: 800 },
      },
    },
  },
}]

function choiceDirectorTools(choices: readonly ChoiceProjection[], intent: boolean): readonly ToolSchema[] {
  const choiceIds = choices.length === 0 ? ['none'] : choices.map(choice => choice.id)
  return intent ? [{
    name: 'story_propose_action',
    description: 'Interpret the player intent and propose one exact Runtime-legal action. Use null when none can honestly carry the intent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId'],
      properties: { opportunityId: { anyOf: [{ type: 'string', enum: choiceIds }, { type: 'null' }] } },
    },
  }] : [{
    name: 'story_offer_choices',
    description: 'Offer exactly three distinct, scene-aware player decisions by referencing exact Runtime-legal capability opportunities.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['choices'],
      properties: {
        choices: {
          type: 'array', minItems: 3, maxItems: 3,
          items: {
            type: 'object', additionalProperties: false,
            required: ['opportunityId', 'label', 'intent', 'storyRole'],
            properties: {
              opportunityId: { type: 'string', enum: choiceIds },
              label: { type: 'string', minLength: 1, maxLength: 64 },
              intent: { type: 'string', minLength: 4, maxLength: 240 },
              storyRole: { type: 'string', enum: ['advance', 'character', 'deviate'] },
            },
          },
        },
      },
    },
  }]
}

function jsonPayload(value: string): unknown {
  const first = value.indexOf('{')
  const last = value.lastIndexOf('}')
  if (first < 0 || last < first) throw new Error('planner returned no JSON object')
  return JSON.parse(value.slice(first, last + 1)) as unknown
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameNarrativeFrontier(
  beat: NarrativeBeat,
  actorId: TextPlayRequest['actorId'],
  sources: NarrativeSources,
  camera: string,
): boolean {
  return beat.perspectiveActorId === actorId
    && beat.camera === camera
    && sameIds(beat.eventIds, sources.events.map(event => event.id))
    && sameIds(beat.observationIds, sources.observations.map(observation => observation.id))
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function narrativeProse(blocks: readonly NarrativeBlock[]): string {
  return blocks.flatMap(block => block.type === 'narration' || block.type === 'character'
    ? [block.text]
    : []).join('')
}

function continuityShingles(value: string): ReadonlySet<string> {
  const normalized = normalizedText(value)
  const shingles = new Set<string>()
  for (const size of [3, 4] as const) {
    for (let index = 0; index + size <= normalized.length; index += 1) {
      shingles.add(normalized.slice(index, index + size))
    }
  }
  return shingles
}

/** A conservative semantic-replay gate. It only fires when a candidate reuses a substantial
 * collection of Chinese/Latin character shingles from one already presented beat. Repeating a
 * character name or place is therefore harmless; replaying the same prop, exchange and micro
 * actions together is not. */
export function narrativeContinuityRisk(
  candidate: readonly NarrativeBlock[],
  recent: readonly (readonly NarrativeBlock[])[],
): number {
  const candidateText = narrativeProse(candidate)
  const candidateTerms = continuityShingles(candidateText)
  if (candidateText.length < 48 || candidateTerms.size < 12) return 0
  let maximum = 0
  for (const previous of recent) {
    const previousText = narrativeProse(previous)
    const previousTerms = continuityShingles(previousText)
    if (previousText.length < 48 || previousTerms.size < 12) continue
    let shared = 0
    for (const term of candidateTerms) if (previousTerms.has(term)) shared += 1
    if (shared < 8) continue
    const containment = shared / Math.max(1, Math.min(candidateTerms.size, previousTerms.size))
    const exactRun = longestSharedTerm(normalizedText(candidateText), normalizedText(previousText))
    const score = Math.max(containment, exactRun >= 18 ? .72 : 0)
    maximum = Math.max(maximum, score)
  }
  return maximum
}

function longestSharedTerm(input: string, candidate: string): number {
  const shorter = input.length <= candidate.length ? input : candidate
  const longer = input.length <= candidate.length ? candidate : input
  for (let size = Math.min(12, shorter.length); size >= 2; size -= 1) {
    for (let start = 0; start + size <= shorter.length; start += 1) {
      if (longer.includes(shorter.slice(start, start + size))) return size
    }
  }
  return 0
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function gameDateTime(state: JsonObject, logicalTime: number): string {
  const calendar = projectAuthoredCalendar(state, logicalTime)
  if (calendar === undefined) {
    throw new Error('世界缺少明确的游戏历法与开场时间；拒绝使用默认日期或午夜。')
  }
  const world = object(state['world'])
  const configured = object(world?.['calendar'])
  const authoredWeek = typeof configured?.['week'] === 'number'
    ? Math.max(1, Math.floor(configured['week'])) : undefined
  const authoredWeekday = typeof configured?.['weekday'] === 'string'
    ? configured['weekday'] : undefined
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const weekdayIndex = authoredWeekday === undefined ? -1 : weekdays.indexOf(authoredWeekday)
  if (authoredWeek !== undefined && weekdayIndex >= 0) {
    const shifted = weekdayIndex + calendar.elapsedDays
    const week = authoredWeek + Math.floor(shifted / weekdays.length)
    const weekday = weekdays[((shifted % weekdays.length) + weekdays.length) % weekdays.length]
    return `第 ${String(week)} 周 · ${weekday} ${String(calendar.hour).padStart(2, '0')}:${String(calendar.minute).padStart(2, '0')}`
  }
  return `第 ${String(calendar.year)} 年 · ${calendar.season} ${String(calendar.dayOfSeason)} 日 ${String(calendar.hour).padStart(2, '0')}:${String(calendar.minute).padStart(2, '0')}`
}

const NUMERIC_CLOCK_CLAIM
  = /(?:\b(?:[01]?\d|2[0-3])\s*[:：]\s*[0-5]\d\b|[零〇一二两三四五六七八九十百\d]{1,4}\s*(?:点|时)(?:整|半|[零〇一二两三四五六七八九十百\d]{1,4}\s*分)?)/u
const CLOCK_SIGNAL_CLAIM = /(?:整点|报时|钟声|钟响|时针|分针|挂钟|墙钟|馆里的钟)/u
const DAYPART_CLAIM = /(?:凌晨|清晨|晨光|朝阳|日出|上午|正午|中午|午后|下午|黄昏|傍晚|日落|夜晚|夜里|深夜|午夜)/u

function allowedDayparts(hour: number): readonly string[] {
  if (hour < 5) return ['凌晨', '夜晚', '夜里', '深夜', '午夜']
  if (hour < 9) return ['清晨', '晨光', '朝阳', '日出', '上午']
  if (hour < 12) return ['上午']
  if (hour < 14) return ['正午', '中午', '午后']
  if (hour < 18) return ['午后', '下午']
  if (hour < 20) return ['黄昏', '傍晚', '日落']
  return ['夜晚', '夜里', '深夜']
}

function temporallyGroundedBlocks(
  blocks: readonly NarrativeBlock[],
  authoritativeDateTime: string,
  sources: NarrativeSources,
): readonly NarrativeBlock[] {
  const exactClock = authoritativeDateTime.match(/\b([01]\d|2[0-3]):[0-5]\d\b/u)?.[0]
  const hour = exactClock === undefined ? undefined : Number.parseInt(exactClock.slice(0, 2), 10)
  const clockSignalAuthorized = /(?:钟声|钟响|报时|\b(?:bell|chime|clock\.signal)\b)/iu
    .test(stableStringify([sources.events, sources.observations]))
  return blocks.flatMap((block): NarrativeBlock[] => {
    if (block.type === 'media' || block.type === 'media-intent' || block.type === 'state') return [block]
    const sentences = block.text.match(/[^。！？!?]+[。！？!?]?/gu) ?? [block.text]
    const safe = sentences.filter((sentence) => {
      if (NUMERIC_CLOCK_CLAIM.test(sentence) && (exactClock === undefined || !sentence.includes(exactClock))) {
        return false
      }
      if (CLOCK_SIGNAL_CLAIM.test(sentence) && !clockSignalAuthorized) return false
      const daypart = sentence.match(DAYPART_CLAIM)?.[0]
      return daypart === undefined || hour === undefined || allowedDayparts(hour).includes(daypart)
    }).join('').trim()
    return safe === '' ? [] : [{ ...block, text: safe }]
  })
}

function numberPath(value: JsonValue | undefined, path: readonly string[]): number | undefined {
  let current = value
  for (const key of path) current = object(current)?.[key]
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined
}

/** Models are allowed to choose prose, but not to silently erase a live disaster. When a model
 * misses every perceivable consequence, add one compact bridge from authoritative Runtime state
 * instead of letting the story contradict the status strip. */
export function environmentallyGroundedBlocks(
  blocks: readonly NarrativeBlock[],
  state: JsonObject,
  recentPresentation: readonly (readonly NarrativeBlock[])[] = [],
): readonly NarrativeBlock[] {
  const prose = narrativeText(blocks)
  const world = object(state['world'])
  const conflict = object(state['conflict'])
  const disaster = numberPath(world, ['disaster', 'stage'])
  const weather = numberPath(world, ['weather', 'severity'])
  const exposure = numberPath(world, ['hazards', 'exposureRisk'])
  const greyTide = numberPath(conflict, ['greyTide']) ?? numberPath(world, ['intel', 'greyTide'])
  const infected = numberPath(conflict, ['infectedCount'])
  const bridges: string[] = []
  if ((disaster ?? 0) >= 2 && !/(?:异变|灾变|警戒|封锁|异常|失序|险情|危险)/u.test(prose)) {
    bridges.push('灾变已经渗进这处空间，门窗外的秩序与声响都不再像平日。')
  }
  if ((greyTide ?? 0) > 0 && !/(?:灰潮|灰雾|灰尘|雾障|雾气)/u.test(prose)) {
    bridges.push('异常的灰雾压在视野边缘，让熟悉的景物显得模糊而不可靠。')
  }
  if ((infected ?? 0) > 0 && !/(?:感染者|灰骸|丧尸|尸群|嘶吼|撞门)/u.test(prose)) {
    bridges.push('远处感染者拖沓的动静迫使每个人压低声音，没人敢把这里当成普通日常。')
  }
  if ((weather ?? 0) >= 3 && !/(?:风雨|暴雨|雷|天候|乌云|狂风|雨幕)/u.test(prose)) {
    bridges.push('恶劣天候压低了光线，风雨持续敲打着周围。')
  }
  if ((exposure ?? 0) > 0 && !/(?:暴露|污染|辐射|毒气|防护|呼吸)/u.test(prose)) {
    bridges.push('空气与路径中的暴露风险限制着停留时间，呼吸也必须更加谨慎。')
  }
  const recentProse = normalizedText(recentPresentation
    .map(recent => narrativeProse(recent))
    .join('\n'))
  const recentlyGrounded = bridges.some((bridge) => {
    const normalized = normalizedText(bridge)
    return normalized.length >= 12 && recentProse.includes(normalized)
  })
  const freshBridges = recentlyGrounded ? [] : bridges
  if (freshBridges.length === 0) return blocks
  return [{ type: 'narration', text: freshBridges.slice(0, 2).join('') }, ...blocks]
}

type CharacterPresentationMode = 'dialogue' | 'thought' | 'action'

function cleanCharacterPresentation(
  actorId: EntityId,
  mode: CharacterPresentationMode,
  value: string,
): readonly NarrativeBlock[] {
  const text = value.trim().slice(0, 240)
  if (text === '') return []
  const quotePattern = /[“"「『]([^“”"「」『』]{1,180})[”"」』]/gu
  const quoted = [...text.matchAll(quotePattern)]
  const block = (nextMode: CharacterPresentationMode, nextText: string): NarrativeBlock | undefined => {
    const cleaned = nextText.trim().replace(/^[—–:：,，;；\s]+|[—–\s]+$/gu, '').slice(0, 180)
    if (cleaned === '' || !/[\p{L}\p{N}]/u.test(cleaned)) return undefined
    return { type: 'character', actorId, mode: nextMode, text: cleaned }
  }
  if (quoted.length === 0) {
    const cleaned = text.replace(/^[“"「『]+|[”"」』]+$/gu, '')
    const result = block(mode, cleaned)
    return result === undefined ? [] : [result]
  }
  if (mode !== 'action') {
    const spoken = quoted.map(match => match[1]?.trim() ?? '').filter(Boolean)
    const last = quoted.at(-1)
    const tail = last === undefined ? '' : text.slice(last.index + last[0].length)
      .replace(/[”"」』]+$/gu, '').trim()
    if (mode === 'dialogue' && /[？?!！]$/u.test(tail) && !/(?:说|问|答|道|想|看|点头|摇头)/u.test(tail)) {
      spoken.push(tail)
    }
    const result = block(mode, spoken.join(''))
    return result === undefined ? [] : [result]
  }
  const result: NarrativeBlock[] = []
  let cursor = 0
  for (const match of quoted) {
    const index = match.index
    const action = block('action', text.slice(cursor, index))
    if (action !== undefined) result.push(action)
    const dialogue = block('dialogue', match[1] ?? '')
    if (dialogue !== undefined) result.push(dialogue)
    cursor = index + match[0].length
  }
  const action = block('action', text.slice(cursor))
  if (action !== undefined) result.push(action)
  return result
}

function narrativeToolSchemas(
  frame: SceneFrame,
  stateCues: readonly NarrativeStateCue[],
): readonly ToolSchema[] {
  const actorIds = frame.presentEntityIds.length === 0 ? ['none'] : frame.presentEntityIds
  const media = frame.media.map((cue, cueIndex) => ({ cueIndex, cue }))
  const blockVariants = [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'text'],
      properties: {
        type: { type: 'string', const: 'narration' },
        text: { type: 'string', minLength: 1, maxLength: 240 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'actorId', 'mode', 'text'],
      properties: {
        type: { type: 'string', const: 'character' },
        actorId: { type: 'string', enum: actorIds },
        mode: { type: 'string', enum: ['dialogue', 'thought', 'action'] },
        text: { type: 'string', minLength: 1, maxLength: 240 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'intent'],
      properties: {
        type: { type: 'string', const: 'media-intent' },
        intent: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'purpose', 'prompt', 'fallbackText'],
          properties: {
            kind: { type: 'string', enum: ['image', 'audio'] },
            purpose: {
              type: 'string',
              enum: ['scene', 'character', 'event', 'music', 'sfx', 'voice'],
            },
            prompt: { type: 'string', minLength: 1, maxLength: 500 },
            fallbackText: { type: 'string', minLength: 1, maxLength: 180 },
          },
        },
      },
    },
    ...(media.length === 0 ? [] : [{
      type: 'object',
      additionalProperties: false,
      required: ['type', 'cueIndex'],
      properties: {
        type: { type: 'string', const: 'media' },
        cueIndex: {
          type: 'integer',
          minimum: 0,
          maximum: media.length - 1,
        },
      },
    }]),
    ...(stateCues.length === 0 ? [] : [{
      type: 'object',
      additionalProperties: false,
      required: ['type', 'stateCueIndex'],
      properties: {
        type: { type: 'string', const: 'state' },
        stateCueIndex: {
          type: 'integer',
          minimum: 0,
          maximum: stateCues.length - 1,
        },
      },
    }]),
  ]
  return [
    {
      name: 'story_present_sequence',
      description: [
        'Present the complete current story passage as one ordered sequence of 6-12 click-sized blocks.',
        'The sequence must contain narration or character text; media is optional and never replaces prose.',
        'A dialogue block contains only words actually spoken: no speaker name, quotation marks, dialogue tags, action, or thought.',
        'An action block contains only visible action and no quoted speech; a thought block contains only the inner thought and no attribution.',
        `Character blocks may only use these exact present actor ids: ${actorIds.join(', ')}.`,
        `Media blocks may only use these authorized cue indexes: ${media.length === 0 ? 'none' : stableStringify(media)}.`,
        'Before composing blocks, judge this passage on its own dramatic and sensory content. Set mediaDecision.mode to staged only when a distinct visual or auditory beat adds narrative information; set it to none when media would be repetitive, empty decoration, or unnatural. There is no opening quota, required media type, or rotation order.',
        'Do not treat the lack of a quota as a reason to default to none. In a substantial passage, any concrete and distinctive change of place, light, weather, character appearance or expression, key object or action, soundscape, music, or meaningful voice is normally a staged opportunity. Reserve none for brief connective passages, recent-media repetition, or prose with no independently stageable sensory moment.',
        'When mode is staged, choose image/audio and its purpose from the actual passage and place every media or media-intent block exactly where it belongs in the story. When mode is none, do not add media blocks. A substantial scene may naturally use several media beats, but quantity is never a target.',
        'A media-intent is a unified persisted generation marker, not post-processing metadata: kind says image/audio, purpose says how it is used, prompt is generator-ready, and fallbackText is the inline text-only rendering. Its exact shape is {"type":"media-intent","intent":{"kind":"image","purpose":"scene","prompt":"...","fallbackText":"..."}}. It may depict only facts visible from the current perspective and must not assert new world facts.',
        'Media is a paced stage direction, not decoration: use a scene image to establish space, a character image for an entrance or emotional turn, an event image for a decisive object/action, ambient SFX for the soundscape, and voice only beside that character\'s spoken line. Do not stack media blocks together or repeat the same purpose mechanically.',
        `State blocks may only use these authoritative state cue indexes: ${stateCues.length === 0 ? 'none' : stableStringify(stateCues.map((cue, stateCueIndex) => ({ stateCueIndex, cue })))}.`,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['mediaDecision', 'blocks'],
        properties: {
          mediaDecision: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'rationale'],
            properties: {
              mode: { type: 'string', enum: ['none', 'staged'] },
              rationale: {
                type: 'string',
                minLength: 1,
                maxLength: 240,
                description: 'Name the concrete sensory moment being staged, or explain why this passage has no non-repetitive stageable moment.',
              },
            },
          },
          blocks: {
            type: 'array',
            minItems: 2,
            maxItems: 16,
            items: {
              oneOf: blockVariants,
            },
          },
        },
      },
    },
  ]
}

interface NarrativePresentation {
  readonly mediaDecision: 'none' | 'staged'
  readonly blocks: readonly NarrativeBlock[]
}

function presentationToolBlocks(
  name: string,
  argumentsJson: string,
  frame: SceneFrame,
  stateCues: readonly NarrativeStateCue[],
): NarrativePresentation | undefined {
  try {
    const payload: unknown = JSON.parse(argumentsJson)
    if (name !== 'story_present_sequence') return undefined
    const value = object(payload as JsonValue)
    const mediaDecisionValue = object(value?.['mediaDecision'])
    const mediaDecision = mediaDecisionValue?.['mode']
    const rationale = typeof mediaDecisionValue?.['rationale'] === 'string'
      ? mediaDecisionValue['rationale'].trim() : ''
    if ((mediaDecision !== 'none' && mediaDecision !== 'staged') || rationale === '') {
      return undefined
    }
    const items = Array.isArray(value?.['blocks']) ? value['blocks'] : []
    const blocks: NarrativeBlock[] = []
    for (const raw of items.slice(0, 16)) {
      const item = object(raw)
      const rawType = item?.['type']
      const text = typeof item?.['text'] === 'string' ? item['text'].trim() : ''
      if (rawType === 'narration' && /[\p{L}\p{N}]/u.test(text)) {
        blocks.push({ type: 'narration', text: text.slice(0, 240) })
        continue
      }
      if (rawType === 'character') {
        const actorId = typeof item?.['actorId'] === 'string' ? item['actorId'] : ''
        const rawMode = item?.['mode']
        if (text === '' || (rawMode !== 'dialogue' && rawMode !== 'thought' && rawMode !== 'action')
          || !frame.presentEntityIds.includes(actorId as typeof frame.presentEntityIds[number])) continue
        blocks.push(...cleanCharacterPresentation(worldlineId<'entity'>(actorId), rawMode, text))
        continue
      }
      if (rawType === 'state') {
        const stateCueIndex = item?.['stateCueIndex']
        const cue = typeof stateCueIndex === 'number' && Number.isInteger(stateCueIndex)
          ? stateCues[stateCueIndex] : undefined
        if (cue !== undefined) blocks.push({ type: 'state', cue })
        continue
      }
      if (rawType === 'media-intent') {
        const intent = object(item?.['intent'])
        const kind = intent?.['kind']
        const purpose = intent?.['purpose']
        const prompt = typeof intent?.['prompt'] === 'string' ? intent['prompt'].trim() : ''
        const fallbackText = typeof intent?.['fallbackText'] === 'string'
          ? intent['fallbackText'].trim() : ''
        const acceptedPurpose = kind === 'image'
          ? purpose === 'scene' || purpose === 'character' || purpose === 'event'
            ? purpose : undefined
          : kind === 'audio'
            && (purpose === 'music' || purpose === 'sfx' || purpose === 'voice')
            ? purpose : undefined
        if ((kind === 'image' || kind === 'audio') && acceptedPurpose !== undefined
          && prompt !== '' && fallbackText !== '') {
          blocks.push({
            type: 'media-intent',
            intent: {
              kind,
              purpose: acceptedPurpose,
              prompt: prompt.slice(0, 500),
              fallbackText: fallbackText.slice(0, 180),
            },
          })
        }
        continue
      }
      if (rawType !== 'media') continue
      const cueIndex = item?.['cueIndex']
      const cue = typeof cueIndex === 'number' && Number.isInteger(cueIndex)
        ? frame.media[cueIndex] : undefined
      if (cue !== undefined) blocks.push({ type: 'media', cue })
    }
    return { mediaDecision, blocks }
  } catch {
    return undefined
  }
}

function narrativeText(blocks: readonly NarrativeBlock[]): string {
  return blocks.flatMap((block) => {
    if (block.type === 'media') return block.caption === undefined ? [] : [block.caption]
    if (block.type === 'media-intent') return [block.intent.fallbackText]
    if (block.type === 'state') {
      return [`${block.cue.label}：${block.cue.before === undefined
        ? block.cue.value : `${block.cue.before} → ${block.cue.value}`}`]
    }
    return [block.text]
  }).join('\n\n').trim()
}

/** Future hard-time intervention bodies belong exclusively to Runtime. Story models receive the
 * dramatic contract, but only see an intervention after Runtime emits its authoritative event. */
function modelVisibleScript(script: ScriptProgressView): JsonObject {
  const visiblePoint = (point: ScriptProgressView['current']): JsonObject | undefined => {
    if (point === undefined) return undefined
    const { interventions: _interventions, ...visibleTiming } = point.timing
    return { ...point, timing: visibleTiming } as unknown as JsonObject
  }
  return {
    completed: script.completed.map(point => visiblePoint(point) as JsonObject),
    ...(script.current === undefined ? {} : { current: visiblePoint(script.current) as JsonObject }),
    ...(script.currentProgress === undefined
      ? {}
      : { currentProgress: script.currentProgress as unknown as JsonObject }),
    suggestedActorIds: [...script.suggestedActorIds],
    remaining: script.remaining,
  }
}

function boundedStoryBlocks(
  blocks: readonly NarrativeBlock[],
  maximumCharacters: number,
): readonly NarrativeBlock[] {
  const result: NarrativeBlock[] = []
  let remaining = maximumCharacters
  for (const block of blocks) {
    if (block.type === 'media') {
      const cost = block.caption?.length ?? 0
      if (cost <= remaining) {
        result.push(block)
        remaining -= cost
      }
      continue
    }
    if (block.type === 'media-intent') {
      const fallbackText = block.intent.fallbackText.slice(0, remaining).trim()
      if (fallbackText !== '') {
        result.push({ ...block, intent: { ...block.intent, fallbackText } })
        remaining -= fallbackText.length
      }
      continue
    }
    if (block.type === 'state') {
      const cost = `${block.cue.label}：${block.cue.before === undefined
        ? block.cue.value : `${block.cue.before} → ${block.cue.value}`}`.length
      if (cost <= remaining) {
        result.push(block)
        remaining -= cost
      }
      continue
    }
    if (remaining <= 0) break
    const text = block.text.slice(0, remaining).trim()
    if (text !== '') result.push({ ...block, text })
    remaining -= text.length
  }
  return result
}

function groundedStoryChoice(
  choice: ChoiceProjection,
  frame: SceneFrame,
  actorId: string,
): boolean {
  if (!/(?:talk|speak|ask|dialog|social|bond)/iu.test(choice.actionType)) return true
  return choice.targetIds.some(targetId => targetId !== actorId
    && frame.presentEntityIds.some(presentId => presentId === targetId))
}

function subset(value: JsonObject | undefined, keys: readonly string[]): JsonObject {
  if (value === undefined) return {}
  return Object.fromEntries(keys.flatMap(key => value[key] === undefined ? [] : [[key, value[key]]]))
}

function valueAtPath(value: JsonObject | undefined, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const key of path.split('.')) current = object(current)?.[key]
  return current
}

/** Keep every authored state field visible to creative stages without admitting undeclared state. */
function schemaStateProjection(entity: JsonObject | undefined): JsonObject {
  const facets = object(entity?.['facets'])
  const schema = object(facets?.['stateSchema'])
  const state = object(entity?.['state'])
  if (schema === undefined || state === undefined) return {}
  return Object.fromEntries(Object.keys(schema).slice(0, 64).flatMap((path) => {
    const value = valueAtPath(state, path)
    return value === undefined ? [] : [[path, boundedMemory(value)]]
  }))
}

function stateBandMatches(value: JsonValue, band: JsonObject): boolean {
  if (band['equals'] !== undefined && stableStringify(band['equals']) !== stableStringify(value)) return false
  if (typeof value === 'number') {
    if (typeof band['min'] === 'number' && value < band['min']) return false
    if (typeof band['max'] === 'number' && value > band['max']) return false
  }
  return band['equals'] !== undefined || typeof band['min'] === 'number' || typeof band['max'] === 'number'
}

function stateSemantics(schema: JsonObject | undefined, state: JsonObject | undefined): JsonObject {
  if (schema === undefined || state === undefined) return {}
  return Object.fromEntries(Object.entries(schema).slice(0, 64).flatMap(([path, rawField]) => {
    const field = object(rawField)
    const value = valueAtPath(state, path)
    if (field === undefined || value === undefined) return []
    const participation = object(field['participation'])
    const bands: JsonObject[] = Array.isArray(participation?.['bands'])
      ? participation['bands'].map(item => object(item))
        .filter((item): item is JsonObject => item !== undefined)
      : []
    const activeBand = bands.find(band => stateBandMatches(value, band))
    return [[path, {
      value: boundedMemory(value),
      label: field['label'] ?? path,
      mutableByDirector: field['mutable'] === true,
      drivers: participation?.['drivers'] ?? [],
      meaning: participation?.['meaning'] ?? null,
      narrativeInfluence: activeBand?.['narrative'] ?? participation?.['narrative'] ?? null,
      choiceInfluence: activeBand?.['choices'] ?? participation?.['choices'] ?? null,
      ...(activeBand === undefined ? {} : {
        currentBand: {
          label: activeBand['label'] ?? null,
          tone: activeBand['tone'] ?? null,
        },
      }),
    } satisfies JsonObject]]
  }))
}

function entityStateSemantics(entity: JsonObject | undefined): JsonObject {
  const facets = object(entity?.['facets'])
  return stateSemantics(object(facets?.['stateSchema']), object(entity?.['state']))
}

function boundedMemory(value: JsonValue | undefined, depth = 0): JsonValue {
  if (depth >= 5) return typeof value === 'string' ? value.slice(0, 2_000) : null
  if (Array.isArray(value)) {
    return value.slice(-NARRATOR_RECENT_MEMORIES).map(item => boundedMemory(item, depth + 1))
  }
  const source = object(value)
  if (source === undefined) return typeof value === 'string' ? value.slice(0, 2_000) : value ?? null
  return Object.fromEntries(Object.entries(source).slice(0, 64)
    .map(([key, item]) => [key, boundedMemory(item, depth + 1)]))
}

function mediaSource(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  const entry = object(value)
  for (const key of ['path', 'src', 'url'] as const) {
    const source = entry?.[key]
    if (typeof source === 'string' && source.trim() !== '') return source.trim()
  }
  return undefined
}

function variantKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/gu, '')
}

function runtimeVisualVariants(actor: JsonObject): readonly string[] {
  const state = object(actor['state'])
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

function expressionSource(expressions: JsonObject | undefined, actor: JsonObject): string | undefined {
  if (expressions === undefined) return undefined
  const entries = Object.entries(expressions)
  for (const candidate of runtimeVisualVariants(actor)) {
    const direct = mediaSource(expressions[candidate])
    if (direct !== undefined) return direct
    const normalized = variantKey(candidate)
    const matching = entries.find(([key]) => variantKey(key) === normalized)
    const source = mediaSource(matching?.[1])
    if (source !== undefined) return source
  }
  return mediaSource(expressions['default'])
}

function sceneMedia(
  actorId: TextPlayRequest['actorId'],
  entities: JsonObject | undefined,
  presentEntityIds: readonly EntityId[],
  background: string | undefined,
): readonly MediaCue[] {
  return [
    ...(background === undefined ? [] : [{ type: 'background', variant: background } as const]),
    ...presentEntityIds.flatMap((entityId) => {
      const entity = object(entities?.[entityId])
      if (entity === undefined) return []
      const facets = object(entity['facets'])
      const resources = object(facets?.['resources']) ?? object(facets?.['resourceIndex'])
      const visual = object(resources?.['visual']) ?? object(resources?.['art'])
      const audio = object(resources?.['audio'])
      const expressions = object(visual?.['expressions'])
      const portrait = expressionSource(expressions, entity)
        ?? mediaSource(visual?.['expression'])
        ?? mediaSource(visual?.['portrait'])
        ?? mediaSource(resources?.['portrait'])
      const bgm = entityId === actorId
        ? mediaSource(audio?.['theme']) ?? mediaSource(resources?.['theme'])
        : undefined
      const voice = mediaSource(audio?.['voice']) ?? mediaSource(resources?.['voice'])
      return [
        ...(bgm === undefined ? [] : [{ type: 'bgm', entityId, variant: bgm } as const]),
        ...(portrait === undefined ? [] : [{ type: 'expression', entityId, variant: portrait } as const]),
        ...(voice === undefined ? [] : [{ type: 'voice', entityId, variant: voice } as const]),
      ]
    }),
  ]
}

/** Text-play projection. It can phrase retained facts but has no world mutation primitive of its own. */
export default class WorldlineNarrative extends TypertRemoteService {
  static inject = ['worldlineRuns', 'worldlineAi', 'llm', 'tokenMeter']

  private readonly renderers = new Map<string, StoryStageRenderer>()
  constructor(private readonly context: Context) {
    super(context, 'worldlineNarrative')
  }

  /** Perform register renderer through the package's public contract.
   * @param renderer - The renderer supplied by the caller.
   * @returns The result produced by the operation.
   */
  registerRenderer(renderer: StoryStageRenderer): () => void {
    const effect = this.context.effect(function* (this: WorldlineNarrative) {
      if (this.renderers.has(renderer.id)) throw new Error(`StoryStage renderer already exists: ${renderer.id}`)
      this.renderers.set(renderer.id, renderer)
      yield () => { this.renderers.delete(renderer.id) }
    }.bind(this), 'worldlineNarrative.registerRenderer()')
    return () => void effect()
  }

  /** Return the current text-play scene.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('scene')
  async scene(request: TextPlayRequest): Promise<SceneFrame> {
    const [view, spatial] = await Promise.all([
      this.context.worldlineRuns.view({ runId: request.runId }),
      this.context.worldlineRuns.spatial({ runId: request.runId }),
    ])
    const entities = object(view.snapshot.state['entities'])
    const actor = object(entities?.[request.actorId])
    if (actor === undefined) throw new Error(`unknown actor: ${request.actorId}`)
    const actorState = object(actor['state']) ?? {}
    if (typeof actorState['locationId'] !== 'string' || actorState['locationId'].trim() === '') {
      throw new Error(`角色 ${request.actorId} 没有明确的初始地点；拒绝猜测默认场景。`)
    }
    const place = worldlineId<'map-node'>(actorState['locationId'])
    const placeNode = spatial.map?.nodes.find(node => node.id === place)
    if (placeNode === undefined) {
      throw new Error(`角色 ${request.actorId} 的地点 ${place} 不存在于运行地图；拒绝猜测默认场景。`)
    }
    const presentEntityIds = Object.entries(entities ?? {}).flatMap(([id, value]) => {
      const state = object(object(value)?.['state'])
      return state?.['locationId'] === place
        ? [worldlineId<'entity'>(id)]
        : []
    })
    const present = Object.fromEntries(presentEntityIds.map((id) => {
      const entity = object(entities?.[id])
      const state = object(entity?.['state'])
      return [id, {
        type: entity?.['type'] ?? 'entity',
        locationId: state?.['locationId'] ?? null,
        lod: entity?.['lod'] ?? 'L0',
      }]
    }))
    const visibleIds = new Set(presentEntityIds)
    const media = sceneMedia(request.actorId, entities, presentEntityIds, placeNode.background)
    return {
      logicalTime: view.snapshot.logicalTime,
      placeId: place,
      presentEntityIds,
      visibleState: {
        self: { id: request.actorId, type: actor['type'] ?? 'entity', state: actorState },
        present,
        environment: { gameDateTime: gameDateTime(view.snapshot.state, view.snapshot.logicalTime) },
        world: boundedMemory(view.snapshot.state['world']),
        conflict: boundedMemory(view.snapshot.state['conflict']),
        place: {
          id: place,
          name: placeNode.name,
          ...(placeNode.background === undefined ? {} : { background: placeNode.background }),
        },
      },
      activeProcesses: view.snapshot.processes.filter(process => (
        process.state !== 'completed' && process.state !== 'failed' && process.state !== 'cancelled'
        && (process.action.actorId === request.actorId || visibleIds.has(process.action.actorId))
      )).slice(-12),
      media,
    }
  }

  /** Open a text-play session for a Run and actor.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('open')
  async open(request: TextPlayRequest): Promise<TextPlayView> {
    const [run, frame, choices, beatsPage, saves] = await Promise.all([
      this.context.worldlineRuns.view({ runId: request.runId }),
      this.scene(request),
      this.context.worldlineRuns.choices(request),
      this.context.worldlineRuns.records({
        runId: request.runId,
        stream: 'narrative-beat',
        limit: 200,
        tail: true,
      }),
      this.context.worldlineRuns.checkpoints({ runId: request.runId }),
    ])
    const script = await this.scriptProgress(request.runId)
    return {
      run,
      frame,
      choices,
      // A perspective controls what may be authored at that moment; it must not erase already
      // presented chapters when the script hands focus to another character. The retained stream
      // is the reader's unified story history, while narrator context below remains perspective-
      // filtered to prevent a new viewpoint from receiving hidden state as prompt material.
      beats: beatsPage.records.map(item => item.payload as unknown as NarrativeBeat),
      saves,
      script,
    }
  }

  /** Produce the next narration from authoritative Run records.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('narrate')
  async narrate(request: NarrateRequest): Promise<NarrativeBeat> {
    let beat: NarrativeBeat | undefined
    for await (const chunk of this.narrateStream(request)) {
      if (chunk.type === 'beat') beat = chunk.beat
    }
    if (beat === undefined) throw new Error('narrative stream ended without a retained beat')
    return beat
  }

  /** Perform narrate stream through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  async *narrateStream(request: NarrateRequest): AsyncIterable<NarrativeStreamChunk> {
    yield { type: 'phase', phase: 'context' }
    const frame = await this.scene(request)
    // Read causal records after the scene/view barrier. This prevents a narration request from
    // racing the worker commit that completed the action it is meant to portray.
    const sources = await this.sources(request)
    const stateCues = authoritativeStateCues(sources)
    const script = await this.scriptProgress(request.runId)
    const camera = request.camera ?? 'limited-third-person'
    const retained = await this.context.worldlineRuns.records({
      runId: request.runId,
      stream: 'narrative-beat',
      limit: 200,
      tail: true,
    })
    const existing = retained.records.map(item => item.payload as unknown as NarrativeBeat)
      .findLast(beat => sameNarrativeFrontier(beat, request.actorId, sources, camera))
    if (existing !== undefined) {
      yield { type: 'phase', phase: 'world-state' }
      await this.commitStoryTurn(request, frame, sources, script, existing)
      for (const cue of existing.media) yield { type: 'media', cue }
      yield { type: 'replace', text: existing.text }
      yield { type: 'phase', phase: 'complete' }
      yield { type: 'beat', beat: existing }
      return
    }
    try {
      const preparation = await this.narratorPack(request, frame, sources, script)
      let pack = preparation.pack
      for (const cue of frame.media) yield { type: 'media', cue }
      for (let attempt = 0; attempt < NARRATOR_MAX_CONTINUITY_ATTEMPTS; attempt += 1) {
        yield { type: 'phase', phase: 'narrative' }
        let invocationId: NarrativeBeat['invocationId'] | undefined
        let route = pack.model
        let invocationOutput = ''
        const toolBlocks: NarrativeBlock[] = []
        let mediaDecision: NarrativePresentation['mediaDecision'] | undefined
        for await (const chunk of this.context.worldlineAi.streamText({
          runId: request.runId,
          actorId: request.actorId,
          purpose: 'narrator',
          contextPack: pack,
          tools: narrativeToolSchemas(frame, stateCues),
          maxCharacters: NARRATOR_MAX_CHARACTERS,
        })) {
          if (chunk.type === 'finish') {
            invocationId = chunk.invocation.id
            route = chunk.invocation.modelRoute
            invocationOutput = chunk.output
          }
          if (chunk.type === 'retry') {
            yield { ...chunk, phase: 'narrative' }
          }
          if (chunk.type === 'tool-call' && toolBlocks.length < 16) {
            const next = presentationToolBlocks(chunk.name, chunk.arguments, frame, stateCues)
            if (next !== undefined) {
              mediaDecision = next.mediaDecision
              toolBlocks.push(...next.blocks.slice(0, 16 - toolBlocks.length))
            }
          }
        }
        const boundedToolBlocks = boundedStoryBlocks(toolBlocks, NARRATOR_MAX_CHARACTERS)
        const toolHasProse = boundedToolBlocks.some(block => block.type === 'narration'
            || block.type === 'character')
        const authoritativeDateTime = object(frame.visibleState['environment'])?.['gameDateTime']
        const blocks = environmentallyGroundedBlocks(temporallyGroundedBlocks(
          boundedToolBlocks,
          typeof authoritativeDateTime === 'string' ? authoritativeDateTime : '',
          sources,
        ), frame.visibleState, preparation.recentPresentation)
        const retainedText = narrativeText(blocks)
        const auditText = invocationOutput
        const hasProse = blocks.some(block => (block.type === 'narration'
            || block.type === 'character') && block.text.trim() !== '')
        if (invocationId === undefined || retainedText === ''
            || auditText === '' || mediaDecision === undefined || !toolHasProse || !hasProse) {
          throw new Error('叙事模型没有返回可保存的小说正文。')
        }
        const hasMedia = blocks.some(block => block.type === 'media'
          || block.type === 'media-intent')
        if ((mediaDecision === 'staged') !== hasMedia) {
          if (attempt + 1 >= NARRATOR_MAX_CONTINUITY_ATTEMPTS) {
            throw new Error('本段的多模态判断与正文演出不一致；候选已拒绝保存。')
          }
          pack = this.structuredRetryPack(pack, 'story_present_sequence', new Error(
            mediaDecision === 'staged'
              ? 'mediaDecision 选择 staged 时，blocks 必须在自然的正文位置至少包含一个 media 或 media-intent。'
              : 'mediaDecision 选择 none 时，blocks 不得包含 media 或 media-intent；若确实适合演出，请把 mode 改为 staged。',
          ))
          yield { type: 'replace', text: '' }
          continue
        }
        const continuityRisk = narrativeContinuityRisk(blocks, preparation.recentPresentation)
        if (continuityRisk >= .22) {
          if (attempt + 1 >= NARRATOR_MAX_CONTINUITY_ATTEMPTS) {
            throw new Error('连续性校验仍检测到剧情重演；本段已拒绝保存，请重新尝试。')
          }
          pack = this.continuityRepairPack(pack, blocks)
          yield { type: 'replace', text: '' }
          continue
        }
        for (const block of blocks) {
          if (block.type === 'narration' || block.type === 'character') {
            yield { type: 'text-delta', text: `${block.text}\n\n` }
          }
        }
        yield { type: 'replace', text: retainedText }
        const retainedSourceIds = new Set(preparation.pack.sections
          .flatMap(section => section.sourceIds))
        const recorded = await this.context.worldlineRuns.recordNarrativeBeat({
          runId: request.runId,
          invocationId,
          perspectiveActorId: request.actorId,
          eventIds: sources.events.map(event => event.id).filter(id => retainedSourceIds.has(id)),
          observationIds: sources.observations.map(observation => observation.id)
            .filter(id => retainedSourceIds.has(id)),
          camera,
          modelOutput: auditText,
          text: retainedText,
          blocks,
          media: frame.media,
          modelRoute: route,
        })
        yield { type: 'phase', phase: 'world-state' }
        await this.commitStoryTurn(request, frame, sources, script, recorded.beat)
        yield { type: 'phase', phase: 'complete' }
        yield { type: 'beat', beat: recorded.beat }
        return
      }
      throw new Error('叙事模型未能生成通过连续性校验的正文。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`无法使用世界线 LLM 推演本段小说：${message}`, { cause: error })
    }
  }

  /** Generate exactly three scene-specific choices after the latest story beat is fully presented.
   * @param request - The active Run, actor, and camera selection.
   * @returns Three creative plans grounded in current Runtime-legal opportunities.
   */
  @Remote('suggest')
  async suggest(request: TextPlayRequest): Promise<StoryChoiceSuggestions> {
    const [frame, projected, view, beatsPage] = await Promise.all([
      this.scene(request),
      this.context.worldlineRuns.choices(request),
      this.context.worldlineRuns.view({ runId: request.runId }),
      this.context.worldlineRuns.records({
        runId: request.runId,
        stream: 'narrative-beat',
        limit: 1,
        tail: true,
      }),
    ])
    const latestBeat = beatsPage.records[0]?.payload as unknown as NarrativeBeat | undefined
    if (latestBeat === undefined) throw new Error('当前故事还没有可生成行动的正文。')
    const retained = view.snapshot.actionDecks[request.actorId]
    if (retained?.sequence === projected.sequence && retained.afterBeatId === latestBeat.id) {
      return {
        sequence: retained.sequence,
        afterBeatId: retained.afterBeatId,
        suggestions: retained.plans,
      }
    }
    const script = await this.scriptProgress(request.runId)
    if (view.snapshot.storyStateCommits[latestBeat.id] === undefined) {
      const sources = await this.sources(request)
      await this.commitStoryTurn(request, frame, sources, script, latestBeat)
      // Re-enter through the public projection boundary so any committed soft state can
      // change available capabilities before the choice director sees them.
      return this.suggest(request)
    }
    const groundedChoices = projected.choices.filter(choice => (
      groundedStoryChoice(choice, frame, request.actorId)
    ))
    if (groundedChoices.length === 0) throw new Error('当前世界状态没有可承载行动计划的能力。')
    const pack = await this.choicePlannerPack(request, frame, groundedChoices, script)
    const generated = await this.creativeStructured(
      request,
      pack,
      choiceDirectorTools(groundedChoices, false),
      'story_offer_choices',
      ChoicePlanSchema,
    )
    const parsed = generated.value
    const legal = new Set(groundedChoices.map(choice => choice.id))
    const result = await this.context.worldlineRuns.recordActionDeck({
      runId: request.runId,
      actorId: request.actorId,
      expectedSequence: projected.sequence,
      afterBeatId: latestBeat.id,
      invocationId: generated.invocationId,
      plans: parsed.choices.map(item => ({
        opportunityId: legal.has(item.opportunityId) ? item.opportunityId : '',
        label: item.label.trim().replace(/^[\d一二三四五六七八九十]+[.、)）]\s*/u, ''),
        intent: item.intent.trim(),
        storyRole: item.storyRole,
      })),
    })
    return {
      sequence: result.deck.sequence,
      afterBeatId: result.deck.afterBeatId,
      suggestions: result.deck.plans,
    }
  }

  /** Submit one listed text-play choice.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('choose')
  async choose(request: ChooseTextActionRequest): Promise<SubmitRunActionResult> {
    const view = await this.context.worldlineRuns.view({ runId: request.runId })
    if (view.snapshot.sequence !== request.expectedSequence) throw new Error('行动选项已经变化，请刷新当前场景。')
    const deck = view.snapshot.actionDecks[request.actorId]
    const plan = deck?.sequence === request.expectedSequence
      ? deck.plans.find(item => item.id === request.planId)
      : undefined
    if (plan === undefined) throw new Error('这个行动计划不属于当前故事阶段。')
    await this.context.worldlineRuns.setControl({
      runId: request.runId,
      actorId: request.actorId,
      mode: 'player',
    })
    return this.context.worldlineRuns.submitAction({
      runId: request.runId,
      actorId: request.actorId,
      type: plan.capabilityId,
      parameters: plan.parameters,
      expectedSequence: request.expectedSequence,
      controller: 'player',
    })
  }

  /** Perform free input through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('freeInput')
  async freeInput(request: FreeTextActionRequest): Promise<FreeTextActionResult> {
    const text = request.text.trim()
    const [frame, projected] = await Promise.all([
      this.scene(request),
      this.context.worldlineRuns.choices(request),
    ])
    if (projected.sequence !== request.expectedSequence) {
      throw new Error('行动选项已经变化，请刷新当前场景。')
    }
    const groundedChoices = projected.choices.filter(choice => (
      groundedStoryChoice(choice, frame, request.actorId)
    ))
    if (groundedChoices.length === 0) return { status: 'unmatched', candidates: [] }
    const script = await this.scriptProgress(request.runId)
    const pack = await this.choicePlannerPack(request, frame, groundedChoices, script, text)
    const generated = await this.creativeStructured(
      request,
      pack,
      choiceDirectorTools(groundedChoices, true),
      'story_propose_action',
      IntentPlanSchema,
    )
    const planned = generated.value
    const candidate = groundedChoices.find(choice => choice.id === planned.opportunityId)
    if (candidate === undefined) return { status: 'unmatched', candidates: [] }
    await this.context.worldlineRuns.setControl({
      runId: request.runId,
      actorId: request.actorId,
      mode: 'player',
    })
    const action = await this.context.worldlineRuns.submitAction({
      runId: request.runId,
      actorId: request.actorId,
      type: candidate.actionType,
      parameters: { ...candidate.parameters, storyIntent: text },
      expectedSequence: request.expectedSequence,
      controller: 'player',
    })
    return { status: 'submitted', candidates: [candidate], action }
  }

  /** Rephrase presentation text without changing Run state.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('rephrase')
  async rephrase(request: RephraseRequest): Promise<NarrativeBeat> {
    const records = await this.context.worldlineRuns.records({
      runId: request.runId,
      stream: 'narrative-beat',
      limit: 5000,
    })
    const beat = records.records.map(item => item.payload as unknown as NarrativeBeat)
      .find(item => item.id === request.beatId)
    if (beat === undefined) throw new Error('narrative beat was not found')
    return this.narrate({
      ...request,
      eventIds: beat.eventIds,
      observationIds: beat.observationIds,
      camera: request.camera ?? beat.camera,
    })
  }

  /** Save the current text-play scene as a checkpoint.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('save')
  save(request: SaveTextPlayRequest): Promise<CheckpointView> {
    return this.context.worldlineRuns.checkpoint({ runId: request.runId, label: request.label })
  }

  /** Branch text play from a saved checkpoint.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('branch')
  branch(request: BranchTextPlayRequest): Promise<RunView> {
    return this.context.worldlineRuns.branch({
      runId: request.runId,
      checkpointId: request.checkpointId,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    })
  }

  /** Retry narration from the latest authoritative Run state.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('retry')
  async retry(request: RetryTextActionRequest): Promise<SubmitRunActionResult> {
    const checkpoints = await this.context.worldlineRuns.checkpoints({ runId: request.runId })
    const selectedSave = checkpoints.find(item => item.checkpoint.id === request.checkpointId)
    const deck = selectedSave?.checkpoint.snapshot.actionDecks[request.actorId]
    const plan = deck?.plans.find(item => item.id === request.planId)
    if (plan === undefined) throw new Error('retry action plan is not retained by the selected save')
    const branch = await this.branch(request)
    await this.context.worldlineRuns.setControl({
      runId: branch.summary.runId,
      actorId: request.actorId,
      mode: 'player',
    })
    // A normal branch deliberately drops parent-owned presentation indexes and action
    // decks. Retry validates the requested plan against the selected immutable save,
    // then submits those already-grounded executable fields into the clean branch.
    return this.context.worldlineRuns.submitAction({
      runId: branch.summary.runId,
      actorId: request.actorId,
      type: plan.capabilityId,
      parameters: plan.parameters,
      expectedSequence: branch.snapshot.sequence,
      controller: 'player',
    })
  }

  /** Perform story stage through the package's public contract.
   * @returns The result produced by the operation.
   */
  @Remote('storyStage')
  storyStage(): StoryStageStatus {
    const renderers = [{
      id: 'worldline-text-story',
      name: '内置视觉演绎器',
      capabilities: [
        'background', 'portrait', 'expression', 'bgm', 'sfx', 'voice', 'transition',
      ] as readonly string[],
    }, ...[...this.renderers.values()].map(renderer => ({
      id: renderer.id,
      name: renderer.name,
      capabilities: [...renderer.capabilities],
    }))]
    return {
      available: true,
      renderers,
      message: this.renderers.size === 0
        ? '视觉演绎已就绪：世界事实、角色对话、自由行动、立绘与音频共用同一条世界线。'
        : '视觉演绎与扩展演出资源均已就绪。',
    }
  }

  private async sources(request: NarrateRequest): Promise<NarrativeSources> {
    const [eventPage, observationPage] = await Promise.all([
      this.context.worldlineRuns.records({
        runId: request.runId,
        stream: 'world-event',
        limit: 200,
        tail: true,
      }),
      this.context.worldlineRuns.records({
        runId: request.runId,
        stream: 'observation',
        limit: 200,
        tail: true,
      }),
    ])
    const requestedEvents = request.eventIds === undefined ? undefined : new Set(request.eventIds)
    const requestedObservations = request.observationIds === undefined
      ? undefined
      : new Set(request.observationIds)
    const visibleEvents = eventPage.records.map(item => item.payload as unknown as WorldEvent)
      .filter(event => (requestedEvents?.has(event.id)
        ?? (event.visibleTo.includes(request.actorId) || event.participantIds.includes(request.actorId)))
        && (request.actionId === undefined || event.actionId === request.actionId
          || event.type === 'story.intervention' || event.type === 'story.deadline'))
    const latestCompletion = requestedEvents === undefined
      ? visibleEvents.findLast(event => event.actorId === request.actorId && event.type === 'action.completed')
      : undefined
    const turnStart = latestCompletion === undefined ? undefined : visibleEvents.find(event => (
      event.actionId === latestCompletion.actionId
    ))?.sequence
    const turnEnd = latestCompletion?.sequence
    const events = (turnStart === undefined
      ? visibleEvents
      : visibleEvents.filter(event => event.sequence >= turnStart
        && (turnEnd === undefined || event.sequence <= turnEnd))).slice(-12)
    const eventIds = new Set(events.map(event => event.id))
    const observations = observationPage.records.map(item => item.payload as unknown as Observation)
      .filter(observation => observation.observerId === request.actorId
        && (requestedObservations?.has(observation.id)
          ?? (eventIds.size === 0 || eventIds.has(observation.eventId))))
      .slice(-16)
    return { events, observations }
  }

  private async scriptProgress(
    runId: TextPlayRequest['runId'],
  ): Promise<ScriptProgressView> {
    const [definition, view] = await Promise.all([
      this.context.worldlineRuns.definition({ runId }),
      this.context.worldlineRuns.view({ runId }),
    ])
    const entities = object(view.snapshot.state['entities'])
    const characterNames = new Map<TextPlayRequest['actorId'], string>()
    for (const [id, value] of Object.entries(entities ?? {})) {
      const entity = object(value)
      const facets = object(entity?.['facets'])
      if (entity?.['type'] !== 'character' || typeof facets?.['displayName'] !== 'string') continue
      characterNames.set(worldlineId<'entity'>(id), facets['displayName'])
    }
    const pointActorIds = (
      point: ScriptProgressView['current'],
    ): readonly TextPlayRequest['actorId'][] => {
      if (point === undefined) return []
      const authoredText = [
        point.name,
        point.summary,
        point.entryCondition,
        point.completionCriteria,
        point.dramaticPressure,
        point.successOutcome,
        point.failureOutcome,
        point.recoveryHook,
      ].join('\n')
      return [...characterNames].filter(([, name]) => authoredText.includes(name)).map(([id]) => id)
    }
    const points = [...definition.plotPoints]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    const completedCount = points.findIndex(point => (
      view.snapshot.storyProgress[point.id]?.status !== 'completed'
    ))
    const completed = completedCount < 0 ? points : points.slice(0, completedCount)
    const current = completedCount < 0 ? undefined : points[completedCount]
    const suggestedActorIds = pointActorIds(current)
    const currentProgress = current === undefined ? undefined : view.snapshot.storyProgress[current.id]
    return {
      completed,
      ...(current === undefined ? {} : { current }),
      ...(currentProgress === undefined ? {} : { currentProgress }),
      suggestedActorIds,
      remaining: Math.max(0, points.length - completed.length),
    }
  }

  private async creativeJson(
    request: TextPlayRequest,
    pack: ContextPack,
    tools: readonly ToolSchema[],
    expectedTool: string,
  ): Promise<{ readonly text: string; readonly invocationId: ActionDeck['invocationId'] }> {
    let output = ''
    let toolOutput = ''
    let completed = false
    let invocationId: ActionDeck['invocationId'] | undefined
    for await (const chunk of this.context.worldlineAi.streamText({
      runId: request.runId,
      actorId: request.actorId,
      purpose: 'creative',
      contextPack: pack,
      temperature: 0.25,
      maxCharacters: CHOICE_PLANNER_MAX_CHARACTERS,
      tools,
    })) {
      if (chunk.type === 'text-delta') output += chunk.text
      if (chunk.type === 'tool-call' && chunk.name === expectedTool) toolOutput = chunk.arguments
      if (chunk.type === 'finish') {
        completed = true
        invocationId = chunk.invocation.id
      }
    }
    const result = toolOutput.trim() === '' ? output : toolOutput
    if (!completed || invocationId === undefined || result.trim() === '') {
      throw new Error(`creative stage produced no usable ${expectedTool} tool call`)
    }
    return { text: result, invocationId }
  }

  private structuredRetryPack(
    pack: ContextPack,
    expectedTool: string,
    error: unknown,
  ): ContextPack {
    const detail = error instanceof Error ? error.message : String(error)
    const text = [
      `上一次 ${expectedTool} 工具参数未通过 JSON 与结构校验：${detail}`,
      `请重新调用 ${expectedTool}，严格遵守工具 schema；只提交完整工具参数，不要输出解释或 Markdown。`,
    ].join('\n')
    const correction: ContextPackSection = {
      kind: 'constraints',
      text,
      tokens: this.tokens(text),
      sourceIds: [`runtime:${expectedTool}:structure-retry`],
      priority: 101,
    }
    let remaining = Math.max(0, pack.inputLimit - correction.tokens)
    const sections: ContextPackSection[] = [correction]
    const droppedSourceIds = [...pack.droppedSourceIds]
    for (const section of pack.sections) {
      if (remaining <= 0) {
        droppedSourceIds.push(...section.sourceIds)
        continue
      }
      if (section.tokens <= remaining) {
        sections.push(section)
        remaining -= section.tokens
        continue
      }
      const retainedText = this.trim(section.text, remaining)
      const retainedTokens = retainedText === '' ? 0 : this.tokens(retainedText)
      if (retainedTokens > 0) sections.push({ ...section, text: retainedText, tokens: retainedTokens })
      droppedSourceIds.push(...section.sourceIds)
      remaining -= retainedTokens
    }
    const retried: ContextPack = {
      ...pack,
      sections,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
      droppedSourceIds: [...new Set(droppedSourceIds)],
    }
    validateContextPack(retried)
    return retried
  }

  private async creativeStructured<T>(
    request: TextPlayRequest,
    pack: ContextPack,
    tools: readonly ToolSchema[],
    expectedTool: string,
    schema: z.ZodType<T>,
  ): Promise<{ readonly value: T; readonly invocationId: ActionDeck['invocationId'] }> {
    let attemptPack = pack
    let lastError: unknown
    for (let attempt = 0; attempt < CREATIVE_STRUCTURE_ATTEMPTS; attempt += 1) {
      try {
        const generated = await this.creativeJson(request, attemptPack, tools, expectedTool)
        return {
          value: schema.parse(jsonPayload(generated.text)),
          invocationId: generated.invocationId,
        }
      } catch (error) {
        lastError = error
        if (attempt + 1 < CREATIVE_STRUCTURE_ATTEMPTS) {
          attemptPack = this.structuredRetryPack(pack, expectedTool, error)
        }
      }
    }
    throw new Error(`${expectedTool} 连续两次返回了无效的结构化参数。`, { cause: lastError })
  }

  /** Run the state-director stage after prose and before any player choices are generated. */
  private async commitStoryTurn(
    request: TextPlayRequest,
    frame: SceneFrame,
    sources: NarrativeSources,
    script: ScriptProgressView,
    beat: NarrativeBeat,
  ): Promise<StoryProgressEvidence | undefined> {
    const view = await this.context.worldlineRuns.view({ runId: request.runId })
    const retainedCommit = view.snapshot.storyStateCommits[beat.id]
    if (retainedCommit !== undefined) {
      return Object.values(view.snapshot.storyProgress).find(item => item.beatId === beat.id)
    }
    const point = script.current
    const route = view.snapshot.modelPolicy.routes.creative
      ?? view.snapshot.modelPolicy.routes.narrator
    if (route === undefined) throw new Error('no creative model is configured for the state director')
    const model = await this.context.llm.resolveModelInfo(route.provider, route.model)
    const contextWindow = model.context?.contextWindow
    if (contextWindow === undefined) throw new Error('state-director model context capacity is unknown')
    const reservedOutputTokens = Math.max(1, Math.min(
      Math.max(model.defaultMaxTokens ?? 0, 4_096),
      4_096,
      Math.floor(contextWindow * 0.25),
    ))
    const inputLimit = Math.min(
      NARRATOR_MAX_INPUT_TOKENS,
      Math.floor(contextWindow * 0.72),
      contextWindow - reservedOutputTokens - 128,
    )
    const entities = object(view.snapshot.state['entities'])
    const characters = Object.entries(entities ?? {}).flatMap(([actorId, value]) => {
      const entity = object(value)
      if (entity?.['type'] !== 'character') return []
      return [{
        actorId: worldlineId<'entity'>(actorId),
        displayName: object(entity['facets'])?.['displayName'] ?? actorId,
        state: entity['state'] ?? {},
        stateSchema: object(entity['facets'])?.['stateSchema'] ?? {},
        stateSemantics: entityStateSemantics(entity),
        memory: entity['memory'] ?? {},
      }]
    })
    const worldMutablePaths = directorMutablePaths(view.snapshot.state['worldStateSchema'])
    const characterMutablePaths = new Map(characters.map(character => [
      character.actorId,
      directorMutablePaths(character.stateSchema),
    ] as const))
    const allCharacterMutablePaths = [...new Set([...characterMutablePaths.values()].flat())]
    const characterIds = characters.map(character => character.actorId)
    const commonSeeds = [{
      kind: 'observation' as const,
      text: stableStringify({ text: beat.text, blocks: beat.blocks, media: beat.media }),
      sourceIds: [beat.id],
      priority: 98,
    }, {
      kind: 'background' as const,
      text: stableStringify({ events: sources.events, observations: sources.observations }),
      sourceIds: [...sources.events.map(item => item.id), ...sources.observations.map(item => item.id)],
      priority: 97,
    }, {
      kind: 'background' as const,
      text: stableStringify({
        logicalTime: frame.logicalTime,
        placeId: frame.placeId ?? null,
        presentEntityIds: frame.presentEntityIds,
        visibleState: frame.visibleState,
        worldState: {
          state: view.snapshot.state['world'] ?? null,
          schema: view.snapshot.state['worldStateSchema'] ?? {},
          activeSemantics: stateSemantics(
            object(view.snapshot.state['worldStateSchema']),
            object(view.snapshot.state['world']),
          ),
        },
        completeCharacterRoster: characters,
      }),
      sourceIds: [`scene:${request.runId}:${String(view.snapshot.sequence)}`],
      priority: 96,
    }]
    const packFor = (
      constraint: string,
      subjectSourceId: string,
      extra: readonly {
        readonly kind: ContextPackSection['kind']
        readonly text: string
        readonly sourceIds: readonly string[]
        readonly priority: number
      }[] = [],
    ): ContextPack => {
      const seeds = [{
        kind: 'constraints' as const,
        text: constraint,
        sourceIds: [subjectSourceId],
        priority: 100,
      }, ...extra, ...commonSeeds]
      const sections: ContextPackSection[] = []
      const droppedSourceIds: string[] = []
      let remaining = inputLimit
      for (const seed of seeds) {
        let text = seed.text
        let tokens = this.tokens(text)
        if (tokens > remaining) {
          text = this.trim(text, remaining)
          tokens = text === '' ? 0 : this.tokens(text)
          droppedSourceIds.push(...seed.sourceIds)
        }
        if (tokens === 0) continue
        sections.push({ ...seed, text, tokens })
        remaining -= tokens
      }
      const pack: ContextPack = {
        actorId: request.actorId,
        model: route,
        contextWindow,
        inputLimit,
        reservedOutputTokens,
        reservedToolTokens: 128,
        sections,
        totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
        droppedSourceIds: [...new Set(droppedSourceIds)],
      }
      validateContextPack(pack)
      return pack
    }
    const worldPack = packFor([
      '你是世界状态推演分支。正文已保存；你只负责完整复核世界、天气、环境、社会局势与全局关系状态，不能创作后续剧情或执行动作。',
      '逐项检查 worldState.schema 中每个字段；mutations 只能使用 scope=world，且只能更新 mutable=true 且 participation.drivers 包含 director 的字段。没有被正文或权威事件明确影响的字段保持不变。',
      `path 必须逐字复制 worldState.schema 中允许的相对键（${worldMutablePaths.join('、') || '本轮没有可变键'}）；禁止添加 world.、state. 或其他前缀，也不能自行发明字段。`,
      'logicalTime 与历法由 Runtime 时钟推进，位置由移动动作推进，绝不能修改 time、calendar 或角色位置。天气和环境不是展示词：当前 band 的 meaning/narrative/choices 决定变化是否合理以及随后叙事和选项受到的影响。',
      'memoryWrites 必须为空。必须调用 story_propose_state_update；即使没有变化也提交两个空数组。',
    ].join(''), 'runtime:world-state-shard')
    const characterPack = packFor([
      '你是全角色状态推演分支。正文已保存；你必须在一次推演中复核 completeCharacterRoster 中的每一个角色，而不是只看视角角色，不能创作后续剧情或执行动作。',
      'mutations 只能使用 scope=character，必须填写准确 actorId，并且只能更新该角色 stateSchema 中 mutable=true 且 participation.drivers 包含 director 的字段；locationId 永远由移动系统管理。',
      'path 必须逐字复制该 actorId 对应 stateSchema 的相对键；例如 schema 键为 tension 就只能写 tension，禁止写 state.tension、entities.* 或自行发明字段。',
      '正文或权威事件没有影响某角色时，该角色应当保持不变；非在场角色只有在明确的全局传播、远程感知或权威事件影响到他时才能变化。所有变化须同时顾及角色所在地点、记忆、关系与当前属性 band。',
      'memoryWrites 要按角色认知边界分别处理：只有亲自感知或通过已建模渠道获知的角色才能获得记忆，旁白秘密不能写入不知情角色。',
      '必须调用 story_propose_state_update；即使全体角色都没有变化也提交两个空数组。',
    ].join(''), 'runtime:character-state-shard')
    const progressPack = point === undefined ? undefined : packFor([
      '你是剧情证据审计分支，只评估当前剧情点，不能修改状态、记忆、时间或位置，也不能创作后续剧情。',
      'status=completed 仅当本轮保存正文与引用的权威事件/观察已经明确满足 completionCriteria；动作类型或选项文字本身不是证据。status=failed 仅当失败后果的触发事实已经发生；其余为 active。',
      'evidence 必须逐条指向输入中可核对事实；若仍 active，要指出最关键的缺失证据。必须调用 story_assess_progress。',
    ].join(''), point.id, [{
      kind: 'goal',
      text: stableStringify(modelVisibleScript({
        completed: [],
        current: point,
        ...(script.currentProgress === undefined
          ? {}
          : { currentProgress: script.currentProgress }),
        suggestedActorIds: script.suggestedActorIds,
        remaining: script.remaining,
      }).current ?? {}),
      sourceIds: [point.id],
      priority: 99,
    }])
    const inferWorld = () => this.creativeStructured(
      request,
      worldPack,
      storyStateTool('world', worldMutablePaths),
      'story_propose_state_update',
      stateDirectorResultSchema('world', worldMutablePaths, characterMutablePaths),
    )
    const inferCharacters = () => this.creativeStructured(
      request,
      characterPack,
      storyStateTool('characters', allCharacterMutablePaths, characterIds),
      'story_propose_state_update',
      stateDirectorResultSchema('characters', worldMutablePaths, characterMutablePaths),
    )
    const inferProgress = progressPack === undefined ? undefined : () => this.creativeStructured(
      request, progressPack, STORY_PROGRESS_TOOL, 'story_assess_progress', ProgressAssessmentSchema,
    )
    const [worldResult, characterResult, progressResult] = await Promise.all([
      inferWorld(), inferCharacters(), inferProgress?.(),
    ])
    return (await this.context.worldlineRuns.recordStoryState({
      runId: request.runId,
      beatId: beat.id,
      shards: [{
        invocationId: worldResult.invocationId,
        domain: 'world',
        subjectIds: [],
        mutations: worldResult.value.mutations.map(({ actorId: _actorId, ...mutation }) => mutation),
        memoryWrites: [],
      }, {
        invocationId: characterResult.invocationId,
        domain: 'characters',
        subjectIds: characters.map(character => character.actorId),
        mutations: characterResult.value.mutations.map(({ actorId, ...mutation }) => ({
          ...mutation,
          ...(actorId === undefined ? {} : { actorId: worldlineId<'entity'>(actorId) }),
        })),
        memoryWrites: characterResult.value.memoryWrites.map(write => ({
          ...write,
          actorId: worldlineId<'entity'>(write.actorId),
        })),
      }],
      ...(point === undefined || progressResult === undefined ? {} : {
        progress: {
          invocationId: progressResult.invocationId,
          pointId: point.id,
          ...progressResult.value,
          eventIds: beat.eventIds,
          observationIds: beat.observationIds,
        },
      }),
    })).progress
  }

  private async choicePlannerPack(
    request: TextPlayRequest,
    frame: SceneFrame,
    choices: readonly ChoiceProjection[],
    script: ScriptProgressView,
    userIntent?: string,
  ): Promise<ContextPack> {
    const [view, beatsPage] = await Promise.all([
      this.context.worldlineRuns.view({ runId: request.runId }),
      this.context.worldlineRuns.records({
        runId: request.runId,
        stream: 'narrative-beat',
        limit: 8,
        tail: true,
      }),
    ])
    const route = view.snapshot.modelPolicy.routes.creative
      ?? view.snapshot.modelPolicy.routes.narrator
    if (route === undefined) throw new Error('no creative model is configured for the choice director')
    const model = await this.context.llm.resolveModelInfo(route.provider, route.model)
    const contextWindow = model.context?.contextWindow
    if (contextWindow === undefined) throw new Error('narrator model context capacity is unknown')
    const reservedOutputTokens = Math.max(1, Math.min(
      model.defaultMaxTokens ?? CHOICE_PLANNER_MAX_OUTPUT_TOKENS,
      CHOICE_PLANNER_MAX_OUTPUT_TOKENS,
      Math.floor(contextWindow * 0.1),
    ))
    const inputLimit = Math.min(
      CHOICE_PLANNER_MAX_INPUT_TOKENS,
      Math.floor(contextWindow * 0.7),
      contextWindow - reservedOutputTokens,
    )
    const entities = object(view.snapshot.state['entities'])
    const actor = object(entities?.[request.actorId])
    const actorFacets = object(actor?.['facets'])
    const presentCharacters = frame.presentEntityIds.map((id) => {
      const present = object(entities?.[id])
      const facets = object(present?.['facets'])
      return {
        id,
        name: typeof facets?.['displayName'] === 'string' ? facets['displayName'] : id,
        profile: subset(object(facets?.['profile']), [
          'age', 'gender', 'pronouns', 'identity', 'personality', 'keywords',
        ]),
        state: schemaStateProjection(present),
        stateSemantics: entityStateSemantics(present),
      }
    })
    const latestBeat = beatsPage.records.map(item => item.payload as unknown as NarrativeBeat)
      .findLast(beat => beat.perspectiveActorId === request.actorId)
    const task = userIntent === undefined
      ? [
        '基于 capabilityOpportunities 实时创作恰好三个具体下一步；它们是本阶段最后生成的内容。',
        '三个行动的目标、态度或策略必须明显不同，不能是同一句话的近义改写。',
        'actor.stateSemantics、presentCharacters.stateSemantics 与 environment.worldStateSemantics 是当前正在生效的推演规则，不是展示备注；选项的可行性、风险、措辞和优先级必须具体服从 currentBand 与 choiceInfluence，不能只复述数值。',
        'storyRole 必须分别且只出现一次：advance 顺着当前剧情目标推进；character 深挖人物关系或内心；deviate 合理偏离主线自由行动。',
        'opportunityId 只负责绑定 Runtime 能力边界；label 与 intent 必须结合最新正文、人物状态、地点、在场人物和当前剧情目标重新创作。',
        'label 是 12 至 34 个汉字的玩家决定；intent 要具体说明角色准备怎么做以及希望造成什么结果。',
        '天气、灾变、感染等外部事件若作为合法剧情推进动作出现，label 必须改写成角色可主动采取的观察、躲避、准备或救援行为，绝不能写成玩家命令天气或灾难发生。',
        '只有 presentCharacters 中的角色且同时出现在该选项 targetIds 时才能成为交互对象；不得把通用交谈、移动或调查包装成与未建模人物、物品或地点的互动。',
        'latestPresentation 只用于延续语气，绝不是权威事实；不得从中提取新的角色、物品、线索或地点作为选项目标。',
        '必须调用 story_offer_choices 工具，并在 opportunityId 中传入 capabilityOpportunities 的精确 ID；不要在正文中打印选项 JSON。',
      ].join('')
      : [
        '把 userIntent 语义映射到一个 capabilityOpportunities 中的精确 opportunityId。',
        '要结合地点、在场人物、目标、剧本点与动作参数理解，而不是只匹配关键词。',
        '必须服从 actor.stateSemantics、presentCharacters.stateSemantics 与 environment.worldStateSemantics 中当前生效的属性影响；属性造成的限制不能被自由文本绕过。',
        '只有当前合法动作能真实承载这个意图时才选择；否则返回 null。',
        '必须调用 story_propose_action 工具，并在 opportunityId 中传入精确 ID 或 null；不要在正文中打印 JSON。',
      ].join('')
    const environment = {
      gameDateTime: gameDateTime(view.snapshot.state, frame.logicalTime),
      place: frame.visibleState['place'] ?? null,
      world: boundedMemory(view.snapshot.state['world']),
      worldStateSemantics: stateSemantics(
        object(view.snapshot.state['worldStateSchema']),
        object(view.snapshot.state['world']),
      ),
      conflict: boundedMemory(view.snapshot.state['conflict']),
      relationships: boundedMemory(view.snapshot.state['relationship']),
      activeProcesses: frame.activeProcesses.map(process => ({
        actionType: process.action.type,
        actorId: process.action.actorId,
        state: process.state,
        progress: process.progress,
      })),
    } satisfies JsonObject
    const seeds = [
      {
        kind: 'constraints' as const,
        text: task,
        sourceIds: ['runtime:choice-planner-contract'],
        priority: 100,
      },
      {
        kind: 'goal' as const,
        text: stableStringify(modelVisibleScript(script)),
        sourceIds: script.current === undefined ? ['script:complete'] : [script.current.id],
        priority: 99,
      },
      {
        kind: 'actions' as const,
        text: stableStringify(choices.map(choice => ({
          choiceId: choice.id,
          actionType: choice.actionType,
          label: choice.label,
          description: choice.description,
          targetIds: choice.targetIds,
          parameters: choice.parameters,
          duration: choice.estimatedDuration,
          costs: choice.costs,
          risks: choice.risks,
        }))),
        sourceIds: choices.map(choice => choice.id),
        priority: 98,
      },
      ...(userIntent === undefined ? [] : [{
        kind: 'observation' as const,
        text: userIntent.slice(0, 500),
        sourceIds: ['player:intent'],
        priority: 97,
      }]),
      {
        kind: 'observation' as const,
        text: stableStringify({
          actor: {
            id: request.actorId,
            ...subset(actorFacets, ['displayName', 'behaviorStrategy', 'goals', 'relationships']),
            profile: subset(object(actorFacets?.['profile']), [
              'age', 'gender', 'pronouns', 'identity', 'personality', 'keywords',
            ]),
            state: schemaStateProjection(actor),
            stateSemantics: entityStateSemantics(actor),
          },
          presentCharacters,
          environment,
        }),
        sourceIds: [`scene:${request.runId}:${String(view.snapshot.sequence)}`],
        priority: 96,
      },
      ...(latestBeat === undefined ? [] : [{
        kind: 'memory' as const,
        text: `latestPresentationOnly:${latestBeat.text.slice(0, NARRATOR_MAX_CHARACTERS)}`,
        sourceIds: [latestBeat.id],
        priority: 90,
      }]),
    ]
    const sections: ContextPackSection[] = []
    const droppedSourceIds: string[] = []
    let remaining = inputLimit
    for (const seed of seeds.sort((left, right) => right.priority - left.priority)) {
      let text = seed.text
      let tokens = this.tokens(text)
      if (tokens > remaining) {
        text = this.trim(text, remaining)
        tokens = text === '' ? 0 : this.tokens(text)
        droppedSourceIds.push(...seed.sourceIds)
      }
      if (tokens === 0) continue
      sections.push({ ...seed, text, tokens })
      remaining -= tokens
    }
    const pack: ContextPack = {
      actorId: request.actorId,
      model: route,
      contextWindow,
      inputLimit,
      reservedOutputTokens,
      reservedToolTokens: 0,
      sections,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
      droppedSourceIds: [...new Set(droppedSourceIds)],
    }
    validateContextPack(pack)
    return pack
  }

  private async narratorPack(
    request: NarrateRequest,
    frame: SceneFrame,
    sources: NarrativeSources,
    script: ScriptProgressView,
  ): Promise<NarratorPreparation> {
    const [view, beatsPage] = await Promise.all([
      this.context.worldlineRuns.view({ runId: request.runId }),
      this.context.worldlineRuns.records({
        runId: request.runId,
        stream: 'narrative-beat',
        limit: 2,
        tail: true,
      }),
    ])
    const route = view.snapshot.modelPolicy.routes.narrator
    if (route === undefined) throw new Error('no narrator model is configured')
    const opening = beatsPage.records.length === 0
      && request.actionId === undefined
      && request.eventIds === undefined
      && request.observationIds === undefined
    const model = await this.context.llm.resolveModelInfo(route.provider, route.model)
    const contextWindow = model.context?.contextWindow
    if (contextWindow === undefined) throw new Error('narrator model context capacity is unknown')
    const reservedOutputTokens = Math.max(1, Math.min(
      model.defaultMaxTokens ?? 1024,
      NARRATOR_MAX_OUTPUT_TOKENS,
      Math.floor(contextWindow * 0.2),
    ))
    const reservedToolTokens = Math.max(1, Math.min(
      NARRATOR_MAX_TOOL_TOKENS,
      Math.floor(contextWindow * 0.15),
    ))
    const inputLimit = Math.min(
      NARRATOR_MAX_INPUT_TOKENS,
      Math.floor(contextWindow * 0.75),
      contextWindow - reservedOutputTokens - reservedToolTokens,
    )
    const entities = object(view.snapshot.state['entities'])
    const actor = object(entities?.[request.actorId])
    const actorFacets = object(actor?.['facets'])
    const actorInitial = object(actorFacets?.['initialState'])
    const presentCharacters = frame.presentEntityIds.map((id) => {
      const present = object(entities?.[id])
      const facets = object(present?.['facets'])
      return {
        id,
        name: typeof facets?.['displayName'] === 'string' ? facets['displayName'] : id,
        profile: subset(object(facets?.['profile']), [
          'age', 'gender', 'pronouns', 'identity', 'personality', 'keywords',
        ]),
        state: schemaStateProjection(present),
        stateSemantics: entityStateSemantics(present),
      }
    })
    const actorProfile = {
      id: request.actorId,
      ...subset(actorFacets, ['displayName', 'behaviorStrategy', 'goals', 'relationships']),
      profile: subset(object(actorFacets?.['profile']), [
        'age', 'gender', 'pronouns', 'identity', 'personality', 'keywords',
      ]),
      authoredIdentity: subset(actorInitial, ['body', 'mental', 'ability', 'duty']),
      currentState: schemaStateProjection(actor),
      stateSemantics: entityStateSemantics(actor),
      runtimeMemory: boundedMemory(actor?.['memory']),
    } satisfies JsonObject
    const recentPresentation = beatsPage.records
      .map(item => item.payload as unknown as NarrativeBeat)
      .filter(beat => beat.perspectiveActorId === request.actorId)
      .filter(beat => request.eventIds === undefined || !sameIds(beat.eventIds, request.eventIds))
      .slice(-2)
      .map(beat => beat.blocks
        .flatMap(block => block.type === 'narration' || block.type === 'character'
          || block.type === 'media' || block.type === 'media-intent'
          ? [block]
          : []))
    const environment = {
      gameDateTime: gameDateTime(view.snapshot.state, frame.logicalTime),
      placeId: frame.placeId ?? null,
      place: frame.visibleState['place'] ?? null,
      presentEntityIds: [...frame.presentEntityIds],
      presentCharacters,
      world: boundedMemory(view.snapshot.state['world']),
      worldStateSemantics: stateSemantics(
        object(view.snapshot.state['worldStateSchema']),
        object(view.snapshot.state['world']),
      ),
      conflict: boundedMemory(view.snapshot.state['conflict']),
      relationships: boundedMemory(view.snapshot.state['relationship']),
      activeProcesses: frame.activeProcesses.map(process => ({
        id: process.id,
        actionType: process.action.type,
        actorId: process.action.actorId,
        state: process.state,
        progress: process.progress,
        nextWakeAt: process.nextWakeAt ?? null,
      })),
    } satisfies JsonObject
    const seeds = [
      {
        kind: 'constraints' as const,
        text: [
          opening
            ? '你是世界线视觉互动小说的叙事者。根据下列权威世界事实创作一段完成度高、自然连贯的中文开场序章。'
            : '你是世界线视觉互动小说的叙事者。把下列权威世界事实续写成一段完成度高、自然连贯的中文小说正文。',
          opening
            ? '这是整条世界线的第一幕。先建立唯一正确的游戏时间、地点、可感知环境与在场人物，再从视角角色当下的身体感受、处境或目标切入。'
            : '剧本点决定戏剧方向，世界事件决定已经真实发生的结果；正文必须承接当前权威场景，不得复述任何旧段落。',
          opening
            ? '开场不能假装玩家已经作出选择，也不能完成当前剧本点；它应把已有矛盾带到眼前，并在一个自然、明确的行动停顿处结束，把决定权交给玩家。'
            : '本轮的玩家行动与最新权威事件是这一段的中心；必须先演出该行动的直接过程、人物反应或结果，不得重新开场或转去重演上一轮的事。',
          'recentPresentation 只是最近已经展示给玩家的有界上下文：用来承接话语和避免重复，不是新的权威事实。不得重复其中已演出的对话、小动作、道具或意象。',
          '事件若只有 proposed 或 started，就只能写决定与动作开始；只有输入明确含 action.completed 才能写成已经完成并呈现其效果。',
          '当前剧本点只是未来方向；除非权威事件已经满足它，否则不得提前演出、发现或完成该剧本点。',
          '可以依据人物档案写符合性格的台词、表情、动作、感官与氛围；这些只用于演出，不得冒充新的持久世界事实。',
          '人物档案里的目标和身份只用于保持性格，不是本轮必须提及的题材；若权威事件没有触发，不得反复搬出私密往事、长期目标或知识库内容。',
          '不得擅自新增或发现秘密、线索、书信、记录、物品、关系变化、伤病、人物到场、地点迁移或重大事件。',
          '不得复用输入中没有出现的旧段落意象、物品或发现；同类行动也必须只描写本轮权威事件允许的直接过程。',
          '环境中的 gameDateTime 是唯一正确的游戏日期与时刻；不得写出与它矛盾的昼夜、钟点或季节。若必须写数字时刻，只能逐字复制其中的 HH:MM。',
          'actorProfile.stateSemantics、presentCharacters.stateSemantics 与 environment.worldStateSemantics 是属性对本轮推演正在生效的规则，不是 UI 注释。正文必须让当前 currentBand/narrativeInfluence 自然改变角色体感、观察、环境反馈或行动结果；不得生硬播报字段名和数值，也不得忽略已经命中的危险或限制。',
          '环境与 world 中可见的天气、灾变阶段、感染、灰潮、暴露和地点状态同样是权威事实；当这些状态已经产生可感知影响时，正文至少要自然呈现一项后果，绝不能把异常现场写成毫无征兆的平静日常，也不要生硬复述数值。',
          '除非权威事件明确包含钟声、报时或时间变化，不得自行添加整点报时、钟声或通过环境暗示另一个时刻。',
          opening
            ? '序章只负责建立舞台、人物落点和眼前局面；不得把尚未发生的行动、发现或结果写成事实。'
            : '本段只演出最新权威事件的动作和直接感受，不要借机开启另一个事件。',
          '不得输出 JSON、事件类型、动作类型、逻辑时间、调试术语或日志摘要。',
          '输出 6 至 12 个短故事块，总计 280 至 650 个汉字；每块只做一件事，适合玩家每次点击放出一条。',
          '必须优先调用一次 story_present_sequence，把完整段落按故事顺序放入 blocks；每个 block 就是玩家点击后出现的一个演出单元。',
          'story_present_sequence 必须包含正文块，media 只能穿插在正文之间，绝不能单独代替正文。',
          '每段正文都必须先判断这一段是否真的存在值得演出的视觉或听觉时刻，并在 mediaDecision 中说明 staged 或 none 及理由；这是叙事判断，不是媒体配额。不得因为是开场就固定插入环境图、角色图或环境音，也不得按轮次轮换类型。',
          '地点、光线、天气或空间关系显著变化，角色首次清晰登场或出现重要表情，关键物件、动作或揭示形成可视瞬间，以及独特环境声、音乐或能增加含义的角色声音，都是适合考虑多模态的情境；若媒体只会重复近期演出、没有增加叙事信息或打断节奏，就应自然选择 none。',
          '“没有固定配额”不等于默认选择 none。对于有完整场景推进的正文，只要上述任何具体感官瞬间能够独立成画面或声音并增加信息，通常就应选择 staged；none 只保留给短暂过渡、近期媒体的无效重复，或确实没有可独立演出的感官时刻。rationale 必须指出本段的具体候选时刻，或说明为何不存在这样的时刻。',
          '选择 staged 时，画面和声音必须出现在它所对应的正文位置，而不是写完正文后追加元数据；媒体种类和数量完全由当前正文需要决定，可以是一项，也可以是若干项，但不能为了数量机械插入或把多项堆在一起。',
          '没有真实资源时使用 media-intent：kind 明确 image/audio，purpose 明确 scene/character/event/music/sfx/voice，prompt 写可直接交给生成器的提示词，fallbackText 写未接生成器时在小说中的文字替代。只能描绘当前视角已知事实，不能新增世界事实或泄露秘密。',
          '若本轮提供 state cue，可在对应动作或反应之后穿插最多两个 state 块，让体力、情绪、好感、伤势或环境变化成为演出的一部分；只能引用给定索引，绝不能自行填写或修改状态值。',
          'media 的 cueIndex 已绑定具体资源，不得在正文中把角色语音、角色曲、立绘或背景冒充成另一种声音或画面。',
          '必须通过 story_present_sequence 提交完整正文；工具之外的自由文本不会被保存或展示。',
          'dialogue 块只能放角色实际说出口的原句：不要写角色姓名、说/问等引导语、动作或心理，也不要包裹中文或英文引号；动作必须另放 action，心理必须另放 thought。',
          'action 块只能写玩家可见的动作，不得夹带带引号的台词；thought 块只写内心内容，不要写“某某想”之类的归属提示或引号。',
          '只能使用当前场景 presentCharacters 中列出的精确 ID；一个角色块里的姓名、代词、动作、心理和台词必须全部属于这个 ID 对应的人物。',
          '角色的性别、年龄、身份、称谓与代词必须服从 actorProfile 和 presentCharacters.profile；档案没有明确性别或代词时，不得猜测“男孩/女孩/他/她”，应使用角色姓名或省略第三人称。',
          '未列入 presentCharacters 的人物不得到场或直接发言；若权威事件只允许间接获知其反应，就必须写成旁白，绝不能借用另一个在场角色的 ID。',
          '不要创建临时 NPC，也不要标题、列表、Markdown 或系统解释。',
        ].join(''),
        sourceIds: ['runtime:narrator-authority'],
        priority: 100,
      },
      {
        kind: 'goal' as const,
        text: stableStringify(modelVisibleScript(script)),
        sourceIds: script.current === undefined ? ['script:complete'] : [script.current.id],
        priority: 98,
      },
      {
        kind: 'background' as const,
        text: stableStringify(sources.events),
        sourceIds: sources.events.map(item => item.id),
        priority: 97,
      },
      {
        kind: 'observation' as const,
        text: stableStringify(sources.observations),
        sourceIds: sources.observations.map(item => item.id),
        priority: 96,
      },
      ...(request.playerIntent === undefined || request.playerIntent.trim() === '' ? [] : [{
        kind: 'actions' as const,
        text: [
          '以下是玩家对本轮行动的表达。它必须成为本段演出中心，但它不是已发生的结果，只有后续权威事件能确认成败与效果：',
          request.playerIntent.trim().slice(0, 500),
        ].join('\n'),
        sourceIds: [request.actionId ?? 'player:intent'],
        priority: 95.5,
      }]),
      ...(recentPresentation.length === 0 ? [] : [{
        kind: 'memory' as const,
        text: `recentPresentation:${stableStringify(recentPresentation.map(blocks => ({ blocks }))).slice(0, 1_800)}`,
        sourceIds: ['narrative:recent-presentation'],
        priority: 95.25,
      }]),
      {
        kind: 'background' as const,
        text: stableStringify(environment),
        sourceIds: [`environment:${request.runId}:${String(view.snapshot.sequence)}`],
        priority: 95,
      },
      {
        kind: 'identity' as const,
        text: stableStringify(actorProfile),
        sourceIds: [`actor:${request.actorId}:profile`],
        priority: 93,
      },
    ]
    const sections: ContextPackSection[] = []
    const droppedSourceIds: string[] = []
    let remaining = inputLimit
    for (const seed of seeds.sort((left, right) => right.priority - left.priority)) {
      let text = seed.text
      let tokens = this.tokens(text)
      if (tokens > remaining) {
        text = this.trim(text, remaining)
        tokens = text === '' ? 0 : this.tokens(text)
        droppedSourceIds.push(...seed.sourceIds)
      }
      if (tokens === 0) continue
      sections.push({ ...seed, text, tokens })
      remaining -= tokens
    }
    const pack: ContextPack = {
      actorId: request.actorId,
      model: route,
      contextWindow,
      inputLimit,
      reservedOutputTokens,
      reservedToolTokens,
      sections,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
      droppedSourceIds: [...new Set(droppedSourceIds)],
    }
    validateContextPack(pack)
    return { pack, recentPresentation }
  }

  private continuityRepairPack(pack: ContextPack, candidate: readonly NarrativeBlock[]): ContextPack {
    const repairText = [
      '连续性校验拒绝了上一版候选：它在语义上重演了 recentPresentation 中已经展示过的场面。',
      '请从最新权威事件重新写一版；保留人物身份与当前地点，但不得再次使用上一版候选里的道具、对话目的、动作链或意象，除非它们逐字存在于本轮权威事件。',
      '仍须调用 story_present_sequence，且玩家本轮行动必须是第一叙事中心。',
      `rejectedCandidate:${stableStringify(candidate).slice(0, 1_100)}`,
    ].join('\n')
    const repairTokens = this.tokens(repairText)
    const sections: ContextPackSection[] = [{
      kind: 'constraints',
      text: repairText,
      sourceIds: ['runtime:narrator-continuity-repair'],
      tokens: repairTokens,
      priority: 101,
    }]
    let remaining = Math.max(0, pack.inputLimit - repairTokens)
    const dropped = [...pack.droppedSourceIds]
    for (const section of pack.sections) {
      if (remaining <= 0) {
        dropped.push(...section.sourceIds)
        continue
      }
      if (section.tokens <= remaining) {
        sections.push(section)
        remaining -= section.tokens
        continue
      }
      const text = this.trim(section.text, remaining)
      if (text !== '') {
        const tokens = this.tokens(text)
        sections.push({ ...section, text, tokens })
        remaining -= tokens
      }
      dropped.push(...section.sourceIds)
    }
    const repaired: ContextPack = {
      ...pack,
      sections,
      totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
      droppedSourceIds: [...new Set(dropped)],
    }
    validateContextPack(repaired)
    return repaired
  }

  private tokens(text: string): number {
    return this.context.tokenMeter.estimateMessage(createUserMessage({
      source: { kind: 'plugin', plugin: 'worldline-narrative' },
      content: [{ type: 'text', text }],
    }))
  }

  private trim(text: string, limit: number): string {
    if (limit <= 0) return ''
    let low = 0
    let high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (this.tokens(`${text.slice(0, middle)}…`) <= limit) low = middle
      else high = middle - 1
    }
    return low === 0 ? '' : `${text.slice(0, low)}…`
  }
}

export { WorldlineNarrative }
