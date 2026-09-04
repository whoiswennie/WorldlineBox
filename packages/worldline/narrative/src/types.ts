import type {
  ActionId,
  ActionPlan,
  CheckpointId,
  ChoiceProjection,
  EntityId,
  MediaCue,
  NarrativeBeat,
  PlotPointDefinition,
  RunId,
  SceneFrame,
  StoryProgressEvidence,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type {
  CheckpointView,
  RunChoicesView,
  RunView,
  SubmitRunActionResult,
} from '@deepseek-ai/dsh-worldline-runtime/types'

/** Describes the text play request value exchanged across the package boundary.
 */
export interface TextPlayRequest {
  readonly runId: RunId
  readonly actorId: EntityId
  readonly camera?: string
}

/** Describes the text play view value exchanged across the package boundary.
 */
export interface TextPlayView {
  readonly run: RunView
  readonly frame: SceneFrame
  readonly beats: readonly NarrativeBeat[]
  readonly choices: RunChoicesView
  readonly saves: readonly CheckpointView[]
  readonly script: ScriptProgressView
}

/** Frozen script progress derived from retained state-director evidence. */
export interface ScriptProgressView {
  readonly completed: readonly PlotPointDefinition[]
  readonly current?: PlotPointDefinition
  readonly currentProgress?: StoryProgressEvidence
  /** Characters named by the current authored beat, in stable cast order. */
  readonly suggestedActorIds: readonly EntityId[]
  readonly remaining: number
}

/** Describes the narrate request value exchanged across the package boundary.
 */
export interface NarrateRequest extends TextPlayRequest {
  /** Exact submitted action whose settled event frontier must be narrated. */
  readonly actionId?: ActionId
  /** Player-authored dramatic intent. It may shape presentation but is never authoritative state. */
  readonly playerIntent?: string
  readonly eventIds?: readonly string[]
  readonly observationIds?: readonly string[]
}

/** Observable stages of one story turn. These stages are part of the stream contract so the
 * client can explain real work instead of guessing from an indeterminate spinner. */
export type NarrativeAgentPhase = 'context' | 'narrative' | 'world-state' | 'complete'

/** Describes the narrative stream chunk value exchanged across the package boundary.
 */
export type NarrativeStreamChunk =
  | { readonly type: 'phase'; readonly phase: NarrativeAgentPhase }
  | {
    readonly type: 'retry'
    readonly phase: Exclude<NarrativeAgentPhase, 'context' | 'complete'>
    readonly attempt: number
    readonly maxAttempts?: number
    readonly delayMs: number
    readonly failure: { readonly code: string; readonly message: string }
  }
  | { readonly type: 'media'; readonly cue: MediaCue }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'replace'; readonly text: string }
  | { readonly type: 'beat'; readonly beat: NarrativeBeat }
  | { readonly type: 'error'; readonly message: string }

/** Describes the choose text action request value exchanged across the package boundary.
 */
export interface ChooseTextActionRequest extends TextPlayRequest {
  readonly planId: ActionPlan['id']
  readonly expectedSequence: number
}

/** Describes the free text action request value exchanged across the package boundary.
 */
export interface FreeTextActionRequest extends TextPlayRequest {
  readonly text: string
  readonly expectedSequence: number
}

/** Describes the free text action result value exchanged across the package boundary.
 */
export interface FreeTextActionResult {
  readonly status: 'submitted' | 'ambiguous' | 'unmatched'
  readonly candidates: readonly ChoiceProjection[]
  readonly action?: SubmitRunActionResult
}

/** The persisted model-authored actions for one fully presented story beat. */
export interface StoryChoiceSuggestions {
  readonly sequence: number
  readonly afterBeatId: NarrativeBeat['id']
  readonly suggestions: readonly ActionPlan[]
}

/** Describes the rephrase request value exchanged across the package boundary.
 */
export interface RephraseRequest extends TextPlayRequest {
  readonly beatId: NarrativeBeat['id']
}

/** Describes the save text play request value exchanged across the package boundary.
 */
export interface SaveTextPlayRequest extends TextPlayRequest { readonly label: string }
/** Describes the branch text play request value exchanged across the package boundary.
 */
export interface BranchTextPlayRequest extends TextPlayRequest {
  readonly checkpointId: CheckpointId
  readonly seed?: string
}
/** Describes the retry text action request value exchanged across the package boundary.
 */
export interface RetryTextActionRequest extends BranchTextPlayRequest {
  readonly planId: ActionPlan['id']
}

/** Describes the story stage status value exchanged across the package boundary.
 */
export interface StoryStageStatus {
  readonly available: boolean
  readonly renderers: readonly {
    readonly id: string
    readonly name: string
    readonly capabilities: readonly string[]
  }[]
  readonly message: string
}
