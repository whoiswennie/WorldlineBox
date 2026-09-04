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
  ExportBlueprintRequest,
  ExportProjectRequest,
  ExportRunRequest,
  HistoryRequest,
  ImportBlueprintRequest,
  ImportProjectRequest,
  ImportProjectEntryRequest,
  ImportRunRequest,
  MoveEntryRequest,
  MutationResult,
  ProjectLibraryPage,
  ProjectLibraryQuery,
  ProjectAssetFile,
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

  interface Events {
    /**
     * Awaited checkpoint before a project becomes inaccessible. Runtime owners
     * must release project-scoped activity and file handles before resolving.
     * @param projectId - Project that is leaving the active library.
     * @mode parallel
     */
    'worldline-project/release'(projectId: ProjectId): Promise<void> | void
  }
}

/** Host-owned project storage contract; clients see only its generated Remote face. */
export abstract class WorldlineProjects extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'worldlineProjects') }

  /** Return the active project-library root and its storage status.
   * @returns The result produced by the operation.
   */
  abstract root(): Promise<ProjectRootView>
  /** Relocate the project library root through the Host-owned storage boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract setRoot(request: SetProjectRootRequest): Promise<RootRelocationPlan>
  /** Query the paginated project library.
   * @param query - The query supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract library(query?: ProjectLibraryQuery): Promise<ProjectLibraryPage>
  /** Rescan the active project root and refresh the library index.
   * @returns The result produced by the operation.
   */
  abstract rescan(): Promise<TransferJob>
  /** Create a project in the active project library.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract create(request: CreateProjectRequest): Promise<ProjectSummary>
  /** Copy a project while preserving the source project.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract copyProject(request: CopyProjectRequest): Promise<ProjectSummary>
  /** Move a project into the recoverable project recycle bin.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract trashProject(request: TrashProjectRequest): Promise<TrashedProject>
  /** List projects currently available for recovery.
   * @returns The result produced by the operation.
   */
  abstract listTrashedProjects(): Promise<readonly TrashedProject[]>
  /** Permanently remove every project currently held in the project recycle bin.
   * @returns The number of project entries removed.
   */
  abstract emptyProjectTrash(): Promise<number>
  /** Restore a project from the project recycle bin.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract restoreProject(request: RestoreProjectRequest): Promise<ProjectSummary>
  /** List one project directory from the authoritative Host store.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract tree(request: ProjectTreeRequest): Promise<ProjectTreeListing>
  /** Read a project document from the authoritative Host store.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract read(request: ReadDocumentRequest): Promise<DocumentView>
  /** Persist a project document through the Host-owned storage boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract write(request: WriteDocumentRequest): Promise<DocumentView>
  /** Stream one browser-owned file without placing its bytes in Remote JSON or Host memory.
   * @param request - The request supplied by the caller.
   * @param source - The source supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract importEntry(
    request: ImportProjectEntryRequest,
    source: AsyncIterable<Uint8Array>,
  ): Promise<MutationResult>
  /** Resolve one project-owned binary resource for a Host streaming endpoint. Not Remote.
   * @param request - Project and asset path to resolve.
   * @returns The validated Host file descriptor for streaming.
   */
  abstract assetFile(request: ReadDocumentRequest): Promise<ProjectAssetFile>
  /** Create a directory inside a project.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract createDirectory(request: CreateDirectoryRequest): Promise<MutationResult>
  /** Move or rename an entry inside a project.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract move(request: MoveEntryRequest): Promise<MutationResult>
  /** Copy an entry while preserving the source entry.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract copyEntry(request: CopyEntryRequest): Promise<MutationResult>
  /** Move a project entry into the recoverable entry recycle bin.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract trashEntry(request: TrashEntryRequest): Promise<TrashedEntry>
  /** List recoverable entries for a project.
   * @param projectId - The project id supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract listTrashedEntries(projectId: TrashEntryRequest['projectId']): Promise<readonly TrashedEntry[]>
  /** Restore an entry from the project recycle bin.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract restoreEntry(request: RestoreEntryRequest): Promise<MutationResult>
  /** Read the revision history of a project document.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract history(request: HistoryRequest): Promise<readonly DocumentHistoryEntry[]>
  /** Restore a historical document revision as the current content.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract restoreRevision(request: RestoreRevisionRequest): Promise<DocumentView>
  /** Search indexed content inside one project.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract search(request: SearchProjectRequest): Promise<readonly ProjectSearchHit[]>
  /** Find documents that link to the requested document.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract backlinks(request: ReadDocumentRequest): Promise<readonly ProjectLink[]>
  /** Export a project to a user-selected archive path.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract exportProject(request: ExportProjectRequest): Promise<TransferJob>
  /** Import a project archive selected by the user.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract importProject(request: ImportProjectRequest): Promise<TransferJob>
  /** Export a compiled blueprint to a user-selected archive path.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract exportBlueprint(request: ExportBlueprintRequest): Promise<TransferJob>
  /** Import a compiled blueprint archive selected by the user.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract importBlueprint(request: ImportBlueprintRequest): Promise<TransferJob>
  /** Export a Run archive to a user-selected path.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract exportRun(request: ExportRunRequest): Promise<TransferJob>
  /** Import a Run archive selected by the user.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract importRun(request: ImportRunRequest): Promise<TransferJob>
  /** Read the current state of an import or export transfer.
   * @param id - The id supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract transfer(id: string): Promise<TransferJob>
  /** Apply cancel transfer through the package's validated ownership boundary.
   * @param id - The id supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract cancelTransfer(id: string): Promise<TransferJob>

  /** Capture all text sources at one point for a Host-side compiler. Not exported over Remote.
   * @param projectId - The project id supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract sourceSnapshot(projectId: ProjectTreeRequest['projectId']): Promise<ProjectSourceSnapshot>
  /** Read a namespaced Host-only compiler/runtime sidecar. Not exported over Remote.
   * @param projectId - The project id supplied by the caller.
   * @param namespace - The namespace supplied by the caller.
   * @param path - The path supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract readControl(
    projectId: ProjectTreeRequest['projectId'],
    namespace: string,
    path: string,
  ): Promise<ProjectControlDocument | undefined>
  /** Durably write a namespaced Host-only sidecar with optimistic concurrency.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract writeControl(request: WriteProjectControlRequest): Promise<ProjectControlDocument>
  /** Commit an immutable build directory and activate it only after every artifact is durable.
   * @param request - The request supplied by the caller.
   */
  abstract storeBuild(request: StoreProjectBuildRequest): Promise<void>
  /** Locate the immutable active Blueprint for a Worker without reading it on the Host event loop.
   * @param projectId - The project id supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract activeBuild(projectId: ProjectId): Promise<ActiveProjectBuild | undefined>
  /** Allocate or locate one project-scoped Run database path.
   * @param projectId - The project id supplied by the caller.
   * @param runId - The run id supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract runStorage(projectId: ProjectId, runId: RunId): Promise<ProjectRunStorage>
  /** Discover persisted Run databases across the configured library.
   * @returns The result produced by the operation.
   */
  abstract runStorages(): Promise<readonly ProjectRunStorage[]>

  /** Perform remote root through the package's public contract.
   * @returns The result produced by the operation.
   */
  @Remote('root') remoteRoot(): Promise<ProjectRootView> { return this.root() }
  /** Perform remote set root through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('setRoot') remoteSetRoot(value: SetProjectRootRequest): Promise<RootRelocationPlan> { return this.setRoot(value) }
  /** Perform remote library through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('library') remoteLibrary(value?: ProjectLibraryQuery): Promise<ProjectLibraryPage> { return this.library(value) }
  /** Perform remote rescan through the package's public contract.
   * @returns The result produced by the operation.
   */
  @Remote('rescan') remoteRescan(): Promise<TransferJob> { return this.rescan() }
  /** Perform remote create through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('create') remoteCreate(value: CreateProjectRequest): Promise<ProjectSummary> { return this.create(value) }
  /** Perform remote copy project through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('copyProject') remoteCopyProject(value: CopyProjectRequest): Promise<ProjectSummary> { return this.copyProject(value) }
  /** Perform remote trash project through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('trashProject') remoteTrashProject(value: TrashProjectRequest): Promise<TrashedProject> { return this.trashProject(value) }
  /** Perform remote list trashed projects through the package's public contract.
   * @returns The result produced by the operation.
   */
  @Remote('listTrashedProjects') remoteListTrashedProjects(): Promise<readonly TrashedProject[]> { return this.listTrashedProjects() }
  /** Permanently remove every project currently held in the project recycle bin.
   * @returns The number of project entries removed.
   */
  @Remote('emptyProjectTrash') remoteEmptyProjectTrash(): Promise<number> { return this.emptyProjectTrash() }
  /** Perform remote restore project through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('restoreProject') remoteRestoreProject(value: RestoreProjectRequest): Promise<ProjectSummary> { return this.restoreProject(value) }
  /** Perform remote tree through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('tree') remoteTree(value: ProjectTreeRequest): Promise<ProjectTreeListing> { return this.tree(value) }
  /** Perform remote read through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('read') remoteRead(value: ReadDocumentRequest): Promise<DocumentView> { return this.read(value) }
  /** Perform remote write through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('write') remoteWrite(value: WriteDocumentRequest): Promise<DocumentView> { return this.write(value) }
  /** Perform remote create directory through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('createDirectory') remoteCreateDirectory(value: CreateDirectoryRequest): Promise<MutationResult> { return this.createDirectory(value) }
  /** Perform remote move through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('move') remoteMove(value: MoveEntryRequest): Promise<MutationResult> { return this.move(value) }
  /** Perform remote copy entry through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('copyEntry') remoteCopyEntry(value: CopyEntryRequest): Promise<MutationResult> { return this.copyEntry(value) }
  /** Perform remote trash entry through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('trashEntry') remoteTrashEntry(value: TrashEntryRequest): Promise<TrashedEntry> { return this.trashEntry(value) }
  /** Perform remote list trashed entries through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('listTrashedEntries') remoteListTrashedEntries(value: TrashEntryRequest['projectId']): Promise<readonly TrashedEntry[]> { return this.listTrashedEntries(value) }
  /** Perform remote restore entry through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('restoreEntry') remoteRestoreEntry(value: RestoreEntryRequest): Promise<MutationResult> { return this.restoreEntry(value) }
  /** Perform remote history through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('history') remoteHistory(value: HistoryRequest): Promise<readonly DocumentHistoryEntry[]> { return this.history(value) }
  /** Perform remote restore revision through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('restoreRevision') remoteRestoreRevision(value: RestoreRevisionRequest): Promise<DocumentView> { return this.restoreRevision(value) }
  /** Perform remote search through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('search') remoteSearch(value: SearchProjectRequest): Promise<readonly ProjectSearchHit[]> { return this.search(value) }
  /** Perform remote backlinks through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('backlinks') remoteBacklinks(value: ReadDocumentRequest): Promise<readonly ProjectLink[]> { return this.backlinks(value) }
  /** Perform remote export project through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('exportProject') remoteExportProject(value: ExportProjectRequest): Promise<TransferJob> { return this.exportProject(value) }
  /** Perform remote import project through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('importProject') remoteImportProject(value: ImportProjectRequest): Promise<TransferJob> { return this.importProject(value) }
  /** Perform remote export blueprint through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('exportBlueprint') remoteExportBlueprint(value: ExportBlueprintRequest): Promise<TransferJob> { return this.exportBlueprint(value) }
  /** Perform remote import blueprint through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('importBlueprint') remoteImportBlueprint(value: ImportBlueprintRequest): Promise<TransferJob> { return this.importBlueprint(value) }
  /** Perform remote export run through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('exportRun') remoteExportRun(value: ExportRunRequest): Promise<TransferJob> { return this.exportRun(value) }
  /** Perform remote import run through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('importRun') remoteImportRun(value: ImportRunRequest): Promise<TransferJob> { return this.importRun(value) }
  /** Perform remote transfer through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('transfer') remoteTransfer(value: string): Promise<TransferJob> { return this.transfer(value) }
  /** Perform remote cancel transfer through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('cancelTransfer') remoteCancelTransfer(value: string): Promise<TransferJob> { return this.cancelTransfer(value) }
}

export default WorldlineProjects
