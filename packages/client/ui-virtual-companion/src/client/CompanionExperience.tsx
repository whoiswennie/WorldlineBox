/** Immersive companion-chat controls and warm activity feedback. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VirtualCompanion } from '../contracts.ts'
import type {
  createCompanionExperienceStore, DirectoryState,
} from './store.ts'
import css from './CompanionExperience.module.css'

const PRESET_ID = 'virtual-companion'

type ExperienceStore = ReturnType<typeof createCompanionExperienceStore>
type ToggleProps = PropsRuntime<'conversation.input.left'>
  & PropsStore<ExperienceStore>
  & PropsLocale<'virtualCompanion'>
type StatusProps = PropsRuntime<'conversation.input.dock'>
  & PropsStore<ExperienceStore>
  & PropsLocale<'virtualCompanion'>
  & InjectFace<CompanionWaitingStatusInjected>

export interface CompanionWaitingStatusInjected {
  loadDirectory(): void
  hooks: { companionDirectory: HostObservable<DirectoryState> }
}

interface LiveSpeaker {
  readonly type: 'companion' | 'narrator'
  readonly companionId?: string
  readonly streaming: boolean
}

function currentRoomReply(session: StatusProps['session']): LiveSpeaker | undefined {
  for (let index = session.chat.order.length - 1; index >= 0; index -= 1) {
    const key = session.chat.order[index]
    if (key === undefined) continue
    const node = session.chat.nodes.get(key)
    if (node?.kind === 'user' || node?.kind === 'steering') return undefined
    if (node?.kind !== 'companion-stream' || node.data === null || typeof node.data !== 'object') continue
    const data = node.data as Record<string, unknown>
    const speaker = data['speaker']
    if (speaker === null || typeof speaker !== 'object') continue
    const speakerData = speaker as Record<string, unknown>
    const streaming = data['status'] === 'running'
    return speakerData['type'] === 'narrator'
      ? { type: 'narrator', streaming }
      : speakerData['type'] === 'companion' && typeof speakerData['companionId'] === 'string'
        ? { type: 'companion', companionId: speakerData['companionId'], streaming }
        : undefined
  }
  return undefined
}

function roomCompanions(
  directory: DirectoryState,
  sessionId: string,
): readonly VirtualCompanion[] {
  const ids = directory.rooms[sessionId]?.participantIds ?? []
  return ids.flatMap((id) => {
    const companion = directory.companions.find(item => item.id === id)
    return companion === undefined ? [] : [companion]
  })
}

/** Companion-only switch inside the composer. The default keeps control-plane rows out of sight. */
export function CompanionProcessToggle({
  sessionId, useSessions, useStore, actions, t,
}: ToggleProps) {
  const enabled = useSessions(state => state.byId[sessionId]?.agentPreset === PRESET_ID)
  const showProcess = useStore(state => state.showProcess)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  // Keyed chat rows expose stable kind markers. The attribute folds only this
  // session's control plane without teaching the conversation runtime about companions.
  useLayoutEffect(() => {
    const scope = buttonRef.current?.closest<HTMLElement>('[data-conversation-scroll]')
    if (!enabled || scope === undefined || scope === null) return
    const value = showProcess ? 'visible' : 'hidden'
    scope.dataset.companionProcess = value
    return () => {
      if (scope.dataset.companionProcess === value) delete scope.dataset.companionProcess
    }
  }, [enabled, showProcess])

  if (!enabled) return null
  const hint = t(showProcess ? 'processHideHint' : 'processShowHint')
  return (
    <button
      ref={buttonRef}
      type="button"
      className={css.processToggle}
      role="switch"
      aria-checked={showProcess}
      aria-label={t('processLabel')}
      title={hint}
      data-active={showProcess}
      onClick={() => { actions.setShowProcess(!showProcess) }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M2 8c1.5-2.3 3.5-3.5 6-3.5s4.5 1.2 6 3.5c-1.5 2.3-3.5 3.5-6 3.5S3.5 10.3 2 8Z" />
        <circle cx="8" cy="8" r="1.8" />
      </svg>
      <span>{t('processLabel')}</span>
      <span className={css.switchTrack} aria-hidden="true"><span /></span>
    </button>
  )
}

/** Replace an opaque technical wait with a changing, relationship-first room presence. */
export function CompanionWaitingStatus({
  session, sessionId, useSessions, useStore, useCompanionDirectory, loadDirectory, t,
}: StatusProps) {
  const enabled = useSessions(state => state.byId[sessionId]?.agentPreset === PRESET_ID)
  const showProcess = useStore(state => state.showProcess)
  const directory = useCompanionDirectory(state => state)
  const [waitStage, setWaitStage] = useState(0)
  const roomReply = currentRoomReply(session)
  const liveSpeaker = roomReply?.streaming === true ? roomReply : undefined
  const companions = roomCompanions(directory, sessionId)

  useEffect(() => {
    if (!enabled || !session.running || showProcess || roomReply !== undefined) {
      setWaitStage(0)
      return
    }
    const timer = setInterval(() => { setWaitStage(stage => Math.min(stage + 1, 2)) }, 7_000)
    return () => { clearInterval(timer) }
  }, [enabled, session.running, showProcess, roomReply])

  useEffect(() => {
    if (enabled && directory.phase === 'idle') loadDirectory()
  }, [directory.phase, enabled, loadDirectory])

  if (!enabled || !session.running || showProcess || roomReply?.streaming === false) return null

  const liveCompanion = liveSpeaker?.type === 'companion'
    ? directory.companions.find(item => item.id === liveSpeaker.companionId)
    : undefined
  const representative = liveCompanion ?? companions[0]
  const name = liveCompanion?.name
    ?? (companions.length > 1 ? t('waitingGroupName') : representative?.name ?? t('waitingCompanionName'))
  const message = liveSpeaker?.type === 'narrator'
    ? t('waitingNarrating')
    : liveSpeaker?.type === 'companion'
      ? t('waitingSpeaking', { name })
      : waitStage === 0
        ? t('waitingRead', { name })
        : waitStage === 1
          ? t('waitingThink', { name })
          : t('waitingLong', { name })

  return (
    <div className={css.waiting} role="status" aria-live="polite">
      <span className={css.waitingAvatar} aria-hidden="true">
        {representative?.avatar ? <img src={representative.avatar} alt="" /> : <span>✦</span>}
      </span>
      <span className={css.waitingText}>{message}</span>
      <span className={css.waitingDots} aria-hidden="true"><i /><i /><i /></span>
    </div>
  )
}
