import type { AiIntent, AiInvocation, ContextPack, EntityId, RunId } from '@deepseek-ai/dsh-worldline-standard/types'
import type { SubmitRunActionResult } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** Describes the worldline ai model value exchanged across the package boundary.
 */
export interface WorldlineAiModel {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly reasoningEfforts: readonly string[]
}

/** Describes the worldline ai catalog value exchanged across the package boundary.
 */
export interface WorldlineAiCatalog {
  readonly models: readonly WorldlineAiModel[]
}

/** Describes the context pack request value exchanged across the package boundary.
 */
export interface ContextPackRequest {
  readonly runId: RunId
  readonly actorId: EntityId
  readonly purpose?: 'character' | 'creative' | 'narrator' | 'summary'
  readonly maxOutputTokens?: number
  readonly reservedToolTokens?: number
}

/** Describes the decide for actor request value exchanged across the package boundary.
 */
export interface DecideForActorRequest {
  readonly runId: RunId
  readonly actorId: EntityId
}

/** Describes the ai decision result value exchanged across the package boundary.
 */
export interface AiDecisionResult {
  readonly status:
    | 'submitted'
    | 'deterministic-only'
    | 'no-legal-choice'
    | 'model-failed'
    | 'invalid-output'
    | 'conflict'
  readonly message: string
  readonly contextPack?: ContextPack
  readonly invocation?: AiInvocation
  readonly intent?: AiIntent
  readonly action?: SubmitRunActionResult
}

/** Describes the stream worldline text request value exchanged across the package boundary.
 */
export interface StreamWorldlineTextRequest {
  readonly runId: RunId
  readonly actorId: EntityId
  readonly purpose: 'narrator' | 'summary' | 'creative'
  readonly contextPack: ContextPack
  readonly temperature?: number
  /** Presentation-only tools. Callers validate every returned argument before retaining it. */
  readonly tools?: readonly ToolSchema[]
  /** Optional authority-layer character ceiling for text that will be retained downstream. */
  readonly maxCharacters?: number
}

/** Describes the worldline text chunk value exchanged across the package boundary.
 */
export type WorldlineTextChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly name: string; readonly arguments: string }
  | {
    /** A failed provider attempt was recorded and a new attempt will start after the delay. */
    readonly type: 'retry'
    readonly attempt: number
    readonly maxAttempts?: number
    readonly delayMs: number
    readonly failure: { readonly code: string; readonly message: string }
  }
  | {
    readonly type: 'finish'
    readonly invocation: AiInvocation
    /** Exact bounded model output whose digest was retained with the invocation. */
    readonly output: string
  }

/** Describes the worldline ai error code value exchanged across the package boundary.
 */
export type WorldlineAiErrorCode =
  | 'model-route-missing'
  | 'context-capacity-unknown'
  | 'actor-not-found'
  | 'context-impossible'
  | 'model-retry-exhausted'

/** Owns the worldline ai error capability and its lifecycle.
 */
export class WorldlineAiError extends Error {
  constructor(readonly code: WorldlineAiErrorCode, message: string) {
    super(message)
    this.name = 'WorldlineAiError'
  }
}
