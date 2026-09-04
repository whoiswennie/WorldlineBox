/* eslint-disable @stylistic/max-len */
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentView, ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { WorldlineAiModel } from '@deepseek-ai/dsh-worldline-ai/types'
import type { RunRecordsPage, RunSpatialView, RunSummary, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { NarrativeAgentPhase, StoryChoiceSuggestions, StoryStageStatus, TextPlayView } from '@deepseek-ai/dsh-worldline-narrative/types'
import type { ActionId, ActionPlan, EntityId, JsonObject, JsonValue, MediaCue, MediaGenerationIntent, ModelRoute, NarrativeBeat, NarrativeBlock } from '@deepseek-ai/dsh-worldline-standard/types'
import { ArtworkImage } from './ArtworkImage.tsx'
import { DEFAULT_ARTWORK, defaultCharacterArtwork } from './default-artwork.ts'
import {
  characterMemorySections,
  characterProfileFacts,
  characterResources,
  characterFacts,
  characterEntityIds,
  entityName,
  gameCalendar,
  gameDuration,
  newWorldlineSeed,
  placeName,
  projectMediaUrl,
  snapshotEntities,
  worldEnvironmentFacts,
  worldlineLabel,
} from './presentation.ts'
import { eventTitle, LivingMap } from './SimulationWorkbench.tsx'
import type { AiClient, NarrativeClient, ProjectClient, RunsClient } from './types.ts'
import css from './TextPlayWorkbench.module.css'

interface TextPlayWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly runs: RunsClient
  readonly ai: AiClient
  readonly narrative: NarrativeClient
  readonly projects: ProjectClient
  readonly preferredRunId?: RunSummary['runId'] | undefined
  readonly preferredActorId?: EntityId | undefined
  readonly modelSettingsSignal?: number | undefined
  readonly onNarratorRouteChange?: ((route: ModelRoute | undefined) => void) | undefined
  readonly onRunsChanged: () => void
  readonly onImportRun: () => void
  readonly onExportRun: (runId: RunSummary['runId']) => void
}

interface NarrativeRecovery {
  readonly kind: 'narrative'
  readonly runId: RunSummary['runId']
  readonly actorId: EntityId
  readonly actionId?: ActionId
  readonly eventIds?: readonly string[]
  readonly playerIntent?: string
}

interface ChoiceRecovery {
  readonly kind: 'choices'
  readonly runId: RunSummary['runId']
  readonly actorId: EntityId
  readonly sequence: number
}

type FailedStoryStage = NarrativeRecovery | ChoiceRecovery

interface StoryRetryNotice {
  readonly attempt: number
  readonly maxAttempts?: number
  readonly delayMs: number
  readonly code: string
}

type StoryPanel = 'choices' | 'free' | 'world' | 'history' | 'character' | 'saves' | 'settings'
export type StoryAgentPhase = NarrativeAgentPhase | 'runtime' | 'choices'

export interface StoryAgentStage {
  readonly id: 'context' | 'narrative' | 'world-state' | 'choices'
  readonly label: string
  readonly detail: string
  readonly status: 'pending' | 'active' | 'done'
}

/** Runs are returned by latest activity, but a playthrough number must never change when another
 * run is updated. Creation order is the durable user-facing identity. */
export function stableRunOrder(runs: readonly RunSummary[]): readonly RunSummary[] {
  return [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.runId.localeCompare(right.runId))
}

/** Present the actual four-agent pipeline as a deterministic progress model. */
export function storyAgentStages(phase: StoryAgentPhase): readonly StoryAgentStage[] {
  const order: readonly StoryAgentStage['id'][] = ['context', 'narrative', 'world-state', 'choices']
  const active = phase === 'runtime' ? 'context' : phase === 'complete' ? 'world-state' : phase
  const activeIndex = order.indexOf(active)
  const details: Readonly<Record<StoryAgentStage['id'], readonly [string, string]>> = {
    context: ['理解此刻', '装配剧情、世界、环境、人物状态与记忆'],
    narrative: ['撰写正文', '故事推演 Agent 严格依照当前主线创作'],
    'world-state': ['结算世界', '世界与全部角色分支并发推演并原子提交'],
    choices: ['生成选项', '阶段正文完成后实时生成三个行动方向'],
  }
  return order.map((id, index) => ({
    id,
    label: details[id][0],
    detail: details[id][1],
    status: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending',
  }))
}

/** Inline renderer for a narrator-authored media generation marker. Keeping this as a first-class
 * story block preserves its exact position whether a provider resolves it now or a text-only
 * client displays the fallback. */
export const MediaIntentPlaceholder = forwardRef<HTMLElement, {
  readonly intent: MediaGenerationIntent
  readonly current?: boolean
}>(({ intent, current }, ref) => {
  const intentLabel = intent.kind === 'image' ? '待生成图片' : '待生成音频'
  const purposeLabel = {
    scene: '环境镜头',
    character: '角色形象',
    event: '关键事件',
    music: '场景音乐',
    sfx: '环境音效',
    voice: '角色语音',
  }[intent.purpose]
  return <aside
    ref={ref}
    className={css.mediaIntent}
    data-kind={intent.kind}
    data-purpose={intent.purpose}
    data-current={current || undefined}
    aria-label={`${intentLabel}：${intent.fallbackText}`}>
    <span aria-hidden="true">{intent.kind === 'image' ? '▧' : '♪'}</span>
    <div><small>{intentLabel} · {purposeLabel}</small><strong>{intent.fallbackText}</strong>
      {intent.kind === 'audio' && <i className={css.audioWave} aria-hidden="true">
        {Array.from({ length: 11 }, (_, index) => <b key={String(index)} />)}
      </i>}
      <details onClick={(event) => { event.stopPropagation() }}><summary>查看生成提示词</summary><p>{intent.prompt}</p></details></div>
  </aside>
})
MediaIntentPlaceholder.displayName = 'MediaIntentPlaceholder'

export function userFacingStoryError(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^(?:internal:\s*)+/iu, '').trim()
}
export { newWorldlineSeed }

