import type {
  AiIntent,
  AiInvocation,
  ContextPack,
  EntityId,
  ModelRoute,
  RunId,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type { SubmitRunActionResult } from '@deepseek-ai/dsh-worldline-runtime/types'

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
  readonly purpose?: 'character' | 'narrator' | 'summary'
  readonly maxOutputTokens?: number
  readonly reservedToolTokens?: number
}

/** Describes the ai budget status value exchanged across the package boundary.
 */
export interface AiBudgetStatus {
  readonly runId: RunId
  readonly allowed: boolean
  readonly reasons: readonly string[]
  readonly route?: ModelRoute
  readonly activeCalls: number
  readonly callsRemaining: number
  readonly inputTokensRemaining: number
  readonly outputTokensRemaining: number
  readonly logicalDayCallsRemaining: number
  readonly realHourCallsRemaining: number
  readonly estimatedNextCost: number
  readonly estimatedCostRemaining: number
  readonly pricing: 'route' | 'conservative-fallback'
}

/** Describes the ai budget request value exchanged across the package boundary.
 */
export interface AiBudgetRequest extends ContextPackRequest {
  readonly contextPack?: ContextPack
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
    | 'budget-blocked'
    | 'model-failed'
    | 'invalid-output'
    | 'conflict'
  readonly message: string
  readonly contextPack?: ContextPack
  readonly budget?: AiBudgetStatus
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
}

/** Describes the worldline text chunk value exchanged across the package boundary.
 */
export type WorldlineTextChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'finish'; readonly invocation: AiInvocation; readonly budgetExceeded: boolean }
  | { readonly type: 'blocked'; readonly budget: AiBudgetStatus }

/** Describes the worldline ai error code value exchanged across the package boundary.
 */
export type WorldlineAiErrorCode =
  | 'model-route-missing'
  | 'context-capacity-unknown'
  | 'actor-not-found'
  | 'context-impossible'

/** Owns the worldline ai error capability and its lifecycle.
 */
export class WorldlineAiError extends Error {
  constructor(readonly code: WorldlineAiErrorCode, message: string) {
    super(message)
    this.name = 'WorldlineAiError'
  }
}
