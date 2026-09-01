import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ActiveProjectBuild,
  CopyEntryRequest,
  CopyProjectRequest,
  CreateDirectoryRequest,
  CreateProjectRequest,
  DocumentHistoryEntry,
  DocumentView,
  ExportProjectRequest,
  HistoryRequest,
  ImportProjectRequest,
  ImportProjectEntryRequest,
  MoveEntryRequest,
  MutationResult,
  ProjectLibraryPage,
  ProjectLibraryQuery,
  ProjectLink,
  ProjectRootView,
  ProjectRunStorage,
  ProjectSourceSnapshot,
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
  StoreProjectBuildRequest,
  TransferJob,
  TrashEntryRequest,
  TrashedEntry,
  TrashedProject,
  TrashProjectRequest,
  WriteDocumentRequest,
  WriteProjectControlRequest,
  ProjectControlDocument,
} from './types.ts'
import type { ProjectId, RunId } from '@deepseek-ai/dsh-worldline-standard/types'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { worldlineProjects: WorldlineProjects }
}

/** Host-owned project storage contract; clients see only its generated Remote face. */
export abstract class WorldlineProjects extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'worldlineProjects') }

  abstract root(): Promise<ProjectRootView>
  abstract setRoot(request: SetProjectRootRequest): Promise<RootRelocationPlan>
  abstract library(query?: ProjectLibraryQuery): Promise<ProjectLibraryPage>
  abstract rescan(): Promise<TransferJob>
  abstract create(request: CreateProjectRequest): Promise<ProjectSummary>
  abstract copyProject(request: CopyProjectRequest): Promise<ProjectSummary>
  abstract trashProject(request: TrashProjectRequest): Promise<TrashedProject>
  abstract listTrashedProjects(): Promise<readonly TrashedProject[]>
  abstract restoreProject(request: RestoreProjectRequest): Promise<ProjectSummary>
  abstract tree(request: ProjectTreeRequest): Promise<ProjectTreeListing>
  abstract read(request: ReadDocumentRequest): Promise<DocumentView>
  abstract write(request: WriteDocumentRequest): Promise<DocumentView>
  /** Stream one browser-owned file without placing its bytes in Remote JSON or Host memory. */
  abstract importEntry(
    request: ImportProjectEntryRequest,
    source: AsyncIterable<Uint8Array>,
  ): Promise<MutationResult>
  abstract createDirectory(request: CreateDirectoryRequest): Promise<MutationResult>
  abstract move(request: MoveEntryRequest): Promise<MutationResult>
  abstract copyEntry(request: CopyEntryRequest): Promise<MutationResult>
  abstract trashEntry(request: TrashEntryRequest): Promise<TrashedEntry>
  abstract listTrashedEntries(projectId: TrashEntryRequest['projectId']): Promise<readonly TrashedEntry[]>
  abstract restoreEntry(request: RestoreEntryRequest): Promise<MutationResult>
  abstract history(request: HistoryRequest): Promise<readonly DocumentHistoryEntry[]>
  abstract restoreRevision(request: RestoreRevisionRequest): Promise<DocumentView>
  abstract search(request: SearchProjectRequest): Promise<readonly ProjectSearchHit[]>
  abstract backlinks(request: ReadDocumentRequest): Promise<readonly ProjectLink[]>
  abstract exportProject(request: ExportProjectRequest): Promise<TransferJob>
  abstract importProject(request: ImportProjectRequest): Promise<TransferJob>
  abstract transfer(id: string): Promise<TransferJob>
  abstract cancelTransfer(id: string): Promise<TransferJob>

  /** Capture all text sources at one point for a Host-side compiler. Not exported over Remote. */
  abstract sourceSnapshot(projectId: ProjectTreeRequest['projectId']): Promise<ProjectSourceSnapshot>
  /** Read a namespaced Host-only compiler/runtime sidecar. Not exported over Remote. */
  abstract readControl(
    projectId: ProjectTreeRequest['projectId'],
    namespace: string,
    path: string,
  ): Promise<ProjectControlDocument | undefined>
  /** Durably write a namespaced Host-only sidecar with optimistic concurrency. */
  abstract writeControl(request: WriteProjectControlRequest): Promise<ProjectControlDocument>
  /** Commit an immutable build directory and activate it only after every artifact is durable. */
  abstract storeBuild(request: StoreProjectBuildRequest): Promise<void>
  /** Locate the immutable active Blueprint for a Worker without reading it on the Host event loop. */
  abstract activeBuild(projectId: ProjectId): Promise<ActiveProjectBuild | undefined>
  /** Allocate or locate one project-scoped Run database path. */
  abstract runStorage(projectId: ProjectId, runId: RunId): Promise<ProjectRunStorage>
  /** Discover persisted Run databases across the configured library. */
  abstract runStorages(): Promise<readonly ProjectRunStorage[]>

  @Remote('root') remoteRoot(): Promise<ProjectRootView> { return this.root() }
  @Remote('setRoot') remoteSetRoot(value: SetProjectRootRequest): Promise<RootRelocationPlan> { return this.setRoot(value) }
  @Remote('library') remoteLibrary(value?: ProjectLibraryQuery): Promise<ProjectLibraryPage> { return this.library(value) }
  @Remote('rescan') remoteRescan(): Promise<TransferJob> { return this.rescan() }
  @Remote('create') remoteCreate(value: CreateProjectRequest): Promise<ProjectSummary> { return this.create(value) }
  @Remote('copyProject') remoteCopyProject(value: CopyProjectRequest): Promise<ProjectSummary> { return this.copyProject(value) }
  @Remote('trashProject') remoteTrashProject(value: TrashProjectRequest): Promise<TrashedProject> { return this.trashProject(value) }
  @Remote('listTrashedProjects') remoteListTrashedProjects(): Promise<readonly TrashedProject[]> { return this.listTrashedProjects() }
  @Remote('restoreProject') remoteRestoreProject(value: RestoreProjectRequest): Promise<ProjectSummary> { return this.restoreProject(value) }
  @Remote('tree') remoteTree(value: ProjectTreeRequest): Promise<ProjectTreeListing> { return this.tree(value) }
  @Remote('read') remoteRead(value: ReadDocumentRequest): Promise<DocumentView> { return this.read(value) }
  @Remote('write') remoteWrite(value: WriteDocumentRequest): Promise<DocumentView> { return this.write(value) }
  @Remote('createDirectory') remoteCreateDirectory(value: CreateDirectoryRequest): Promise<MutationResult> { return this.createDirectory(value) }
  @Remote('move') remoteMove(value: MoveEntryRequest): Promise<MutationResult> { return this.move(value) }
  @Remote('copyEntry') remoteCopyEntry(value: CopyEntryRequest): Promise<MutationResult> { return this.copyEntry(value) }
  @Remote('trashEntry') remoteTrashEntry(value: TrashEntryRequest): Promise<TrashedEntry> { return this.trashEntry(value) }
  @Remote('listTrashedEntries') remoteListTrashedEntries(value: TrashEntryRequest['projectId']): Promise<readonly TrashedEntry[]> { return this.listTrashedEntries(value) }
  @Remote('restoreEntry') remoteRestoreEntry(value: RestoreEntryRequest): Promise<MutationResult> { return this.restoreEntry(value) }
  @Remote('history') remoteHistory(value: HistoryRequest): Promise<readonly DocumentHistoryEntry[]> { return this.history(value) }
  @Remote('restoreRevision') remoteRestoreRevision(value: RestoreRevisionRequest): Promise<DocumentView> { return this.restoreRevision(value) }
  @Remote('search') remoteSearch(value: SearchProjectRequest): Promise<readonly ProjectSearchHit[]> { return this.search(value) }
  @Remote('backlinks') remoteBacklinks(value: ReadDocumentRequest): Promise<readonly ProjectLink[]> { return this.backlinks(value) }
  @Remote('exportProject') remoteExportProject(value: ExportProjectRequest): Promise<TransferJob> { return this.exportProject(value) }
  @Remote('importProject') remoteImportProject(value: ImportProjectRequest): Promise<TransferJob> { return this.importProject(value) }
  @Remote('transfer') remoteTransfer(value: string): Promise<TransferJob> { return this.transfer(value) }
  @Remote('cancelTransfer') remoteCancelTransfer(value: string): Promise<TransferJob> { return this.cancelTransfer(value) }
}

export default WorldlineProjects
