import type {
  CheckpointId,
  ChoiceProjection,
  EntityId,
  NarrativeBeat,
  RunId,
  SceneFrame,
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
}

/** Describes the narrate request value exchanged across the package boundary.
 */
export interface NarrateRequest extends TextPlayRequest {
  readonly eventIds?: readonly string[]
  readonly observationIds?: readonly string[]
  readonly templateOnly?: boolean
}

/** Describes the narrative stream chunk value exchanged across the package boundary.
 */
export type NarrativeStreamChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'replace'; readonly text: string }
  | { readonly type: 'beat'; readonly beat: NarrativeBeat }

/** Describes the choose text action request value exchanged across the package boundary.
 */
export interface ChooseTextActionRequest extends TextPlayRequest {
  readonly choiceId: string
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
  readonly choiceId: string
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
