import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-auth/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { companionStore, useCompanionStore } from './store.ts'
import type { createCompanionExperienceStore } from './store.ts'
import type { ReferenceAsset } from '../contracts.ts'
import { getReference } from './reference-client.ts'
import { ReferenceContent } from './reference-renderer.tsx'
import css from './CompanionChat.module.css'

const PRESET_ID = 'virtual-companion'
const USER_REFERENCE_PATTERN = /<user-reference\s+asset-id="([a-z\d-]{1,160})">([^<]*)<\/user-reference>/giu

type AssistantProps = PropsRuntime<'conversation.chat.assistant-content'>
  & PropsStore<ReturnType<typeof createCompanionExperienceStore>>
type UserProps = PropsRuntime<'conversation.chat.user-content'>
type HeaderProps = PropsRuntime<'conversation.session.header.actions'>

interface ReferenceToolMeta {
  found: boolean
  assetId: string
  title: string
  url: string
  mimeType: string
}

const EMPTY_IDENTITY_SNAPSHOT = { loading: true, user: null, savedAccounts: [], error: '' }
const EMPTY_IDENTITY: ClientContext['accountIdentity'] = {
  getSnapshot: () => EMPTY_IDENTITY_SNAPSHOT,
  subscribe: () => () => {},
}
let identityService: ClientContext['accountIdentity'] = EMPTY_IDENTITY

/** Bind the plugin's account identity service for chat presentation. */
export function bindCompanionAccountIdentity(service: ClientContext['accountIdentity']): () => void {
  identityService = service
  return () => { if (identityService === service) identityService = EMPTY_IDENTITY }
}

const referenceCache = new Map<string, ReferenceAsset>()

function ReferenceMedia({ id, fallbackTitle }: { id: string; fallbackTitle: string }) {
  const [asset, setAsset] = useState<ReferenceAsset | undefined>(() => referenceCache.get(id))
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (asset !== undefined) return
    let active = true
    void getReference(id).then((value) => {
      referenceCache.set(id, value)
      if (active) setAsset(value)
    }, () => { if (active) setMissing(true) })
    return () => { active = false }
  }, [asset, id])
  if (asset === undefined) return <div className={`${css.assistantBubble} ${css.toolMemeBubble}`}>
    <figure
      className={`${css.meme} ${css.toolMeme}`}
      data-reference-state={missing ? 'missing' : 'loading'}
      title={fallbackTitle}
    >
      <span className={css.missingMeme}>
        {missing ? `${fallbackTitle}（引用已移除）` : '正在载入引用…'}
      </span>
    </figure>
  </div>
  return <div className={`${css.assistantBubble} ${css.toolMemeBubble}`}>
    <figure
      className={`${css.meme} ${css.toolMeme}`}
      data-reference-media-type={asset.mimeType}
      title={asset.title}
    >
      <ReferenceContent resource={{
        id: asset.id,
        title: asset.title,
        url: asset.url,
        mimeType: asset.mimeType,
        text: asset.transcript,
        description: asset.description,
        tags: asset.tags,
      }} mode="conversation" />
      <figcaption>{asset.title}</figcaption>
    </figure>
  </div>
}

interface UserReferenceSegment {
  readonly kind: 'reference'
  readonly id: string
  readonly title: string
  readonly offset: number
}

interface UserTextSegment {
  readonly kind: 'text'
  readonly text: string
  readonly offset: number
}

type UserMessageSegment = UserReferenceSegment | UserTextSegment
type UserMessageGroup = UserTextSegment | {
  readonly kind: 'references'
  readonly references: readonly UserReferenceSegment[]
}

