import type {
  CopyEntryRequest,
  CopyProjectRequest,
  CreateDirectoryRequest,
  CreateProjectRequest,
  DocumentHistoryEntry,
  DocumentView,
  ExportProjectRequest,
  HistoryRequest,
  ImportProjectRequest,
  MoveEntryRequest,
  MutationResult,
  ProjectLibraryPage,
  ProjectLibraryQuery,
  ProjectLink,
  ProjectRootView,
  ProjectSearchHit,
  ProjectSummary,
  ProjectTreeListing,
  ProjectTreeRequest,
  ReadDocumentRequest,
  RestoreEntryRequest,
  RestoreProjectRequest,
  RestoreRevisionRequest,
  RootRelocationPlan,
  SearchProjectRequest,
  SetProjectRootRequest,
  TransferJob,
  TrashedEntry,
  TrashedProject,
  TrashEntryRequest,
  TrashProjectRequest,
  WriteDocumentRequest,
} from '@deepseek-ai/dsh-worldline-project/types'
import type {
  AnswerQuestionRequest,
  BuildPreview,
  CompilerState,
  CompileWorldRequest,
  ExplainSemanticsRequest,
  FreezeWorldRequest,
  FrozenBuild,
  ReviewProposalRequest,
  SemanticsExplanation,
  SubmitProposalRequest,
} from '@deepseek-ai/dsh-worldline-compiler/types'
import type {
  AdvanceRunRequest,
  BranchRunRequest,
  CheckpointView,
  CreateCheckpointRequest,
  CreateRunRequest,
  ExplainRunEventRequest,
  RunChoicesRequest,
  RunChoicesView,
  RunEventExplanation,
  RunRecordsPage,
  RunRecordsRequest,
  RunRef,
  RunSpatialRequest,
  RunSpatialView,
  RunSummary,
  RunView,
  SetActorControlRequest,
  SetAiEnabledRequest,
  SubmitRunActionRequest,
  SubmitRunActionResult,
  SwitchModelPolicyRequest,
} from '@deepseek-ai/dsh-worldline-runtime/types'
import type {
  AiBudgetRequest,
  AiBudgetStatus,
  AiDecisionResult,
  ContextPackRequest,
  DecideForActorRequest,
  WorldlineAiCatalog,
} from '@deepseek-ai/dsh-worldline-ai/types'
import type {
  BranchTextPlayRequest,
  ChooseTextActionRequest,
  FreeTextActionRequest,
  FreeTextActionResult,
  NarrateRequest,
  NarrativeStreamChunk,
  RephraseRequest,
  RetryTextActionRequest,
  SaveTextPlayRequest,
  StoryStageStatus,
  TextPlayRequest,
  TextPlayView,
} from '@deepseek-ai/dsh-worldline-narrative/types'
import type { ContextPack, NarrativeBeat, ProjectId, RunId, SceneFrame } from '@deepseek-ai/dsh-worldline-standard/types'

export type DocumentSaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

export interface EditorDocumentState {
  readonly document: DocumentView
  readonly content: string
  readonly saveState: DocumentSaveState
  readonly error?: string
  readonly diskVersion?: DocumentView
}

export interface ProjectClient {
  root(): Promise<ProjectRootView>
  setRoot(request: SetProjectRootRequest): Promise<RootRelocationPlan>
  library(query?: ProjectLibraryQuery): Promise<ProjectLibraryPage>
  rescan(): Promise<TransferJob>
  create(request: CreateProjectRequest): Promise<ProjectSummary>
  copyProject(request: CopyProjectRequest): Promise<ProjectSummary>
  trashProject(request: TrashProjectRequest): Promise<TrashedProject>
  listTrashedProjects(): Promise<readonly TrashedProject[]>
  restoreProject(request: RestoreProjectRequest): Promise<ProjectSummary>
  tree(request: ProjectTreeRequest): Promise<ProjectTreeListing>
  read(request: ReadDocumentRequest): Promise<DocumentView>
  write(request: WriteDocumentRequest): Promise<DocumentView>
  createDirectory(request: CreateDirectoryRequest): Promise<MutationResult>
  move(request: MoveEntryRequest): Promise<MutationResult>
  copyEntry(request: CopyEntryRequest): Promise<MutationResult>
  trashEntry(request: TrashEntryRequest): Promise<TrashedEntry>
  listTrashedEntries(projectId: ProjectId): Promise<readonly TrashedEntry[]>
  restoreEntry(request: RestoreEntryRequest): Promise<MutationResult>
  history(request: HistoryRequest): Promise<readonly DocumentHistoryEntry[]>
  restoreRevision(request: RestoreRevisionRequest): Promise<DocumentView>
  search(request: SearchProjectRequest): Promise<readonly ProjectSearchHit[]>
  backlinks(request: ReadDocumentRequest): Promise<readonly ProjectLink[]>
  exportProject(request: ExportProjectRequest): Promise<TransferJob>
  importProject(request: ImportProjectRequest): Promise<TransferJob>
  transfer(id: string): Promise<TransferJob>
  cancelTransfer(id: string): Promise<TransferJob>
}

