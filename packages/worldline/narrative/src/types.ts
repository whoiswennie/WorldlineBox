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

export interface TextPlayRequest {
  readonly runId: RunId
  readonly actorId: EntityId
  readonly camera?: string
}

export interface TextPlayView {
  readonly run: RunView
  readonly frame: SceneFrame
  readonly beats: readonly NarrativeBeat[]
  readonly choices: RunChoicesView
  readonly saves: readonly CheckpointView[]
}

export interface NarrateRequest extends TextPlayRequest {
  readonly eventIds?: readonly string[]
  readonly observationIds?: readonly string[]
  readonly templateOnly?: boolean
}

export type NarrativeStreamChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'replace'; readonly text: string }
  | { readonly type: 'beat'; readonly beat: NarrativeBeat }

export interface ChooseTextActionRequest extends TextPlayRequest {
  readonly choiceId: string
  readonly expectedSequence: number
}

export interface FreeTextActionRequest extends TextPlayRequest {
  readonly text: string
  readonly expectedSequence: number
}

export interface FreeTextActionResult {
  readonly status: 'submitted' | 'ambiguous' | 'unmatched'
  readonly candidates: readonly ChoiceProjection[]
  readonly action?: SubmitRunActionResult
}

export interface RephraseRequest extends TextPlayRequest {
  readonly beatId: NarrativeBeat['id']
}

export interface SaveTextPlayRequest extends TextPlayRequest { readonly label: string }
export interface BranchTextPlayRequest extends TextPlayRequest {
  readonly checkpointId: CheckpointId
  readonly seed?: string
}
export interface RetryTextActionRequest extends BranchTextPlayRequest {
  readonly choiceId: string
}

export interface StoryStageStatus {
  readonly available: boolean
  readonly renderers: readonly {
    readonly id: string
    readonly name: string
    readonly capabilities: readonly string[]
  }[]
  readonly message: string
}