function userMessageGroups(text: string): readonly UserMessageGroup[] {
  const segments: UserMessageSegment[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  USER_REFERENCE_PATTERN.lastIndex = 0
  while ((match = USER_REFERENCE_PATTERN.exec(text)) !== null) {
    const prose = text.slice(cursor, match.index).trim()
    if (prose !== '') segments.push({ kind: 'text', text: prose, offset: cursor })
    if (match[1] !== undefined) segments.push({
      kind: 'reference', id: match[1], title: (match[2] ?? '').trim() || '引用', offset: match.index,
    })
    cursor = USER_REFERENCE_PATTERN.lastIndex
  }
  const tail = text.slice(cursor).trim()
  if (tail !== '') segments.push({ kind: 'text', text: tail, offset: cursor })

  const groups: UserMessageGroup[] = []
  for (const segment of segments) {
    const previous = groups.at(-1)
    if (segment.kind === 'reference' && previous?.kind === 'references') {
      groups[groups.length - 1] = { ...previous, references: [...previous.references, segment] }
    } else if (segment.kind === 'reference') {
      groups.push({ kind: 'references', references: [segment] })
    } else {
      groups.push(segment)
    }
  }
  return groups
}

export function RichUserText({ text }: { text: string }) {
  const groups = userMessageGroups(text)
  const mediaOnly = groups.length > 0 && groups.every(group => group.kind === 'references')
  return <div
    className={css.richUserMessage}
    data-companion-rich-message=""
    data-media-only={mediaOnly}
  >
    {groups.map(group => group.kind === 'text'
      ? <div className={css.richUserProse} data-message-part="text" key={`text-${String(group.offset)}`}>
        <MarkdownText text={group.text} streaming={false} />
      </div>
      : <div
        className={css.referenceGrid}
        data-message-part="references"
        data-reference-count={Math.min(group.references.length, 4)}
        key={`references-${String(group.references[0]?.offset ?? 0)}`}
      >
        {group.references.map(reference => <ReferenceMedia
          id={reference.id}
          fallbackTitle={reference.title}
          key={`user-reference-${reference.id}-${String(reference.offset)}`}
        />)}
      </div>)}
  </div>
}

function userProtocolText(node: UserProps['node']): string {
  return node.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function referenceToolMeta(block: ToolCallViewProps['block']): ReferenceToolMeta | undefined {
  if (!('kind' in block) || block.isError) return undefined
  if (block.meta !== null && typeof block.meta === 'object' && !Array.isArray(block.meta)) {
    const meta = block.meta as Record<string, unknown>
    if (meta['found'] === true && typeof meta['asset_id'] === 'string'
      && typeof meta['title'] === 'string'
      && typeof meta['url'] === 'string' && typeof meta['mime_type'] === 'string') {
      return {
        found: true,
        assetId: meta['asset_id'],
        title: meta['title'],
        url: meta['url'],
        mimeType: meta['mime_type'],
      }
    }
  }
  const text = block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
  const match = /<agent-reference\s+asset-id="([a-z\d-]{1,160})"\s*\/>/iu.exec(text)
  if (match?.[1] === undefined) return undefined
  return { found: true, assetId: match[1], title: '引用资料', url: '', mimeType: '' }
}

/** Render a successful generic reference result as the durable chat message. */
export function ReferenceToolView({ block }: ToolCallViewProps) {
  if (!('kind' in block)) return <span className={css.memeToolStatus}>正在检索引用…</span>
  const meta = referenceToolMeta(block)
  if (meta?.found !== true) {
    return block.isError ? <span className={css.memeToolError}>引用发送失败</span> : null
  }
  if (meta.url === '') return <span className={css.memeToolError}>引用素材不可用</span>
  return <div className={css.genericMemeReply}><figure className={`${css.meme} ${css.toolMeme}`}>
    <ReferenceContent resource={{
      id: meta.assetId,
      title: meta.title,
      url: meta.url,
      mimeType: meta.mimeType,
    }} mode="conversation" />
    <figcaption>{meta.title}</figcaption>
  </figure></div>
}

/** The coordinator is control-plane only; every visible reply comes from a room actor event. */
export function CompanionAssistantContent({
  fallback, sessionId, useSessions, useStore,
}: AssistantProps) {
  const enabled = useSessions(state => state.byId[sessionId]?.agentPreset === PRESET_ID)
  const showProcess = useStore(state => state.showProcess)
  return enabled && !showProcess ? null : fallback
}

/** Add the live account name and avatar around the standard user bubble. */
export function CompanionUserContent({ fallback, node, sessionId, useSessions }: UserProps) {
  const enabled = useSessions(state => state.byId[sessionId]?.agentPreset === PRESET_ID)
  const rawText = userProtocolText(node)
  const hasUserReference = /<user-reference\s+asset-id=/iu.test(rawText)
  const auth = useSyncExternalStore(
    listener => identityService.subscribe(listener),
    () => identityService.getSnapshot(),
    () => identityService.getSnapshot(),
  )
  useEffect(() => { if (enabled) void companionStore.load() }, [enabled])
  if (!enabled && !hasUserReference) return fallback
  const user = auth.user
  const label = user?.displayName || user?.username || '我'
  return <div className={css.userIdentity}>
    <div className={css.userContent}>
      <span className={css.userName}>{label} · 房主</span>
      <div className={css.userFallback}>
        {hasUserReference ? <RichUserText text={rawText} /> : fallback}
      </div>
    </div>
    <span className={css.userAvatar}>
      {user?.avatar ? <img src={user.avatar} alt="" /> : <span aria-hidden="true">{label.slice(0, 1)}</span>}
    </span>
  </div>
}

/** Display and manage live room participants beside the conversation title. */
export function CompanionRoomHeader({ sessionId, useSession, useSessions }: HeaderProps) {
  const enabled = useSessions(state => state.byId[sessionId]?.agentPreset === PRESET_ID)
  const subagentAddress = useSessions(state => (
    state.current === sessionId && state.currentAddress?.childSessionId === sessionId
      ? state.currentAddress
      : undefined
  ))
  const membershipVersion = useSession(snapshot => snapshot.chat.order.flatMap((key) => {
    const node = snapshot.chat.nodes.get(key)
    return node?.kind === 'companion-membership' ? [key] : []
  }).join('|'))
  const directory = useCompanionStore()
  const manageRef = useRef<HTMLDetailsElement | null>(null)
  const auth = useSyncExternalStore(
    listener => identityService.subscribe(listener),
    () => identityService.getSnapshot(),
    () => identityService.getSnapshot(),
  )
  useEffect(() => { if (enabled) void companionStore.load() }, [enabled])
  useEffect(() => {
    if (enabled && membershipVersion !== '') void companionStore.load(true)
  }, [enabled, membershipVersion])
  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      const details = manageRef.current
      if (details?.open === true && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [])
  if (!enabled) return null
  const roomSessionId = subagentAddress?.parentSessionId ?? sessionId
  const room = directory.rooms[roomSessionId]
  const roomIds = room?.participantIds ?? []
  const actorCompanionId = subagentAddress === undefined
    ? undefined
    : Object.entries(room?.actorSessionIds ?? {})
      .find(([, actorSessionId]) => actorSessionId === sessionId)?.[0]
  // A companion actor child is a view of its parent room, not a new room.
  // Present the exact actor bound to this child so an independently-created
  // child-room default can never replace the identity shown in the header.
  const visibleRoomIds = actorCompanionId === undefined ? roomIds : [actorCompanionId]
  const joined = visibleRoomIds.flatMap((id) => {
    const companion = directory.companions.find(item => item.id === id)
    return companion === undefined ? [] : [companion]
  })
  const ownerName = auth.user?.displayName || auth.user?.username || '我'
  const toggle = (id: string): void => {
    void (roomIds.includes(id)
      ? companionStore.removeParticipant(roomSessionId, id)
      : companionStore.addParticipant(roomSessionId, id))
  }
  return <div className={css.participantStrip}>
    <span>{joined.length + 1} 人</span>
    <span className={css.participantFaces} aria-hidden="true">
      <span className={css.participantAvatar} title={`${ownerName} · 房主`}>
        {auth.user?.avatar
          ? <img src={auth.user.avatar} alt="" />
          : <span className={css.participantInitial} aria-hidden="true">{ownerName.slice(0, 1)}</span>}
      </span>
      {joined.slice(0, 5).map(companion => <span className={css.participantAvatar} key={companion.id}>
        <img src={companion.avatar} alt="" />
      </span>)}
    </span>
    <span className={css.participantNames} title={[ownerName, ...joined.map(item => item.name)].join('、')}>
      {[ownerName, ...joined.map(item => item.name)].slice(0, 3).join('、')}
      {joined.length > 2 ? '…' : ''}
    </span>
    <details className={css.manage} ref={manageRef}>
      <summary>管理成员</summary>
      <div className={css.managePanel}>
        <div className={css.ownerRow}>
          {auth.user?.avatar ? <img className={css.smallAvatar} src={auth.user.avatar} alt="" /> : null}
          <strong>{ownerName}</strong><span className={css.ownerBadge}>房主</span>
        </div>
        {directory.companions.map(companion => <button
          key={companion.id}
          type="button"
          className={css.memberRow}
          data-joined={roomIds.includes(companion.id)}
          onClick={() => { toggle(companion.id) }}
        >
          <img className={css.smallAvatar} src={companion.avatar} alt="" />
          <span>{companion.name}</span>
          <i>{roomIds.includes(companion.id) ? '移出' : '加入'}</i>
        </button>)}
      </div>
    </details>
  </div>
}