function scheduledChangeTitle(payload: JsonObject): string {
  const title = payload['title']
  if (typeof title === 'string' && title.trim() !== '') return title
  const phase = payload['phase']
  return typeof phase === 'string' && phase.trim() !== '' ? phase : '剧情时间干预'
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function actorIds(view: RunView | undefined): EntityId[] {
  return characterEntityIds(snapshotEntities(view?.snapshot))
}

function scenePlace(play: TextPlayView, spatial: RunSpatialView | undefined): string {
  const place = record(play.frame.visibleState['place'])
  return typeof place?.['name'] === 'string' ? place['name'] : placeName(spatial, play.frame.placeId)
}

function documentTitle(document: DocumentView): string | undefined {
  return /^#\s+(.+)$/mu.exec(document.content)?.[1]?.trim()
}

function sourcePathOf(entity: JsonValue | undefined): string | undefined {
  const facets = record(record(entity)?.['facets'])
  return typeof facets?.['sourcePath'] === 'string' ? facets['sourcePath'].replace(/\\/gu, '/') : undefined
}

function cueUrl(projectId: string, cue: MediaCue | undefined): string | undefined {
  return projectMediaUrl(projectId, cue?.variant)
}

function StoryImage(props: {
  readonly sources: readonly (string | undefined)[]
  readonly alt: string
  readonly fallbackLabel: string
}): JSX.Element {
  const sources = [...new Set(props.sources.filter((source): source is string => source !== undefined))]
  const signature = sources.join('\u0000')
  const [sourceIndex, setSourceIndex] = useState(0)
  useEffect(() => { setSourceIndex(0) }, [signature])
  const source = sources[sourceIndex]
  if (source === undefined) {
    return <div className={css.visualFallback} aria-label={`${props.fallbackLabel}暂无可用图片`}>
      <span>{props.fallbackLabel.slice(0, 1)}</span><small>视觉资源待补充</small>
    </div>
  }
  return <img src={source} alt={props.alt} onError={() => { setSourceIndex(index => index + 1) }} />
}

function latestCue(cues: readonly MediaCue[], types: readonly MediaCue['type'][]): MediaCue | undefined {
  return cues.findLast(cue => types.includes(cue.type))
}

function environmentLabel(state: JsonObject | undefined): string | undefined {
  const weather = state?.['weather']
  if (typeof weather === 'string' && weather.trim() !== '') return weather
  const weatherState = record(weather) ?? record(state?.['environment']) ?? state
  for (const key of ['label', 'name', 'condition', 'weather'] as const) {
    const value = weatherState?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** Keep a Kiny-style vertical reading trail without allowing the live DOM to grow forever. Older
 * beats remain available from story history, while the most recent beats preserve the natural
 * top-to-bottom context around the currently revealing moment. */
export function storyStageWindow(
  beats: readonly NarrativeBeat[],
  limit = 8,
): readonly NarrativeBeat[] {
  return beats.slice(-Math.max(1, limit))
}

function narrativeFrontierKey(beat: NarrativeBeat): string {
  return [
    beat.perspectiveActorId,
    ...beat.eventIds,
    '|observations|',
    ...beat.observationIds,
  ].join('\u0000')
}

function coalesceNarrativeBeats(beats: readonly NarrativeBeat[]): readonly NarrativeBeat[] {
  const latestByFrontier = new Map<string, NarrativeBeat>()
  for (const beat of beats) latestByFrontier.set(narrativeFrontierKey(beat), beat)
  return [...latestByFrontier.values()]
}

function clickSizedText(value: string, maximum = 150): readonly string[] {
  const sentences = value.split(/\n\s*\n/gu).map(item => item.trim()).filter(Boolean)
    .flatMap(item => item.match(/[^。！？!?]+[。！？!?]?/gu) ?? [item])
    .map(item => item.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current !== '' && current.length + sentence.length > maximum) {
      chunks.push(current)
      current = ''
    }
    if (sentence.length <= maximum) {
      current += sentence
      continue
    }
    if (current !== '') chunks.push(current)
    current = ''
    for (let offset = 0; offset < sentence.length; offset += maximum) {
      chunks.push(sentence.slice(offset, offset + maximum))
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

function playbackBlocks(beat: NarrativeBeat): readonly NarrativeBlock[] {
  const blocks = beat.blocks
  const playable: NarrativeBlock[] = []
  for (const block of blocks) {
    if (block.type === 'media' || block.type === 'media-intent' || block.type === 'state') {
      playable.push(block)
      continue
    }
    for (const text of clickSizedText(block.text, block.type === 'narration' ? 150 : 110)) {
      playable.push(block.type === 'narration'
        ? { type: 'narration', text }
        : { ...block, text })
    }
  }
  return playable
}

function playbackTranscript(beat: NarrativeBeat): string {
  return playbackBlocks(beat).flatMap((block) => {
    if (block.type === 'media') return block.caption === undefined ? [] : [block.caption]
    if (block.type === 'media-intent') return [block.intent.fallbackText]
    if (block.type === 'state') {
      return [`${block.cue.label}：${block.cue.before === undefined
        ? block.cue.value : `${block.cue.before} → ${block.cue.value}`}`]
    }
    return [block.text]
  }).join('\n\n')
}

/** Derive the initial local animation state from the durable Run cursor. */
export function initialStoryPlayback(
  beat: NarrativeBeat,
  completedBeatId: string | undefined,
): {
  readonly revealLength: number
  readonly blockIndex: number
  readonly typingLength: number
} {
  const blocks = playbackBlocks(beat)
  const completed = completedBeatId === beat.id
  const revealLength = completed ? blocks.length : Math.min(1, blocks.length)
  const last = blocks[revealLength - 1]
  return {
    revealLength,
    blockIndex: revealLength - 1,
    typingLength: completed && (last?.type === 'narration' || last?.type === 'character')
      ? last.text.length
      : 0,
  }
}

export function shouldFollowSuggestedActor(
  manualViewpoint: boolean,
  retainedPerspectiveActorId: EntityId | undefined,
  actorId: EntityId | undefined,
  suggestedActorIds: readonly EntityId[],
): EntityId | undefined {
  if (manualViewpoint || actorId === undefined) return undefined
  if (retainedPerspectiveActorId !== undefined) {
    return retainedPerspectiveActorId === actorId ? undefined : retainedPerspectiveActorId
  }
  const suggested = suggestedActorIds[0]
  return suggested !== undefined && !suggestedActorIds.includes(actorId) ? suggested : undefined
}

export function TextPlayWorkbench(props: TextPlayWorkbenchProps) {
  const [runs, setRuns] = useState<readonly RunSummary[]>([])
  const [runId, setRunId] = useState<RunSummary['runId'] | undefined>(props.preferredRunId)
  const [actorId, setActorId] = useState<EntityId | undefined>(props.preferredActorId)
  const [runView, setRunView] = useState<RunView>()
  const [spatial, setSpatial] = useState<RunSpatialView>()
  const [records, setRecords] = useState<RunRecordsPage>()
  const [play, setPlay] = useState<TextPlayView>()
  const [stage, setStage] = useState<StoryStageStatus>()
  const [authoredNames, setAuthoredNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [camera, setCamera] = useState('limited-third-person')
  const [panel, setPanel] = useState<StoryPanel>()
  const [autoPlay, setAutoPlay] = useState(false)
  const [muted, setMuted] = useState(false)
  const [models, setModels] = useState<readonly WorldlineAiModel[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedReasoning, setSelectedReasoning] = useState('')
  const [selectedDirectorModel, setSelectedDirectorModel] = useState('')
  const [selectedDirectorReasoning, setSelectedDirectorReasoning] = useState('')
  const [freeText, setFreeText] = useState('')
  const [retryPlans, setRetryPlans] = useState<Readonly<Record<string, string>>>({})
  const [streamingText, setStreamingText] = useState('')
  const [streamingMedia, setStreamingMedia] = useState<readonly MediaCue[]>([])
  const [choicePlan, setChoicePlan] = useState<StoryChoiceSuggestions>()
  const [choicePlanning, setChoicePlanning] = useState(false)
  const [agentPhase, setAgentPhase] = useState<StoryAgentPhase>()
  const [autoFollow, setAutoFollow] = useState(true)
  const [manualViewpoint, setManualViewpoint] = useState(false)
  const [reveal, setReveal] = useState<{ readonly beatId: string; readonly length: number }>({ beatId: '', length: 0 })
  const [typing, setTyping] = useState<{
    readonly beatId: string
    readonly blockIndex: number
    readonly length: number
  }>({ beatId: '', blockIndex: -1, length: 0 })
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [failedStage, setFailedStage] = useState<FailedStoryStage>()
  const [retryNotice, setRetryNotice] = useState<StoryRetryNotice>()
  const [openingAttemptedKey, setOpeningAttemptedKey] = useState<string>()
  const openingAttemptedRef = useRef<string>()
  const presentationWritesRef = useRef(new Set<string>())
  const activeRunIdRef = useRef(runId)
  const activeActorIdRef = useRef(actorId)
  const runRequestRef = useRef(0)
  const playRequestRef = useRef(0)
  const pauseRef = useRef<HTMLElement>(null)
  const currentEntryRef = useRef<HTMLElement>(null)
  const readingScrollRef = useRef<HTMLDivElement>(null)
  const projectId = props.project.manifest.id
  activeRunIdRef.current = runId
  activeActorIdRef.current = actorId
  const orderedRuns = useMemo(() => stableRunOrder(runs), [runs])
  const selectRun = (next: RunSummary['runId'] | undefined): void => {
    activeRunIdRef.current = next
    setRunId(next)
    setRunView(undefined)
    setSpatial(undefined)
    setRecords(undefined)
    setPlay(undefined)
    setChoicePlan(undefined)
    setAgentPhase(undefined)
    setFailedStage(undefined)
    setRetryNotice(undefined)
    setError(undefined)
  }
  const selectActor = (next: EntityId | undefined): void => {
    activeActorIdRef.current = next
    setActorId(next)
    setPlay(undefined)
    setChoicePlan(undefined)
    setFailedStage(undefined)
    setRetryNotice(undefined)
    setError(undefined)
  }

  const loadRuns = useCallback(async (): Promise<void> => {
    const next = (await props.runs.list()).filter(item => item.projectId === projectId)
    setRuns(next)
    setRunId((current) => {
      const selected = current !== undefined && next.some(item => item.runId === current)
        ? current : props.preferredRunId !== undefined && next.some(item => item.runId === props.preferredRunId)
          ? props.preferredRunId : next[0]?.runId
      activeRunIdRef.current = selected
      return selected
    })
  }, [projectId, props.preferredRunId, props.runs])

  const loadRun = useCallback(async (): Promise<void> => {
    const requestedRunId = runId
    const request = ++runRequestRef.current
    if (requestedRunId === undefined) { setRunView(undefined); setSpatial(undefined); setRecords(undefined); setPlay(undefined); return }
    const [next, nextSpatial, nextRecords] = await Promise.all([
      props.runs.view({ runId: requestedRunId }),
      props.runs.spatial({ runId: requestedRunId, maxNodes: 1_500 }),
      props.runs.records({ runId: requestedRunId, limit: 60, tail: true }),
    ])
    if (request !== runRequestRef.current || activeRunIdRef.current !== requestedRunId) return
    setRunView(next)
    setSpatial(nextSpatial)
    setRecords(nextRecords)
    const ids = actorIds(next)
    setActorId((current) => {
      const selected = current !== undefined && ids.includes(current) ? current
        : props.preferredActorId !== undefined && ids.includes(props.preferredActorId)
          ? props.preferredActorId : ids[0]
      activeActorIdRef.current = selected
      return selected
    })
  }, [props.preferredActorId, props.runs, runId])

  const refreshPlay = useCallback(async (): Promise<void> => {
    const requestedRunId = runId
    const requestedActorId = actorId
    const request = ++playRequestRef.current
    if (requestedRunId === undefined || requestedActorId === undefined) { setPlay(undefined); return }
    const next = await props.narrative.open({
      runId: requestedRunId,
      actorId: requestedActorId,
      camera,
    })
    if (request !== playRequestRef.current || activeRunIdRef.current !== requestedRunId
      || activeActorIdRef.current !== requestedActorId) return
    setPlay(next)
  }, [actorId, camera, props.narrative, runId])

  useEffect(() => { void loadRuns().catch((reason: unknown) => { setError(userFacingStoryError(reason)) }) }, [loadRuns])
  useEffect(() => { void loadRun().catch((reason: unknown) => { setError(userFacingStoryError(reason)) }) }, [loadRun])
  useEffect(() => { void refreshPlay().catch((reason: unknown) => { setError(userFacingStoryError(reason)) }) }, [refreshPlay])
  useEffect(() => { setManualViewpoint(false) }, [runId])
  useEffect(() => {
    if (typeof props.narrative.storyStage !== 'function') return
    void props.narrative.storyStage().then(setStage).catch(() => {})
  }, [props.narrative])
  useEffect(() => {
    let active = true
    void props.ai.catalog().then((catalog) => {
      if (!active) return
      const available = catalog.models.filter(model => model.contextWindow !== undefined)
      setModels(available)
      setSelectedModel(current => current !== '' ? current
        : available[0] === undefined ? '' : `${available[0].provider}\u0000${available[0].id}`)
      setSelectedDirectorModel(current => current !== '' ? current
        : available[0] === undefined ? '' : `${available[0].provider}\u0000${available[0].id}`)
    }).catch((reason: unknown) => {
      if (active) setError(userFacingStoryError(reason))
    })
    return () => { active = false }
  }, [props.ai])
  useEffect(() => {
    const route = runView?.snapshot.modelPolicy.routes.narrator
    if (route !== undefined) {
      setSelectedModel(`${route.provider}\u0000${route.model}`)
      setSelectedReasoning(route.reasoningEffort ?? '')
    }
    props.onNarratorRouteChange?.(route)
  }, [props.onNarratorRouteChange, runView?.snapshot.modelPolicy.routes.narrator])
  useEffect(() => {
    const route = runView?.snapshot.modelPolicy.routes.creative
      ?? runView?.snapshot.modelPolicy.routes.narrator
    if (route === undefined) return
    setSelectedDirectorModel(`${route.provider}\u0000${route.model}`)
    setSelectedDirectorReasoning(route.reasoningEffort ?? '')
  }, [runView?.snapshot.modelPolicy.routes.creative, runView?.snapshot.modelPolicy.routes.narrator])
  useEffect(() => {
    if ((props.modelSettingsSignal ?? 0) > 0) setPanel('settings')
  }, [props.modelSettingsSignal])
  useEffect(() => {
    const lifecycle = { active: true }
    void (async () => {
      try {
        const tree = await props.projects.tree({ projectId, path: 'characters', limit: 500 })
        const documents = await Promise.all(tree.entries
          .filter(item => item.kind === 'document' && item.path.endsWith('.md'))
          .map(item => props.projects.read({ projectId, path: item.path })))
        if (lifecycle.active) {
          setAuthoredNames(new Map(documents.flatMap((document) => {
            const title = documentTitle(document)
            return title === undefined
              ? []
              : [[document.path.replace(/\\/gu, '/'), title] as const]
          })))
        }
      } catch {
        if (lifecycle.active) setAuthoredNames(new Map())
      }
    })()
    return () => { lifecycle.active = false }
  }, [projectId, props.projects])
  useEffect(() => {
    if (play === undefined) return
    setRetryPlans(current => Object.fromEntries(play.saves.map((save) => {
      const plans = save.checkpoint.snapshot.actionDecks[play.choices.actorId]?.plans ?? []
      const selected = current[save.checkpoint.id]
      const retained = selected !== undefined && plans.some(plan => plan.id === selected)
      return [save.checkpoint.id, retained ? selected : plans[0]?.id ?? '']
    })))
  }, [play])

  const mutate = async (key: string, operation: () => Promise<void>): Promise<void> => {
    const hadActiveRun = runId !== undefined
    setBusy(key); setError(undefined); setRetryNotice(undefined)
    try {
      await operation()
      await loadRuns()
      if (hadActiveRun) {
        await loadRun()
        await refreshPlay()
      }
    }
    catch (reason) { setError(userFacingStoryError(reason)) }
    finally { setBusy(undefined); setAgentPhase(undefined) }
  }

  const beginNewRun = async (): Promise<void> => {
    await mutate('create-run', async () => {
      const created = await props.runs.create({
        projectId,
        seed: newWorldlineSeed(),
        startPaused: false,
      })
      selectRun(created.summary.runId)
      selectActor(undefined)
      setChoicePlan(undefined)
      setPanel(undefined)
      props.onRunsChanged()
    })
  }

  const advanceStory = async (targetRunId: RunSummary['runId'], duration: number): Promise<void> => {
    const current = await props.runs.view({ runId: targetRunId })
    const active = current.summary.status === 'paused' ? await props.runs.resume({ runId: targetRunId }) : current
    if (active.summary.status !== 'running') throw new Error('当前世界线已经结束，无法继续推进故事。')
    await props.runs.advance({ runId: targetRunId, duration: Math.max(1, duration), maxEvents: 10_000 })
  }

  const causalEventIds = async (
    targetRunId: RunSummary['runId'],
    actionId: ActionId | undefined,
  ): Promise<readonly string[] | undefined> => {
    if (actionId === undefined) return undefined
    const page = await props.runs.records({
      runId: targetRunId,
      stream: 'world-event',
      limit: 200,
      tail: true,
    })
    const ids = page.records.flatMap((item) => {
      const event = record(item.payload)
      return event?.['actionId'] === actionId ? [item.id] : []
    })
    return ids.length === 0 ? undefined : ids
  }

  const streamNarration = async (
    targetRunId: RunSummary['runId'],
    targetActorId: EntityId,
    actionId?: ActionId,
    eventIds?: readonly string[],
    playerIntent?: string,
  ): Promise<void> => {
    const recovery: NarrativeRecovery = {
      kind: 'narrative',
      runId: targetRunId,
      actorId: targetActorId,
      ...(actionId === undefined ? {} : { actionId }),
      ...(eventIds === undefined ? {} : { eventIds }),
      ...(playerIntent === undefined ? {} : { playerIntent }),
    }
    setFailedStage(recovery)
    setStreamingText('')
    setStreamingMedia([])
    setAgentPhase('context')
    try {
      await props.narrative.narrateStream({
        runId: targetRunId,
        actorId: targetActorId,
        camera,
        ...(actionId === undefined ? {} : { actionId }),
        ...(eventIds === undefined ? {} : { eventIds }),
        ...(playerIntent === undefined || playerIntent.trim() === '' ? {} : {
          playerIntent: playerIntent.trim(),
        }),
      }, (chunk) => {
        if (chunk.type === 'phase') {
          setAgentPhase(chunk.phase)
          setRetryNotice(undefined)
          return
        }
        if (chunk.type === 'retry') {
          setAgentPhase(chunk.phase)
          setRetryNotice({
            attempt: chunk.attempt,
            ...(chunk.maxAttempts === undefined ? {} : { maxAttempts: chunk.maxAttempts }),
            delayMs: chunk.delayMs,
            code: chunk.failure.code,
          })
          return
        }
        if (chunk.type === 'media') setStreamingMedia(current => [...current, chunk.cue])
        if (chunk.type === 'text-delta') setStreamingText(current => current + chunk.text)
        if (chunk.type === 'replace') setStreamingText(chunk.text)
      })
      setFailedStage(undefined)
    } finally {
      setStreamingText('')
      setStreamingMedia([])
      setAgentPhase(undefined)
      setRetryNotice(undefined)
    }
  }

  const entities = snapshotEntities(runView?.snapshot)
  const ids = actorIds(runView)
  const names = useMemo(() => new Map(ids.map((id, index) => {
    const authored = authoredNames.get(sourcePathOf(entities?.[id]) ?? '')
    return [id, authored ?? entityName(entities, id, index)]
  })), [authoredNames, entities, ids])
  const calendar = play === undefined ? undefined : gameCalendar(play.run.snapshot)
  const viewpointEntity = play === undefined ? undefined : record(entities?.[play.choices.actorId])
  const viewpointFacts = characterFacts(viewpointEntity)
    .filter(fact => ['体力', '精力', '健康', '饥饿', '情绪', '心情', '好感', '羁绊', '压力', '理智', '感染', '伤势'].includes(fact.label))
    .slice(0, 4)
  const presentNames = play?.frame.presentEntityIds.map((id, index) => names.get(id) ?? entityName(entities, id, index)) ?? []
  const narrativeBeats = useMemo(() => coalesceNarrativeBeats(play?.beats ?? []), [play?.beats])
  const latestBeat = narrativeBeats.at(-1)
  const speakerId = latestBeat?.speakerId ?? play?.choices.actorId
  const speakerEntity = speakerId === undefined ? undefined : record(entities?.[speakerId])
  const speaker = speakerId === undefined ? '旁白' : names.get(speakerId) ?? entityName(entities, speakerId)
  const resources = characterResources(projectId, speakerEntity)
  const speakerArtwork = defaultCharacterArtwork(speakerId ?? speaker)
  const placeState = play === undefined ? undefined : record(play.frame.visibleState['place'])
  const sceneCues = latestBeat?.media.length ? latestBeat.media : play?.frame.media ?? []
  const background = cueUrl(projectId, latestCue(sceneCues, ['background']))
    ?? projectMediaUrl(projectId, typeof placeState?.['background'] === 'string' ? placeState['background'] : undefined)
    ?? DEFAULT_ARTWORK.place
  const activeBgm = cueUrl(projectId, latestCue(sceneCues, ['bgm'])) ?? resources.theme
  const worldState = play === undefined ? undefined : record(play.run.snapshot.state['world'])
  const environmentFacts = play === undefined ? [] : worldEnvironmentFacts(play.run.snapshot)
  const environment = environmentLabel(record(play?.frame.visibleState['environment']))
    ?? environmentLabel(worldState)
  const selectedCharacterEntity = actorId === undefined ? undefined : record(entities?.[actorId])
  const selectedCharacterResources = characterResources(projectId, selectedCharacterEntity)
  const selectedProfileFacts = characterProfileFacts(selectedCharacterEntity)
  const selectedCharacterFacts = characterFacts(selectedCharacterEntity)
  const selectedMemorySections = characterMemorySections(selectedCharacterEntity)
  const recentWorldEvents = records?.records.slice(-12).reverse() ?? []
  const recentStateCommits = play === undefined ? [] : Object.values(
    play.run.snapshot.storyStateCommits,
  ).sort((left, right) => right.sequence - left.sequence).slice(0, 6)
  const scheduledWorldChanges = play?.run.snapshot.futureEvents
    .filter(item => item.kind === 'plot-time-control').sort((left, right) => left.due - right.due) ?? []
  const activeWorldProcesses = play?.run.snapshot.processes.filter(item => (
    item.state !== 'completed' && item.state !== 'cancelled' && item.state !== 'failed'
  )) ?? []
  const selectedPosition = spatial?.actors.find(item => item.actorId === actorId)
  const selectedMovement = spatial?.movements.find(item => item.actorId === actorId)
  const narratorRoute = runView?.snapshot.modelPolicy.routes.narrator
  const selectedModelInfo = models.find(model => `${model.provider}\u0000${model.id}` === selectedModel)
  const selectedDirectorModelInfo = models.find(model => (
    `${model.provider}\u0000${model.id}` === selectedDirectorModel
  ))
  const narratorConfigured = narratorRoute !== undefined
  const modelReady = narratorConfigured
  const llmReady = modelReady
  const openingKey = play === undefined
    ? undefined
    : `${play.run.summary.runId}:${String(play.choices.actorId)}`
  const completedLatestBeat = play !== undefined && latestBeat !== undefined
    && play.run.snapshot.presentationCursors[play.choices.actorId]?.completedBeatId === latestBeat.id

  useEffect(() => {
    // A retained beat is the durable owner of its presentation, state settlement,
    // and final choice-director invocation. Prefer that persisted perspective even
    // when the run and prose arrive in separate requests during page restoration.
    // Only a world with no prose may follow the next authored focus suggestion.
    if (play === undefined) return
    const visibleSuggestions = play.script.suggestedActorIds.filter(id => ids.includes(id))
    const suggested = shouldFollowSuggestedActor(
      manualViewpoint,
      latestBeat?.perspectiveActorId,
      actorId,
      visibleSuggestions,
    )
    if (suggested !== undefined) selectActor(suggested)
  }, [actorId, ids, latestBeat?.perspectiveActorId, manualViewpoint, play])
  const sceneSuggestions = play !== undefined
    && choicePlan?.sequence === play.choices.sequence
    && choicePlan.afterBeatId === latestBeat?.id
    ? choicePlan.suggestions
    : []
  const inlineVisuals = useMemo(() => {
    const result = new Map<string, string>()
    let previous: string | undefined
    for (const beat of narrativeBeats) {
      const visual = cueUrl(projectId, latestCue(beat.media, ['expression', 'portrait']))
      if (visual !== undefined && visual !== previous) result.set(beat.id, visual)
      previous = visual ?? previous
    }
    return result
  }, [narrativeBeats, projectId])
  const inlineScenes = useMemo(() => {
    const result = new Set<string>()
    let previous: string | undefined
    for (const beat of narrativeBeats) {
      const scene = cueUrl(projectId, latestCue(beat.media, ['background']))
      if (scene !== undefined && scene !== previous) result.add(beat.id)
      previous = scene ?? previous
    }
    return result
  }, [narrativeBeats, projectId])

  useEffect(() => {
    if (!llmReady || play === undefined || latestBeat === undefined
      || play.choices.choices.length === 0) {
      setChoicePlan(undefined)
      setChoicePlanning(false)
      return
    }
    let active = true
    const sequence = play.choices.sequence
    setChoicePlan(undefined)
    setChoicePlanning(true)
    setAgentPhase('choices')
    void props.narrative.suggest({
      runId: play.run.summary.runId,
      actorId: play.choices.actorId,
      camera,
    }).then((plan) => {
      if (!active || plan.sequence !== sequence) return
      setChoicePlan(plan)
      setFailedStage(undefined)
    }).catch((reason: unknown) => {
      if (active) {
        setChoicePlan(undefined)
        setFailedStage({
          kind: 'choices',
          runId: play.run.summary.runId,
          actorId: play.choices.actorId,
          sequence,
        })
        setError(userFacingStoryError(reason))
      }
    }).finally(() => {
      if (active) {
        setChoicePlanning(false)
        setAgentPhase(undefined)
      }
    })
    return () => { active = false }
  }, [camera, latestBeat?.id, llmReady, play?.choices.actorId,
    play?.choices.sequence, play?.run.summary.runId, props.narrative])

  useEffect(() => {
    if (!llmReady || play === undefined || openingKey === undefined
      || narrativeBeats.length > 0 || busy !== undefined
      || openingAttemptedRef.current === openingKey) return
    openingAttemptedRef.current = openingKey
    setOpeningAttemptedKey(openingKey)
    queueMicrotask(() => {
      void mutate('opening', async () => {
        await streamNarration(
          play.run.summary.runId,
          play.choices.actorId,
          undefined,
          undefined,
        )
      })
    })
  }, [busy, llmReady, narrativeBeats.length, openingAttemptedKey, openingKey,
    play?.choices.actorId, play?.run.summary.runId])

  const chooseChoice = (
    plan: ActionPlan,
  ): void => {
    if (play === undefined) return
    if (!modelReady) {
      setPanel('settings')
      setError('这条世界线尚未启用 LLM 叙事。请先选择叙事模型；在此之前不会执行行动。')
      return
    }
    setAutoFollow(true)
    setPanel(undefined)
    void mutate(`choice:${plan.id}`, async () => {
      setAgentPhase('runtime')
      const submitted = await props.narrative.choose({
        runId: play.run.summary.runId,
        actorId: play.choices.actorId,
        planId: plan.id,
        expectedSequence: play.choices.sequence,
        camera,
      })
      await advanceStory(play.run.summary.runId, plan.estimatedDuration)
      const eventIds = await causalEventIds(play.run.summary.runId, submitted.actionId)
      await streamNarration(
        play.run.summary.runId,
        play.choices.actorId,
        submitted.actionId,
        eventIds,
        plan.intent,
      )
    })
  }

  const submitFreeAction = (value: string): void => {
    if (play === undefined || value.trim() === '') return
    if (!modelReady) {
      setPanel('settings')
      setError('这条世界线尚未启用 LLM 叙事。请先选择叙事模型；在此之前不会执行行动。')
      return
    }
    setAutoFollow(true)
    setPanel(undefined)
    void mutate('free', async () => {
      setAgentPhase('runtime')
      const result = await props.narrative.freeInput({
        runId: play.run.summary.runId,
        actorId: play.choices.actorId,
        text: value.trim(),
        expectedSequence: play.choices.sequence,
        camera,
      })
      if (result.status === 'unmatched') throw new Error('这句话还无法对应到当前可执行的行动，请描述得更具体一些。')
      if (result.status === 'ambiguous') throw new Error(`可能的行动有：${result.candidates.map(item => item.label).join('、')}。请再明确一点。`)
      const duration = result.candidates[0]?.estimatedDuration
      if (duration !== undefined) await advanceStory(play.run.summary.runId, duration)
      const eventIds = await causalEventIds(play.run.summary.runId, result.action?.actionId)
      await streamNarration(
        play.run.summary.runId,
        play.choices.actorId,
        result.action?.actionId,
        eventIds,
        value.trim(),
      )
      setFreeText('')
    })
  }

  const retryFailedStoryStage = (): void => {
    if (failedStage === undefined) return
    if (failedStage.kind === 'narrative') {
      void mutate('retry-narrative', async () => {
        await streamNarration(
          failedStage.runId,
          failedStage.actorId,
          failedStage.actionId,
          failedStage.eventIds,
          failedStage.playerIntent,
        )
      })
      return
    }
    setError(undefined)
    setChoicePlanning(true)
    setAgentPhase('choices')
    void props.narrative.suggest({
      runId: failedStage.runId,
      actorId: failedStage.actorId,
      camera,
    }).then((plan) => {
      setChoicePlan(plan)
      setFailedStage(undefined)
    }).catch((reason: unknown) => {
      setError(userFacingStoryError(reason))
    }).finally(() => {
      setChoicePlanning(false)
      setAgentPhase(undefined)
    })
  }

  useEffect(() => {
    if (!autoPlay || play === undefined || busy !== undefined) return
    const mainlinePlan = sceneSuggestions.find(plan => plan.storyRole === 'advance')
    if (mainlinePlan === undefined) return
    queueMicrotask(() => { chooseChoice(mainlinePlan) })
  }, [autoPlay, busy, play?.run.snapshot.sequence,
    sceneSuggestions.find(plan => plan.storyRole === 'advance')?.id])

  const currentBeat = narrativeBeats.at(-1)
  const stageBeats = storyStageWindow(narrativeBeats)
  const stageStartIndex = Math.max(0, narrativeBeats.length - stageBeats.length)
  const currentBeatBlocks = currentBeat === undefined
    ? []
    : playbackBlocks(currentBeat)
  const completedBeatId = play === undefined
    ? undefined
    : play.run.snapshot.presentationCursors[play.choices.actorId]?.completedBeatId
  const revealedAudio = currentBeatBlocks.slice(0, reveal.beatId === currentBeat?.id ? reveal.length : 0)
    .findLast((block): block is Extract<NarrativeBlock, { type: 'media' }> => (
      block.type === 'media' && (block.cue.type === 'voice' || block.cue.type === 'sfx')
    ))
  const activeVoice = cueUrl(projectId, revealedAudio?.cue)
  const revealing = currentBeat !== undefined
    && reveal.beatId === currentBeat.id
    && reveal.length < currentBeatBlocks.length
  const typingBlockIndex = currentBeat === undefined || reveal.beatId !== currentBeat.id
    ? -1
    : reveal.length - 1
  const typingBlock = currentBeatBlocks[typingBlockIndex]
  const typingText = typingBlock?.type === 'narration' || typingBlock?.type === 'character'
    ? typingBlock.text
    : undefined
  const typingMatches = currentBeat !== undefined
    && typing.beatId === currentBeat.id
    && typing.blockIndex === typingBlockIndex
  const typingInProgress = typingText !== undefined
    && (!typingMatches || typing.length < typingText.length)
  const storyAdvancing = revealing || typingInProgress
  const activeAgentStages = agentPhase === undefined ? [] : storyAgentStages(agentPhase)
  const activeAgentStage = activeAgentStages.find(item => item.status === 'active')

  useEffect(() => {
    if (currentBeat === undefined) return
    const initial = initialStoryPlayback(currentBeat, completedBeatId)
    setReveal({ beatId: currentBeat.id, length: initial.revealLength })
    setTyping({
      beatId: currentBeat.id,
      blockIndex: initial.blockIndex,
      length: initial.typingLength,
    })
  }, [calendar?.fullLabel, completedBeatId, currentBeat?.id, currentBeat?.text])

  useEffect(() => {
    if (currentBeat === undefined || typingText === undefined || typingBlockIndex < 0) return
    setTyping(current => current.beatId === currentBeat.id
      && current.blockIndex === typingBlockIndex
      ? current
      : { beatId: currentBeat.id, blockIndex: typingBlockIndex, length: 0 })
  }, [currentBeat?.id, typingBlockIndex, typingText])

  useEffect(() => {
    if (currentBeat === undefined || typingText === undefined || !typingMatches
      || typing.length >= typingText.length) return
    const timer = window.setTimeout(() => {
      setTyping(current => current.beatId === currentBeat.id
        && current.blockIndex === typingBlockIndex
        ? { ...current, length: Math.min(typingText.length, current.length + 1) }
        : current)
    }, 22)
    return () => { window.clearTimeout(timer) }
  }, [currentBeat?.id, typing.length, typingBlockIndex, typingMatches, typingText])

  useEffect(() => {
    if (play === undefined || currentBeat === undefined || completedBeatId === currentBeat.id
      || reveal.beatId !== currentBeat.id || reveal.length !== currentBeatBlocks.length
      || typingInProgress) return
    const key = `${play.run.summary.runId}\u0000${play.choices.actorId}\u0000${currentBeat.id}`
    if (presentationWritesRef.current.has(key)) return
    presentationWritesRef.current.add(key)
    void props.runs.completePresentation({
      runId: play.run.summary.runId,
      actorId: play.choices.actorId,
      beatId: currentBeat.id,
    }).then((result) => {
      setRunView(result.view)
      setPlay(current => current?.run.summary.runId === result.view.summary.runId
        ? { ...current, run: result.view }
        : current)
    }).catch((reason: unknown) => {
      presentationWritesRef.current.delete(key)
      setError(userFacingStoryError(reason))
    })
  }, [completedBeatId, currentBeat?.id, currentBeatBlocks.length, play?.choices.actorId,
    play?.run.summary.runId, props.runs, reveal.beatId, reveal.length, typingInProgress])

  const completeOrRevealNext = (): void => {
    if (currentBeat === undefined) return
    if (typingText !== undefined && typingInProgress) {
      setTyping({ beatId: currentBeat.id, blockIndex: typingBlockIndex, length: typingText.length })
      setAutoFollow(true)
      return
    }
    if (!revealing) return
    setReveal(current => ({
      beatId: currentBeat.id,
      length: Math.min(currentBeatBlocks.length, current.length + 1),
    }))
    setAutoFollow(true)
  }

  useEffect(() => {
    if (panel !== 'choices' && panel !== 'free') return
    requestAnimationFrame(() => { pauseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) })
  }, [panel])

  const followLatest = useCallback((behavior: ScrollBehavior = 'smooth'): void => {
    const target = readingScrollRef.current
    if (target === null) return
    if (typeof target.scrollTo === 'function') {
      target.scrollTo({ top: target.scrollHeight, behavior })
    } else {
      target.scrollTop = target.scrollHeight
    }
  }, [])

  useEffect(() => {
    if (currentBeat === undefined || !autoFollow) return
    requestAnimationFrame(() => { followLatest('smooth') })
  }, [autoFollow, currentBeat?.id, followLatest])

  useEffect(() => {
    if (!autoFollow || currentBeat === undefined || reveal.beatId !== currentBeat.id) return
    requestAnimationFrame(() => { followLatest('auto') })
  }, [autoFollow, currentBeat?.id, followLatest, reveal.beatId, reveal.length, typing.length])

  useEffect(() => {
    if (!autoFollow || busy !== undefined) return
    requestAnimationFrame(() => { followLatest('smooth') })
  }, [autoFollow, busy, followLatest, play?.choices.sequence])

  return <div className={css.page}>
    {error !== undefined && <div className={css.error} role="alert"><span>{error}</span><div>
      {failedStage !== undefined && <button type="button" data-retry onClick={() => {
        retryFailedStoryStage()
      }}>立即重试当前阶段</button>}
      <button type="button" onClick={() => { setError(undefined) }}>关闭</button>
    </div></div>}
    {play === undefined || calendar === undefined ? <div className={css.empty}><span>❧</span><h3>故事尚未开场</h3><p>{runs.length === 0 ? '从这里开启世界；剧情、地图、角色状态与小说正文将使用同一条世界线。' : '这条世界线还没有可用的角色视角。'}</p><div className={css.emptyActions}>{runs.length === 0 && <button type="button" data-primary disabled={busy !== undefined} onClick={() => { void beginNewRun() }}>开启视觉演绎</button>}<button type="button" onClick={props.onImportRun}>导入世界线</button></div></div> : <main className={css.stage} aria-label="视觉互动小说" data-has-background>
      <ArtworkImage className={css.background} sources={[background, DEFAULT_ARTWORK.place]} alt="" />
      <div className={css.stageShade} />

      <aside className={css.worldPanel} aria-label="当前世界与角色状态" aria-live="polite">
        <span>{calendar.dateLabel}</span>
        <strong>{calendar.timeLabel}</strong>
        <span>{scenePlace(play, spatial)}{environment === undefined ? '' : ` · ${environment}`}</span>
        <span className={css.viewpointLabel}>{names.get(play.choices.actorId) ?? '当前角色'}</span>
        {viewpointFacts.length > 0 && <div className={css.liveFacts}>
          {viewpointFacts.map(fact => <span key={fact.label}>{fact.label} {fact.value}</span>)}
        </div>}
        {environmentFacts.length > 0 && <div className={css.environmentFacts}>
          {environmentFacts.map(fact => <span key={fact.label} data-level={fact.level}>
            {fact.label} {fact.value}
          </span>)}
        </div>}
      </aside>
      <nav className={css.playerTools} aria-label="故事工具">
        <button type="button" aria-label="实时世界" title="实时世界" onClick={() => { setPanel('world') }}>界</button>
        <button type="button" aria-label="故事回顾" title="故事回顾" onClick={() => { setPanel('history') }}>回</button>
        <button type="button" aria-label="角色资料" title="角色资料" onClick={() => { setPanel('character') }}>角</button>
        <button type="button" aria-label="存档" title="存档" onClick={() => { setPanel('saves') }}>存</button>
        <button type="button" aria-label="设置" title="设置" onClick={() => { setPanel('settings') }}>设</button>
        <button type="button" aria-label={muted ? '开启声音' : '静音'} title={muted ? '开启声音' : '静音'} onClick={() => { setMuted(value => !value) }}>{muted ? '静' : '声'}</button>
      </nav>

      <div ref={readingScrollRef} className={css.readingScroll} onScroll={(event) => {
        const target = event.currentTarget
        if (target.scrollHeight - target.scrollTop - target.clientHeight < 72 && !autoFollow) setAutoFollow(true)
      }} onWheel={(event) => { if (event.deltaY < 0) setAutoFollow(false) }} onClick={() => {
        completeOrRevealNext()
      }}>
        <article className={css.readingColumn} aria-live="polite">
          <section className={css.storyLog} aria-label="小说正文">
            {narrativeBeats.length === 0 && streamingText === '' && <article className={css.storyEntry}><header><strong>序章</strong><small>00</small></header><p>{busy === 'opening'
              ? '镜头正在亮起。故事导演正在依据真实的时间、地点、环境与人物状态铺陈第一幕……'
              : openingAttemptedKey === openingKey && error !== undefined
                ? '第一幕没有成功生成。世界尚未推进，你可以重新尝试开场。'
                : '故事会先从此刻的世界与人物处境开始，序章演出完成后才会交还行动。'}</p>{openingAttemptedKey === openingKey && error !== undefined && <button type="button" onClick={(event) => { event.stopPropagation(); setError(undefined); openingAttemptedRef.current = undefined; setOpeningAttemptedKey(undefined) }}>重新生成开场</button>}</article>}
            {stageBeats.map((beat, stageIndex) => {
              const index = stageStartIndex + stageIndex
              const beatSpeaker = beat.speakerId === undefined ? '旁白' : names.get(beat.speakerId) ?? entityName(entities, beat.speakerId, index)
              const isCurrent = beat.id === currentBeat?.id
              const blocks = playbackBlocks(beat)
              const visibleBlocks = isCurrent ? blocks.slice(0, reveal.beatId === beat.id ? reveal.length : 0) : blocks
              const visual = inlineVisuals.get(beat.id)
              return <section key={beat.id} className={css.storyMoment}
                data-current={isCurrent || undefined}>
                {inlineScenes.has(beat.id) && <aside className={css.sceneCard}><small>场景流转</small><strong>{scenePlace(play, spatial)}</strong><span>{calendar.dateLabel} · {calendar.timeLabel}{environment === undefined ? '' : ` · ${environment}`}</span></aside>}
                {visual !== undefined && <figure className={css.inlineIllustration}><StoryImage
                  sources={[visual, resources.expression, resources.portrait, speakerArtwork]}
                  alt={`${beatSpeaker}的场景插图`}
                  fallbackLabel={beatSpeaker}
                /></figure>}
                {visibleBlocks.map((block, blockIndex) => {
                  const isLast = blockIndex === visibleBlocks.length - 1
                  if (block.type === 'media') {
                    const source = cueUrl(projectId, block.cue)
                    if (source === undefined) return null
                    const visual = block.cue.type === 'background' || block.cue.type === 'portrait'
                      || block.cue.type === 'expression'
                    return <figure ref={isCurrent && isLast ? currentEntryRef : undefined} key={`${beat.id}:block:${String(blockIndex)}`} className={css.storyMedia} data-kind={block.cue.type} data-current={isCurrent && isLast || undefined}>
                      {visual
                        ? <StoryImage
                          sources={block.cue.type === 'background'
                            ? [source, background, DEFAULT_ARTWORK.place]
                            : [source, resources.expression, resources.portrait, speakerArtwork]}
                          alt={block.caption ?? `${beatSpeaker}的故事画面`}
                          fallbackLabel={beatSpeaker}
                        />
                        : <audio controls muted={muted} src={source}>当前浏览器无法播放这段音频。</audio>}
                      {block.caption !== undefined && <figcaption>{block.caption}</figcaption>}
                    </figure>
                  }
                  if (block.type === 'media-intent') {
                    return <MediaIntentPlaceholder
                      ref={isCurrent && isLast ? currentEntryRef : undefined}
                      key={`${beat.id}:block:${String(blockIndex)}`}
                      intent={block.intent}
                      current={isCurrent && isLast}
                    />
                  }
                  if (block.type === 'state') {
                    const subject = block.cue.actorId === undefined
                      ? block.cue.scope === 'environment' ? '环境'
                        : block.cue.scope === 'relationship' ? '关系' : '世界'
                      : names.get(block.cue.actorId) ?? '角色'
                    return <aside
                      ref={isCurrent && isLast ? currentEntryRef : undefined}
                      key={`${beat.id}:block:${String(blockIndex)}`}
                      className={css.statePulse}
                      data-tone={block.cue.tone}
                      data-current={isCurrent && isLast || undefined}
                      aria-label={`${subject}${block.cue.label}变化`}>
                      <span aria-hidden="true">{block.cue.tone === 'positive' ? '↑' : block.cue.tone === 'danger' ? '!' : block.cue.tone === 'warning' ? '↓' : '·'}</span>
                      <div><small>{subject} · {block.cue.label}</small><strong>
                        {block.cue.before === undefined
                          ? block.cue.value
                          : <><del>{block.cue.before}</del><i>→</i>{block.cue.value}</>}
                      </strong></div>
                    </aside>
                  }
                  if (block.type === 'narration') {
                    const text = isCurrent && isLast && typingText !== undefined
                      ? block.text.slice(0, typingMatches ? typing.length : 0)
                      : block.text
                    return <article
                      ref={isCurrent && isLast ? currentEntryRef : undefined}
                      key={`${beat.id}:block:${String(blockIndex)}`}
                      className={css.storyEntry}
                      data-current={isCurrent && isLast || undefined}>
                      <header><strong>旁白</strong><small>{String(index + 1).padStart(2, '0')}</small></header>
                      <MarkdownText text={text} />
                    </article>
                  }
                  const blockEntity = record(entities?.[block.actorId])
                  const blockName = names.get(block.actorId) ?? entityName(entities, block.actorId, blockIndex)
                  const blockResources = characterResources(projectId, blockEntity)
                  const avatar = blockResources.expression ?? blockResources.portrait
                  const mode = block.mode === 'thought' ? '心声' : block.mode === 'action' ? '动作' : '对话'
                  return <article
                    ref={isCurrent && isLast ? currentEntryRef : undefined}
                    key={`${beat.id}:block:${String(blockIndex)}`}
                    className={css.characterMessage}
                    data-mode={block.mode}
                    data-current={isCurrent && isLast || undefined}>
                    <div className={css.messageAvatar}><StoryImage
                      sources={[avatar, blockResources.portrait, defaultCharacterArtwork(String(block.actorId))]}
                      alt=""
                      fallbackLabel={blockName}
                    /></div>
                    <div><header><strong>{blockName}</strong><small>{mode}</small></header><p>{isCurrent && isLast && typingText !== undefined
                      ? block.text.slice(0, typingMatches ? typing.length : 0)
                      : block.text}</p></div>
                  </article>
                })}
                {isCurrent && storyAdvancing && <button
                  type="button"
                  className={css.continueStory}
                  onClick={(event) => { event.stopPropagation(); completeOrRevealNext() }}>
                  {typingInProgress ? '显示整段' : '点击继续'} <span>↓</span>
                </button>}
              </section>
            })}
            {(streamingText !== '' || streamingMedia.length > 0) && <aside className={css.composingCard}><span /> <strong>世界正在编排下一幕…</strong><small>完整场景就绪后，将由你逐条放出</small></aside>}
          </section>

          {!llmReady && !storyAdvancing && <section className={css.llmRequired}
            aria-label="启用 LLM 叙事">
            <strong>故事叙事者尚未连接</strong>
            <p>选择不会在没有小说正文的情况下继续消耗世界时间。请连接一个世界线 LLM 模型后再开始。</p>
            <button type="button" onClick={(event) => {
              event.stopPropagation(); setPanel('settings')
            }}>连接叙事模型</button>
          </section>}
          {llmReady && narrativeBeats.length > 0 && completedLatestBeat && !storyAdvancing
            && busy === undefined && streamingText === '' && <section
            ref={pauseRef}
            className={css.interactionPoint}
            aria-label="决定下一步"
            onClick={(event) => { event.stopPropagation() }}>
            <div className={css.choicePanel}>
              <header className={css.interactionHeader}>
                <strong>此刻，你想怎么做？</strong>
                <small>故事导演 Agent 会结合剧情与实时世界提出三个方向；它们只是建议，你也可以自由描述任何尝试。</small>
              </header>
              {choicePlanning && <small className={css.choicePlanning}>正在结合剧本与此刻生成选择…</small>}
              {sceneSuggestions.length > 0 && <div className={css.choices}>
                {sceneSuggestions.map(item => <button
                  type="button"
                  key={item.id}
                  data-story-role={item.storyRole}
                  onClick={() => { chooseChoice(item) }}>
                  <strong>{item.label}</strong>
                </button>)}
              </div>}
              <form className={css.freeAction} onSubmit={(event) => { event.preventDefault(); submitFreeAction(freeText) }}>
                <textarea value={freeText} onChange={(event) => { setFreeText(event.target.value) }} placeholder="用自然语言说出你的反应、对话或尝试…" />
                <div><button type="submit" disabled={freeText.trim() === ''}>让世界回应</button></div>
              </form>
            </div>
          </section>}

          {busy !== undefined && streamingText === '' && agentPhase === undefined && <p className={css.worldResponding}>{busy === 'opening' ? '正在生成开场序章…' : '世界正在结算你的选择…'}</p>}
        </article>
      </div>
      {activeAgentStage !== undefined && <aside className={`${css.agentProgress} ${css.agentProgressDock}`}
        data-retrying={retryNotice === undefined ? undefined : 'true'}
        aria-label={`故事推演阶段：${activeAgentStage.label}`} aria-live="polite">
        <header><span>故事推演</span><strong>{retryNotice === undefined
          ? activeAgentStage.label
          : `${activeAgentStage.label} · 自动恢复中`}</strong>
        <small>{retryNotice === undefined
          ? `${String(activeAgentStages.filter(item => item.status === 'done').length + 1)}/${String(activeAgentStages.length)}`
          : `连接中断，${retryNotice.maxAttempts === undefined
            ? `正在进行第 ${String(retryNotice.attempt)} 次尝试`
            : `正在进行第 ${String(retryNotice.attempt)}/${String(retryNotice.maxAttempts)} 次尝试`}，约 ${String(Math.max(1, Math.ceil(retryNotice.delayMs / 1000)))} 秒后继续（${retryNotice.code}）`}</small></header>
        <ol aria-label="推演进度">{activeAgentStages.map((item, index) => <li key={item.id}
          data-status={item.status} title={`${String(index + 1)}. ${item.label}`}><i>{item.status === 'done' ? '✓' : String(index + 1)}</i>
          <span>{item.label}</span></li>)}</ol>
      </aside>}
      {!autoFollow && <button type="button" className={css.resumeFollow} onClick={() => { setAutoFollow(true); followLatest('smooth') }}>回到最新 ↓</button>}

      {panel !== undefined && panel !== 'choices' && panel !== 'free' && <div className={css.overlay} role="presentation" onClick={() => { setPanel(undefined) }}>
        <section className={css.panel} data-panel={panel} role="dialog" aria-modal="true" aria-label="故事菜单" onClick={(event) => { event.stopPropagation() }}>
          <header className={css.panelHeader}>
            <div><small>WORLDLINE INTERACTIVE FICTION</small><h3>{panel === 'world' ? '实时世界' : panel === 'history' ? '故事回顾' : panel === 'character' ? speaker : panel === 'saves' ? '存档与世界线' : '演出设置'}</h3></div>
            <button type="button" aria-label="关闭" onClick={() => { setPanel(undefined) }}>×</button>
          </header>

          {panel === 'world' && <div className={css.worldStatePanel}>
            <div className={css.worldToolbar}>
              <label>世界线<select value={runId ?? ''} onChange={(event) => { selectRun(event.target.value as RunSummary['runId']) }}>{orderedRuns.map((item, index) => <option key={item.runId} value={item.runId}>世界线 {String(index + 1)} · {worldlineLabel(item.status)} · {item.runId.slice(-6)}</option>)}</select></label>
              {runView !== undefined && (runView.summary.status === 'running' || runView.summary.status === 'paused') && <button type="button" disabled={busy !== undefined} onClick={() => {
                void mutate('world-status', async () => {
                  if (runView.summary.status === 'running') await props.runs.pause({ runId: runView.summary.runId })
                  else await props.runs.resume({ runId: runView.summary.runId })
                })
              }}>{runView.summary.status === 'running' ? '暂停世界' : '继续世界'}</button>}
              {runView?.summary.status === 'running' && <button type="button" disabled={busy !== undefined} onClick={() => {
                void mutate('world-advance', async () => { await props.runs.advance({ runId: runView.summary.runId, duration: 600, maxEvents: 10_000 }) })
              }}>流逝 10 分钟</button>}
            </div>
            {spatial !== undefined && <section className={css.liveMapCard}><header><div><small>LIVE MAP</small><strong>{spatial.map?.name ?? '此刻的世界'}</strong></div><span>{calendar.fullLabel}</span></header><LivingMap spatial={spatial} entities={entities} selectedActor={actorId} />{selectedMovement !== undefined && <p>{names.get(selectedMovement.actorId)}正在从{placeName(spatial, selectedMovement.origin)}前往{placeName(spatial, selectedMovement.destination)}，已完成 {String(Math.round(selectedMovement.edgeFraction * 100))}%，预计还需 {gameDuration(selectedMovement.remainingDuration)}。</p>}</section>}
            <div className={css.worldStateGrid}>
              <section><header><small>RESIDENTS</small><strong>全部角色与位置</strong></header><div className={css.residentList}>{ids.map((id, index) => { const position = spatial?.actors.find(item => item.actorId === id); const facts = characterFacts(record(entities?.[id])).slice(0, 4); return <button type="button" key={id} data-active={id === actorId || undefined} onClick={() => { setManualViewpoint(true); selectActor(id) }}><i>{(names.get(id) ?? '角').slice(0, 1)}</i><span><strong>{names.get(id) ?? entityName(entities, id, index)}</strong><small>{placeName(spatial, position?.nodeId)}</small><em>{facts.map(fact => `${fact.label} ${fact.value}`).join(' · ') || '暂无可变属性'}</em></span></button> })}</div></section>
              <section><header><small>STATE</small><strong>{actorId === undefined ? '角色状态' : names.get(actorId) ?? '角色状态'}</strong></header><dl>{characterFacts(actorId === undefined ? undefined : record(entities?.[actorId])).map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>{selectedPosition !== undefined && <p>当前位置：<strong>{placeName(spatial, selectedPosition.nodeId)}</strong></p>}</section>
              <section><header><small>ENVIRONMENT</small><strong>环境与世界状态</strong></header><dl>{environmentFacts.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>{environmentFacts.length === 0 && <p>当前没有需要特别提示的环境变化。</p>}</section>
              <section><header><small>WORLD DIARY</small><strong>最近真实事件</strong></header>{recentWorldEvents.length === 0 ? <p>第一批世界记录正在形成。</p> : <ol>{recentWorldEvents.map((item, index) => <li key={`${String(item.sequence)}:${item.id}`}><i>{String(recentWorldEvents.length - index).padStart(2, '0')}</i><div><strong>{eventTitle(item)}</strong><small>{gameCalendar({ logicalTime: item.logicalTime, state: runView?.snapshot.state ?? {} }).fullLabel}</small></div></li>)}</ol>}</section>
              <section><header><small>ATOMIC DIRECTOR</small><strong>全世界并发更新</strong></header>{recentStateCommits.length === 0 ? <p>正文保存后，世界与全角色分支会在此合并。</p> : <ol>{recentStateCommits.map(commit => <li key={commit.id}><i>{String(commit.shards.length)}</i><div><strong>{commit.deltas.length} 项状态差量 · {commit.memoryWrites.length} 条记忆</strong><small>{commit.mutations.map(item => item.reason).join('；') || '全域已复核，本轮无需变更'}</small></div></li>)}</ol>}</section>
              <section><header><small>TIME GATES</small><strong>未来干预与运行过程</strong></header><dl><div><dt>硬时间门控</dt><dd>{scheduledWorldChanges.length}</dd></div><div><dt>活动过程</dt><dd>{activeWorldProcesses.length}</dd></div></dl>{scheduledWorldChanges.slice(0, 6).map(item => <p key={item.id} className={css.scheduledChange}><strong>{gameCalendar({ logicalTime: item.due, state: runView?.snapshot.state ?? {} }).fullLabel}</strong><br />{scheduledChangeTitle(item.payload)}</p>)}</section>
            </div>
            {runView !== undefined && <footer className={css.worldFooter}><button type="button" onClick={props.onImportRun}>导入世界线</button><button type="button" onClick={() => { props.onExportRun(runView.summary.runId) }}>导出世界线</button><button type="button" disabled={busy !== undefined} onClick={() => { void mutate('checkpoint', async () => { await props.runs.checkpoint({ runId: runView.summary.runId, label: calendar.fullLabel }) }) }}>保存此刻</button></footer>}
          </div>}

          {panel === 'history' && <div className={css.history}>
            {narrativeBeats.length === 0 && <p>故事还没有留下正文。</p>}
            {narrativeBeats.map((beat, index) => <article key={beat.id}><header><strong>{beat.speakerId === undefined ? '旁白' : names.get(beat.speakerId) ?? entityName(entities, beat.speakerId, index)}</strong><small>{String(index + 1).padStart(2, '0')}</small></header><MarkdownText text={playbackTranscript(beat)} /></article>)}
          </div>}

          {panel === 'character' && <div className={css.characterPanel}>
            <div className={css.characterPortrait}><ArtworkImage sources={[selectedCharacterResources.expression, selectedCharacterResources.portrait, defaultCharacterArtwork(String(actorId ?? 'character'))]} alt={`${actorId === undefined ? '角色' : names.get(actorId) ?? '角色'} 的角色视觉`} /></div>
            <div className={css.characterInfo}><h3>{actorId === undefined ? '角色资料' : names.get(actorId) ?? '角色资料'}</h3><p>{presentNames.length === 0 ? '此刻独处' : `在场：${presentNames.join('、')}`}</p><dl><div><dt>当前位置</dt><dd>{placeName(spatial, selectedPosition?.nodeId)}</dd></div>{selectedProfileFacts.map(item => <div key={`profile:${item.label}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}{selectedCharacterFacts.map(item => <div key={`state:${item.label}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>{selectedMemorySections.map(section => <section key={section.label}><strong>{section.label}</strong><ul>{section.entries.map((entry, index) => <li key={`${section.label}:${String(index)}`}>{entry}</li>)}</ul></section>)}<div className={css.resourceBadges}><span data-ready={selectedCharacterResources.portrait !== undefined || undefined}>立绘</span><span data-ready={selectedCharacterResources.voice !== undefined || undefined}>语音</span><span data-ready={selectedCharacterResources.theme !== undefined || undefined}>角色曲</span><span data-ready={selectedCharacterResources.knowledge.length > 0 || undefined}>知识库 {selectedCharacterResources.knowledge.length}</span></div>{selectedCharacterResources.voice !== undefined && <audio controls src={selectedCharacterResources.voice}>当前浏览器无法播放角色语音。</audio>}{selectedCharacterResources.theme !== undefined && <audio controls src={selectedCharacterResources.theme}>当前浏览器无法播放角色主题曲。</audio>}</div>
          </div>}

          {panel === 'saves' && <div className={css.savesPanel}>
            <button type="button" disabled={busy !== undefined} onClick={() => { void beginNewRun() }}>从头开启新世界线</button>
            <button type="button" className={css.primaryAction} disabled={runId === undefined || actorId === undefined} onClick={() => {
              if (runId === undefined || actorId === undefined) return
              void mutate('save', async () => { await props.narrative.save({ runId, actorId, label: `${calendar.dateLabel} ${calendar.timeLabel}`, camera }) })
            }}>＋ 保存当前时刻</button>
            {play.saves.length === 0 ? <p>还没有存档。</p> : <ul>{play.saves.map((save) => {
              const plans = actorId === undefined
                ? []
                : save.checkpoint.snapshot.actionDecks[actorId]?.plans ?? []
              const retryPlanId = retryPlans[save.checkpoint.id] ?? ''
              return <li key={save.checkpoint.id}><div><strong>{save.label}</strong><small>{save.checkpoint.id.slice(-8)}</small>{plans.length > 0 && <label className={css.retryChoice}>重试时采取<select value={retryPlanId} onChange={(event) => { setRetryPlans(current => ({ ...current, [save.checkpoint.id]: event.target.value })) }}>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.label}</option>)}</select></label>}</div><div><button type="button" disabled={busy !== undefined} onClick={() => {
                if (actorId === undefined) return
                void mutate(`branch:${save.checkpoint.id}`, async () => { const branch = await props.narrative.branch({ runId: play.run.summary.runId, actorId, checkpointId: save.checkpoint.id, camera }); selectRun(branch.summary.runId); setPanel(undefined) })
              }}>另开世界线</button><button type="button" disabled={busy !== undefined || retryPlanId === ''} onClick={() => {
                if (actorId === undefined || retryPlanId === '') return
                void mutate(`retry:${save.checkpoint.id}`, async () => {
                  const result = await props.narrative.retry({ runId: play.run.summary.runId, actorId, checkpointId: save.checkpoint.id, planId: retryPlanId as ActionPlan['id'], camera })
                  const duration = plans.find(plan => plan.id === retryPlanId)?.estimatedDuration
                  if (duration !== undefined) await advanceStory(result.view.summary.runId, duration)
                  selectRun(result.view.summary.runId); setPanel(undefined)
                })
              }}>从这里重试</button></div></li>
            })}</ul>}
          </div>}

          {panel === 'settings' && <div className={css.settingsPanel}>
            <p>{stage?.message ?? '世界内核先结算事实，叙事者再把真实发生的事情演出来。'}</p>
            <section className={`${css.llmSetup} ${css.quickSetup}`} data-ready={modelReady || undefined}>
              <div><strong>{narratorConfigured ? '故事模型已配置' : '连接故事模型'}</strong><small>{narratorConfigured
                ? `当前 ${narratorRoute.provider} / ${narratorRoute.model}${modelReady ? '' : ' · 等待重新启用'}`
                : '选择一个模型即可启用推荐配置；世界线不会用本地模板冒充小说。'}</small></div>
              <label>故事模型<select value={selectedModel} onChange={(event) => {
                const value = event.target.value
                setSelectedModel(value)
                const next = models.find(model => `${model.provider}\u0000${model.id}` === value)
                setSelectedReasoning(next?.reasoningEfforts.includes('off') === true ? 'off' : '')
                setSelectedDirectorModel(value)
                setSelectedDirectorReasoning(next?.reasoningEfforts.includes('off') === true ? 'off' : '')
              }}><option value="">请选择模型</option>{models.map(model => <option key={`${model.provider}:${model.id}`} value={`${model.provider}\u0000${model.id}`}>{model.name} · {model.provider}</option>)}</select></label>
              <div className={css.recommendedFlow}><span>① 临时装配上下文</span><span>② 生成多模态正文</span><span>③ 并发更新世界</span><span>④ 实时生成选项</span></div>
              <button type="button" disabled={runView === undefined || selectedModel === '' || selectedDirectorModel === '' || busy !== undefined} onClick={() => {
                if (runView === undefined) return
                const [provider, model] = selectedModel.split('\u0000')
                const [directorProvider, directorModel] = selectedDirectorModel.split('\u0000')
                if (provider === undefined || model === undefined || directorProvider === undefined || directorModel === undefined) return
                void mutate('narrator-model', async () => {
                  await props.runs.switchModel({
                    runId: runView.summary.runId,
                    expectedSequence: runView.snapshot.sequence,
                    modelPolicy: {
                      ...runView.snapshot.modelPolicy,
                      aiEnabled: true,
                      routes: {
                        ...runView.snapshot.modelPolicy.routes,
                        narrator: {
                          provider,
                          model,
                          ...(selectedReasoning === '' ? {} : { reasoningEffort: selectedReasoning }),
                        },
                        creative: {
                          provider: directorProvider,
                          model: directorModel,
                          ...(selectedDirectorReasoning === '' ? {} : { reasoningEffort: selectedDirectorReasoning }),
                        },
                      },
                    },
                  })
                })
              }}>{narratorConfigured ? '应用并启用配置' : '一键启用推荐配置'}</button>
              {models.length === 0 && <small>当前没有发现具备上下文窗口信息的可用模型，请先在应用设置中配置 LLM Provider。</small>}
              <details className={css.advancedConfig}><summary>高级：分别指定正文与导演模型</summary><div>
                <label>正文推理强度<select value={selectedReasoning} onChange={(event) => { setSelectedReasoning(event.target.value) }}><option value="">使用 Provider 默认值</option>{selectedModelInfo?.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort === 'off' ? '关闭（小说叙事推荐）' : effort}</option>)}</select><small>关闭长推理可让正文及时开始流式显示。</small></label>
                <label>状态与选项导演<select value={selectedDirectorModel} onChange={(event) => {
                  const value = event.target.value
                  setSelectedDirectorModel(value)
                  const next = models.find(model => `${model.provider}\u0000${model.id}` === value)
                  setSelectedDirectorReasoning(next?.reasoningEfforts.includes('off') === true ? 'off' : '')
                }}><option value="">请选择模型</option>{models.map(model => <option key={`director:${model.provider}:${model.id}`} value={`${model.provider}\u0000${model.id}`}>{model.name} · {model.provider}</option>)}</select></label>
                <label>导演推理强度<select value={selectedDirectorReasoning} onChange={(event) => { setSelectedDirectorReasoning(event.target.value) }}><option value="">使用 Provider 默认值</option>{selectedDirectorModelInfo?.reasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select><small>导演只负责世界状态、角色记忆、剧情证据与阶段选项。</small></label>
              </div></details>
            </section>
            <section className={css.experienceSetup}><div><strong>体验设置</strong><small>切换世界线不会再被旧请求覆盖；编号按创建顺序固定。</small></div>
              <label>世界线<select value={runId ?? ''} onChange={(event) => { selectRun(event.target.value as RunSummary['runId']) }}>{orderedRuns.map((item, index) => <option key={item.runId} value={item.runId}>世界线 {String(index + 1)} · {worldlineLabel(item.status)} · {item.runId.slice(-6)}</option>)}</select></label>
              <div className={css.experienceGrid}><label>我的视角<select value={actorId ?? ''} onChange={(event) => { setManualViewpoint(true); selectActor(event.target.value as EntityId) }}>{ids.map((id, index) => <option key={id} value={id}>{names.get(id) ?? `角色 ${String(index + 1)}`}</option>)}</select><small>{manualViewpoint ? '已锁定手动视角' : '默认跟随当前剧本点的焦点角色'}</small></label>
                <label>叙事镜头<select value={camera} onChange={(event) => { setCamera(event.target.value) }}><option value="limited-third-person">限知第三人称</option><option value="first-person">第一人称</option><option value="objective">客观镜头</option></select></label></div>
              <label className={css.toggle}><input type="checkbox" checked={autoPlay} onChange={(event) => { setAutoPlay(event.target.checked) }} /><span>剧本点满足时自动继续</span></label>
            </section>
          </div>}
        </section>
      </div>}

      {activeBgm !== undefined && <audio autoPlay loop muted={muted} src={activeBgm} />}
      {activeVoice !== undefined && <audio autoPlay muted={muted} key={`${latestBeat?.id ?? 'stream'}:${activeVoice}`} src={activeVoice} />}
    </main>}
  </div>
}
