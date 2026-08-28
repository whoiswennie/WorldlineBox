/** Native Conversation nodes for independent companion messages and room roster events. */
import { useEffect } from 'react'
import type {
  ChatConversationViewNode, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CompanionReferenceEventData, CompanionRoomMembershipEventData,
  CompanionStreamSpeaker,
} from '../contracts.ts'
import { companionStore, useCompanionStore } from './store.ts'
import { ReferenceContent } from './reference-renderer.tsx'
import css from './CompanionChat.module.css'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One resource emitted directly by an independent companion Agent. */
    'companion-reference': CompanionReferenceEventData
    /** A durable join/leave notice authored by the room owner or an @ mention. */
    'companion-membership': CompanionRoomMembershipEventData
    /** One incrementally rendered utterance from an independent room actor. */
    'companion-stream': {
      readonly speaker: CompanionStreamSpeaker
      readonly text: string
      readonly status: 'running' | 'settled' | 'interrupted'
    }
  }
}

function singleEventDefinition<State>(
  kind: 'companion-reference' | 'companion-membership',
  eventType: 'companion/reference' | 'companion/room-membership',
): ConversationNodeDefinition<State> {
  return {
    kind,
    target: 'chat',
    match: event => event.type === eventType ? { id: String(event.seq), role: 'start' } : null,
    start: (_context, match) => {
      if (match.event.type !== eventType) throw new Error(`${kind} start requires ${eventType}`)
      return match.event.data as State
    },
    update: context => context.state,
    buildViewNode: (context): ChatConversationViewNode | null => context.start === undefined ? null : ({
      key: context.key,
      kind,
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: context.state,
    }),
  }
}

export const companionReferenceDefinition = singleEventDefinition<CompanionReferenceEventData>(
  'companion-reference', 'companion/reference',
)
export const companionMembershipDefinition = singleEventDefinition<CompanionRoomMembershipEventData>(
  'companion-membership', 'companion/room-membership',
)

interface CompanionStreamState {
  readonly speaker: CompanionStreamSpeaker
  readonly text: string
  readonly status: 'running' | 'settled' | 'interrupted'
}

export const companionStreamDefinition: ConversationNodeDefinition<CompanionStreamState> = {
  kind: 'companion-stream',
  target: 'chat',
  match: (event) => {
    if (event.type === 'companion/stream-start') {
      return { id: event.data.streamId, role: 'start' }
    }
    if (event.type === 'companion/stream-delta' || event.type === 'companion/stream-end') {
      return { id: event.data.streamId, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'companion/stream-start') {
      throw new Error('companion-stream start requires companion/stream-start')
    }
    return { speaker: match.event.data.speaker, text: '', status: 'running' }
  },
  update: (context, match) => {
    if (match.event.type === 'companion/stream-delta') {
      return { ...context.state, text: context.state.text + match.event.data.text }
    }
    if (match.event.type === 'companion/stream-end') {
      return {
        ...context.state,
        status: match.event.data.interrupted === true ? 'interrupted' : 'settled',
      }
    }
    return context.state
  },
  publication: match => match.event.type === 'companion/stream-delta'
    ? 'animation-frame'
    : 'immediate',
  buildViewNode: context => context.start === undefined ? null : ({
    key: context.key,
    kind: 'companion-stream',
    id: context.id,
    target: 'chat',
    anchorSeq: context.start.event.seq,
    location: context.start.location,
    visibility: 'visible',
    data: context.state,
  }),
}

export function CompanionReferenceNodeView({ node }: ChatNodeViewProps<'companion-reference'>) {
  const directory = useCompanionStore()
  useEffect(() => { void companionStore.load() }, [])
  const companion = directory.companions.find(item => item.id === node.data.companionId)
  return <div className={css.assistantList}>
    <div className={css.assistantRow}>
      <span className={css.assistantAvatar}>
        {companion === undefined
          ? <span className={css.unknownAvatar} aria-hidden="true">?</span>
          : <img src={companion.avatar} alt="" />}
      </span>
      <div className={css.assistantBody}>
        <span className={css.speaker}>{companion?.name ?? `未知伙伴 · ${node.data.companionId}`}</span>
        <div className={`${css.assistantBubble} ${css.toolMemeBubble}`}>
          <figure className={`${css.meme} ${css.toolMeme}`}>
            <ReferenceContent resource={{
              id: node.data.assetId,
              title: node.data.title,
              url: node.data.url,
              mimeType: node.data.mimeType,
            }} mode="conversation" />
            <figcaption>{node.data.title}</figcaption>
          </figure>
        </div>
      </div>
    </div>
  </div>
}

export function CompanionMembershipNodeView({ node }: ChatNodeViewProps<'companion-membership'>) {
  const directory = useCompanionStore()
  useEffect(() => { void companionStore.load() }, [])
  const name = directory.companions.find(item => item.id === node.data.companionId)?.name
    ?? node.data.companionId
  return <div className={css.roomNotice}>
    {name}{node.data.action === 'joined' ? '加入了房间' : '离开了房间'}
  </div>
}

export function CompanionStreamNodeView({ node }: ChatNodeViewProps<'companion-stream'>) {
  const directory = useCompanionStore()
  useEffect(() => { void companionStore.load() }, [])
  if (node.data.speaker.type === 'narrator') {
    return <NarratorCard text={node.data.text} streaming={node.data.status === 'running'} />
  }
  const speaker = node.data.speaker
  const companion = directory.companions.find(item => item.id === speaker.companionId)
  return <div className={css.assistantList}>
    <div className={css.assistantRow}>
      <span className={css.assistantAvatar}>
        {companion === undefined
          ? <span className={css.unknownAvatar} aria-hidden="true">?</span>
          : <img src={companion.avatar} alt="" />}
      </span>
      <div className={css.assistantBody}>
        <span className={css.speaker}>
          {companion?.name ?? `未知伙伴 · ${speaker.companionId}`}
        </span>
        <div className={css.assistantBubble}>
          <MarkdownText text={node.data.text} streaming={node.data.status === 'running'} />
        </div>
      </div>
    </div>
  </div>
}

export function NarratorCard({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <aside className={css.narratorCard} aria-label="旁白">
    <div className={css.narratorBody}>
      <span className={css.narratorName}>旁白</span>
      <MarkdownText text={text} streaming={streaming} />
    </div>
  </aside>
}