export interface CompilerClient {
  state(projectId: ProjectId): Promise<CompilerState>
  compile(request: CompileWorldRequest): Promise<BuildPreview>
  answerQuestion(request: AnswerQuestionRequest): Promise<CompilerState>
  submitProposal(request: SubmitProposalRequest): Promise<CompilerState>
  reviewProposal(request: ReviewProposalRequest): Promise<CompilerState>
  freeze(request: FreezeWorldRequest): Promise<FrozenBuild>
  explain(request: ExplainSemanticsRequest): Promise<SemanticsExplanation>
}

export interface RunsClient {
  create(request: CreateRunRequest): Promise<RunView>
  list(): Promise<readonly RunSummary[]>
  view(request: RunRef): Promise<RunView>
  spatial(request: RunSpatialRequest): Promise<RunSpatialView>
  choices(request: RunChoicesRequest): Promise<RunChoicesView>
  advance(request: AdvanceRunRequest): Promise<RunView>
  submitAction(request: SubmitRunActionRequest): Promise<SubmitRunActionResult>
  pause(request: RunRef): Promise<RunView>
  resume(request: RunRef): Promise<RunView>
  stop(request: RunRef): Promise<RunSummary>
  records(request: RunRecordsRequest): Promise<RunRecordsPage>
  checkpoint(request: CreateCheckpointRequest): Promise<CheckpointView>
  checkpoints(request: RunRef): Promise<readonly CheckpointView[]>
  branch(request: BranchRunRequest): Promise<RunView>
  setControl(request: SetActorControlRequest): Promise<RunView>
  setAiEnabled(request: SetAiEnabledRequest): Promise<RunView>
  switchModel(request: SwitchModelPolicyRequest): Promise<RunView>
  explain(request: ExplainRunEventRequest): Promise<RunEventExplanation>
}

export interface AiClient {
  catalog(): Promise<WorldlineAiCatalog>
  contextPack(request: ContextPackRequest): Promise<ContextPack>
  budget(request: AiBudgetRequest): Promise<AiBudgetStatus>
  decide(request: DecideForActorRequest): Promise<AiDecisionResult>
}

export interface NarrativeClient {
  open(request: TextPlayRequest): Promise<TextPlayView>
  scene(request: TextPlayRequest): Promise<SceneFrame>
  narrate(request: NarrateRequest): Promise<NarrativeBeat>
  narrateStream(request: NarrateRequest, onChunk: (chunk: NarrativeStreamChunk) => void): Promise<NarrativeBeat>
  choose(request: ChooseTextActionRequest): Promise<SubmitRunActionResult>
  freeInput(request: FreeTextActionRequest): Promise<FreeTextActionResult>
  rephrase(request: RephraseRequest): Promise<NarrativeBeat>
  save(request: SaveTextPlayRequest): Promise<CheckpointView>
  branch(request: BranchTextPlayRequest): Promise<RunView>
  retry(request: RetryTextActionRequest): Promise<SubmitRunActionResult>
  storyStage(): Promise<StoryStageStatus>
}

export interface WorldlineStudioInjected {
  readonly projects: ProjectClient
  readonly compiler: CompilerClient
  readonly runs: RunsClient
  readonly ai: AiClient
  readonly narrative: NarrativeClient
  pickDirectory(): Promise<string | null>
  openPath(path: string): Promise<void>
  launchConversation(project: ProjectSummary, runId?: RunId): Promise<void>
}
