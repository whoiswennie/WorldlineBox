/** Shared Host/Client contracts for the virtual companion directory. */

/** One durable virtual companion profile. */
export interface VirtualCompanion {
  readonly id: string
  readonly name: string
  readonly handle: string
  readonly avatar: string
  readonly portrait: string
  readonly status: string
  readonly description: string
  readonly persona: string
  readonly style: string
  readonly speakingStyle: string
  readonly behaviorLogic: string
  readonly builtIn: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** The companion participants attached to one conversation session. */
export interface VirtualCompanionRoom {
  readonly sessionId: string
  readonly participantIds: readonly string[]
  /** Stable continuable child Session owned by each participant in this room. */
  readonly actorSessionIds?: Readonly<Record<string, string>>
  /** Stable continuable child Session owned by the room's independent narrator. */
  readonly narratorSessionId?: string
  /** Increments whenever membership changes and is stamped onto later room events. */
  readonly epoch?: number
  readonly updatedAt: number
}

/** One lazily loaded node in a knowledge-vault file tree. */
export interface KnowledgeTreeEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'document'
  readonly children?: number
  readonly updatedAt?: number
  readonly size?: number
}

export type KnowledgeReadView = 'top' | 'section' | 'grep' | 'full'

/** Search metadata is deliberately small; document bodies are fetched separately. */
export interface KnowledgeSearchResult {
  readonly scope: string
  readonly path: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly revision: string
  readonly updatedAt: number
}

export interface KnowledgeDocument extends KnowledgeSearchResult {
  readonly content: string
  readonly headings: readonly string[]
  readonly links: readonly string[]
  readonly sources: readonly string[]
  readonly totalLines: number
  readonly view: KnowledgeReadView
}

/** One semantic conversational act chosen before a concrete reference asset. */
export type ReferenceAct = string
/** How a resolved reference relates to neighboring prose or media. */
export type ReferenceExpressionRole = 'replace-text' | 'amplify-text' | 'reply' | 'illustrate'

/** Semantic expression chosen by an actor before the Host resolves any concrete asset. */
export interface ReferenceIntent {
  readonly act: ReferenceAct
  readonly target?: string
  readonly intensity?: 1 | 2 | 3
  readonly role?: ReferenceExpressionRole
  readonly replyTo?: string
  /** Open resource tags selected from the current scope catalog or authored freely by the Agent. */
  readonly preferredTags?: readonly string[]
  readonly query?: string
}

/** Extensible, fast-retrieval media/reference record. */
export interface ReferenceAsset {
  readonly id: string
  readonly scope: string
  /** Disabled assets remain manageable but are invisible to Agent discovery and retrieval. */
  readonly enabled: boolean
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
  readonly transcript: string
  readonly mimeType: string
  readonly bytes: number
  readonly durationMs?: number
  readonly source: { readonly type: 'builtin'; readonly url: string }
    | { readonly type: 'blob'; readonly hash: string }
    | { readonly type: 'link'; readonly url: string }
  readonly builtIn: boolean
  readonly usageCount: number
  readonly lastUsedAt?: number
  readonly createdAt: number
  readonly updatedAt: number
  /** Resolved delivery URL; blob hashes never cross the UI boundary. */
  readonly url?: string
}

export interface ReferenceDraft {
  readonly scope: string
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
  readonly transcript?: string
  readonly mimeType: string
  readonly asset: string
  readonly durationMs?: number
}

export interface ReferencePage {
  readonly items: readonly ReferenceAsset[]
  readonly nextCursor: number
}

export interface ReferenceTagCount {
  readonly tag: string
  readonly count: number
}

/** One ordered, independently emitted visible part from a companion actor. */
export interface CompanionReferenceEventData {
  readonly version: 1
  readonly companionId: string
  readonly actorSessionId: string
  readonly roomEpoch: number
  readonly assetId: string
  readonly title: string
  readonly mimeType: string
  readonly url: string
}

/** Durable semantic act that selected the immediately following reference asset. */
export interface CompanionExpressionIntentEventData {
  readonly version: 1
  readonly companionId: string
  readonly actorSessionId: string
  readonly roomEpoch: number
  readonly act: ReferenceAct
  readonly role: ReferenceExpressionRole
  readonly intensity: 1 | 2 | 3
  readonly target?: string
  readonly replyTo?: string
  readonly assetId: string
}

export interface CompanionRoomMembershipEventData {
  readonly version: 1
  readonly action: 'joined' | 'left'
  readonly companionId: string
  readonly roomEpoch: number
  readonly actor: 'owner' | 'mention'
}

export type CompanionStreamSpeaker =
  | { readonly type: 'companion'; readonly companionId: string; readonly actorSessionId: string }
  | { readonly type: 'narrator'; readonly actorSessionId: string }

/** Opens one independently generated, incrementally rendered room utterance. */
export interface CompanionStreamStartEventData {
  readonly version: 1
  readonly streamId: string
  readonly speaker: CompanionStreamSpeaker
  readonly roomEpoch: number
}

/** One bounded text delta from a companion or narrator Agent. */
export interface CompanionStreamDeltaEventData {
  readonly version: 1
  readonly streamId: string
  readonly text: string
}

/** Closes one streamed room utterance without replacing its durable deltas. */
export interface CompanionStreamEndEventData {
  readonly version: 1
  readonly streamId: string
  readonly interrupted?: true
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One companion's semantic expression decision, resolved to a real indexed asset. */
    'companion/expression-intent': CompanionExpressionIntentEventData
    /** One indexed reference asset emitted by an independently running companion actor. */
    'companion/reference': CompanionReferenceEventData
    /** Durable room roster change visible to the coordinator and every later actor. */
    'companion/room-membership': CompanionRoomMembershipEventData
    /** Start, append, and settle one native streamed actor utterance. */
    'companion/stream-start': CompanionStreamStartEventData
    /** Append one ordered text fragment to the identified companion or narrator stream. */
    'companion/stream-delta': CompanionStreamDeltaEventData
    /** Settle the identified room stream and record whether generation was interrupted. */
    'companion/stream-end': CompanionStreamEndEventData
  }
}

/** Complete account-scoped directory snapshot returned by the Host. */
export interface VirtualCompanionSnapshot {
  readonly companions: readonly VirtualCompanion[]
  readonly rooms: Readonly<Record<string, VirtualCompanionRoom>>
}

/** Editable profile fields accepted by create/update. */
export interface VirtualCompanionDraft {
  readonly name: string
  readonly handle: string
  readonly avatar: string
  readonly portrait: string
  readonly status: string
  readonly description: string
  readonly persona: string
  readonly style: string
  readonly speakingStyle: string
  readonly behaviorLogic: string
}

/** Pick one stable pseudo-random initial companion so Host and Client cannot race to different rooms. */
export function initialCompanionId(
  sessionId: string,
  companions: readonly Pick<VirtualCompanion, 'id'>[],
): string | undefined {
  if (companions.length === 0) return undefined
  let hash = 2_166_136_261
  for (const character of sessionId) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return companions[(hash >>> 0) % companions.length]?.id
}
