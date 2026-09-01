import type {
  CanonObjectKind,
  DocumentId,
  ProjectId,
  ProjectManifest,
  ProjectTemplate,
  Revision,
  RunId,
} from '@deepseek-ai/dsh-worldline-standard/types'

/** Describes the project health value exchanged across the package boundary.
 */
export type ProjectHealth = 'ready' | 'damaged' | 'unavailable'
/** Describes the project build status value exchanged across the package boundary.
 */
export type ProjectBuildStatus = 'draft' | 'questions' | 'buildable' | 'frozen'
/** Describes the project sort value exchanged across the package boundary.
 */
export type ProjectSort = 'updated-desc' | 'created-desc' | 'name-asc'
/** Describes the worldline entry kind value exchanged across the package boundary.
 */
export type WorldlineEntryKind = 'directory' | 'document' | 'asset'

/** Describes the project root view value exchanged across the package boundary.
 */
export interface ProjectRootView {
  readonly configured: boolean
  readonly path?: string
  readonly writable: boolean
  readonly projectCount: number
  readonly scannedAt?: string
}

/** Describes the project summary value exchanged across the package boundary.
 */
export interface ProjectSummary {
  readonly manifest: ProjectManifest
  readonly path: string
  readonly health: ProjectHealth
  readonly status: ProjectBuildStatus
  readonly sizeBytes: number
  readonly documentCount: number
  readonly warning?: string
}

/** Describes the project library query value exchanged across the package boundary.
 */
export interface ProjectLibraryQuery {
  readonly search?: string
  readonly tags?: readonly string[]
  readonly template?: ProjectTemplate
  readonly sort?: ProjectSort
  readonly offset?: number
  readonly limit?: number
}

/** Describes the project library page value exchanged across the package boundary.
 */
export interface ProjectLibraryPage {
  readonly root: ProjectRootView
  readonly projects: readonly ProjectSummary[]
  readonly total: number
}

/** Describes the set project root request value exchanged across the package boundary.
 */
export interface SetProjectRootRequest {
  readonly path: string
  readonly create?: boolean
  readonly dryRun?: boolean
}

/** Describes the root relocation plan value exchanged across the package boundary.
 */
export interface RootRelocationPlan {
  readonly source?: string
  readonly destination: string
  readonly projects: readonly { readonly id: ProjectId; readonly name: string; readonly bytes: number }[]
  readonly conflicts: readonly string[]
  readonly requiredBytes: number
  readonly dryRun: boolean
}

/** Describes the create project request value exchanged across the package boundary.
 */
export interface CreateProjectRequest {
  readonly name: string
  readonly description?: string
  readonly template: ProjectTemplate
  readonly tags?: readonly string[]
  readonly author?: string
}

/** Describes the copy project request value exchanged across the package boundary.
 */
export interface CopyProjectRequest {
  readonly projectId: ProjectId
  readonly name: string
}

/** Describes the project ref value exchanged across the package boundary.
 */
export interface ProjectRef { readonly projectId: ProjectId }
/** Describes the trash project request value exchanged across the package boundary.
 */
export interface TrashProjectRequest extends ProjectRef { readonly reason?: string }
/** Describes the restore project request value exchanged across the package boundary.
 */
export interface RestoreProjectRequest { readonly trashId: string; readonly name?: string }

/** Describes the trashed project value exchanged across the package boundary.
 */
export interface TrashedProject {
  readonly trashId: string
  readonly originalName: string
  readonly deletedAt: string
  readonly sizeBytes: number
  readonly manifest?: ProjectManifest
}

/** Describes the project tree request value exchanged across the package boundary.
 */
export interface ProjectTreeRequest extends ProjectRef {
  readonly path?: string
  /** Last entry name from the preceding page; omitted for the first page. */
  readonly cursor?: string
  readonly limit?: number
}

/** Describes the project tree entry value exchanged across the package boundary.
 */
export interface ProjectTreeEntry {
  readonly id: DocumentId
  readonly name: string
  readonly path: string
  readonly kind: WorldlineEntryKind
  readonly sizeBytes: number
  readonly updatedAt: string
  readonly revision?: Revision
  readonly objectKind?: CanonObjectKind
  readonly tags: readonly string[]
  readonly trashed?: boolean
}

/** Describes the project tree listing value exchanged across the package boundary.
 */
export interface ProjectTreeListing {
  readonly projectId: ProjectId
  readonly path: string
  readonly entries: readonly ProjectTreeEntry[]
  readonly truncated: boolean
  readonly nextCursor?: string
}

/** Describes the read document request value exchanged across the package boundary.
 */
export interface ReadDocumentRequest extends ProjectRef { readonly path: string }

/** Describes the document view value exchanged across the package boundary.
 */
export interface DocumentView {
  readonly projectId: ProjectId
  readonly id: DocumentId
  readonly path: string
  readonly content: string
  readonly revision: Revision
  readonly updatedAt: string
  readonly objectKind?: CanonObjectKind
  readonly tags: readonly string[]
}

/** Describes the write document request value exchanged across the package boundary.
 */
export interface WriteDocumentRequest extends ProjectRef {
  readonly path: string
  readonly content: string
  readonly expectedRevision?: Revision
  readonly documentId?: DocumentId
  readonly objectKind?: CanonObjectKind
  readonly tags?: readonly string[]
  readonly createParents?: boolean
}

/** Host-only metadata for one streamed file import into the project tree. */
export interface ImportProjectEntryRequest extends ProjectRef {
  readonly path: string
  readonly expectedBytes: number
}

/** Describes the create directory request value exchanged across the package boundary.
 */
export interface CreateDirectoryRequest extends ProjectRef { readonly path: string }
/** Describes the move entry request value exchanged across the package boundary.
 */
export interface MoveEntryRequest extends ProjectRef {
  readonly source: string
  readonly destination: string
  readonly expectedRevision?: Revision
}
/** Describes the copy entry request value exchanged across the package boundary.
 */
export interface CopyEntryRequest extends ProjectRef { readonly source: string; readonly destination: string }
/** Describes the trash entry request value exchanged across the package boundary.
 */
export interface TrashEntryRequest extends ProjectRef { readonly path: string; readonly expectedRevision?: Revision }
/** Describes the restore entry request value exchanged across the package boundary.
 */
export interface RestoreEntryRequest extends ProjectRef { readonly trashId: string; readonly destination?: string }

/** Describes the mutation result value exchanged across the package boundary.
 */
export interface MutationResult {
  readonly projectId: ProjectId
  readonly path: string
  readonly revision?: Revision
  readonly id?: DocumentId
}

/** Describes the trashed entry value exchanged across the package boundary.
 */
export interface TrashedEntry {
  readonly trashId: string
  readonly originalPath: string
  readonly deletedAt: string
  readonly kind: WorldlineEntryKind
  readonly sizeBytes: number
}

/** Describes the history request value exchanged across the package boundary.
 */
export interface HistoryRequest extends ProjectRef { readonly path: string; readonly limit?: number }
/** Describes the document history entry value exchanged across the package boundary.
 */
export interface DocumentHistoryEntry {
  readonly revision: Revision
  readonly savedAt: string
  readonly sizeBytes: number
  readonly reason: 'autosave' | 'manual' | 'external' | 'restore'
}
/** Describes the restore revision request value exchanged across the package boundary.
 */
export interface RestoreRevisionRequest extends ProjectRef {
  readonly path: string
  readonly revision: Revision
  readonly expectedRevision: Revision
}

/** Describes the search project request value exchanged across the package boundary.
 */
export interface SearchProjectRequest extends ProjectRef {
  readonly query: string
  readonly path?: string
  readonly tags?: readonly string[]
  readonly kinds?: readonly CanonObjectKind[]
  readonly limit?: number
}
/** Describes the project search hit value exchanged across the package boundary.
 */
export interface ProjectSearchHit {
  readonly id: DocumentId
  readonly path: string
  readonly title: string
  readonly excerpt: string
  readonly score: number
  readonly objectKind?: CanonObjectKind
  readonly tags: readonly string[]
}
/** Describes the project link value exchanged across the package boundary.
 */
export interface ProjectLink {
  readonly sourceId: DocumentId
  readonly sourcePath: string
  readonly targetId?: DocumentId
  readonly target: string
  readonly kind: 'id' | 'path' | 'markdown'
  readonly broken: boolean
}

/** Describes the export project request value exchanged across the package boundary.
 */
export interface ExportProjectRequest extends ProjectRef { readonly destination: string; readonly includeRuns?: boolean }
/** Describes the project import conflict value exchanged across the package boundary.
 */
export type ProjectImportConflict = 'copy' | 'replace' | 'cancel'
/** Describes the import project request value exchanged across the package boundary.
 */
export interface ImportProjectRequest {
  readonly source: string
  readonly name?: string
  readonly conflict: ProjectImportConflict
}
/** Describes the export blueprint request value exchanged across the package boundary.
 */
export interface ExportBlueprintRequest extends ProjectRef {
  readonly destination: string
  readonly digest?: string
}
/** Describes the import blueprint request value exchanged across the package boundary.
 */
export interface ImportBlueprintRequest extends ProjectRef { readonly source: string }
/** Describes the export run request value exchanged across the package boundary.
 */
export interface ExportRunRequest extends ProjectRef {
  readonly runId: RunId
  readonly destination: string
}
/** Describes the import run request value exchanged across the package boundary.
 */
export interface ImportRunRequest extends ProjectRef { readonly source: string }
/** Describes the transfer job value exchanged across the package boundary.
 */
export interface TransferJob {
  readonly id: string
  readonly kind:
    | 'import'
    | 'export'
    | 'import-blueprint'
    | 'export-blueprint'
    | 'import-run'
    | 'export-run'
    | 'rescan'
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly completedBytes: number
  readonly totalBytes?: number
  readonly resultProjectId?: ProjectId
  readonly resultBlueprintDigest?: string
  readonly resultRunId?: RunId
  readonly error?: string
}

/** One immutable text input captured for a Host-side compiler build. */
export interface ProjectSourceFile {
  readonly id: DocumentId
  readonly path: string
  readonly content: string
  readonly revision: Revision
  readonly objectKind?: CanonObjectKind
  readonly tags: readonly string[]
}

/** Consistent compiler input; `digest` covers the ordered path/revision pairs. */
export interface ProjectSourceSnapshot {
  readonly projectId: ProjectId
  readonly manifest: ProjectManifest
  readonly capturedAt: string
  readonly digest: string
  readonly files: readonly ProjectSourceFile[]
}

/** Host-only compiler sidecar document, never exposed as a project source file. */
export interface ProjectControlDocument {
  readonly content: string
  readonly revision: Revision
}

/** Describes the write project control request value exchanged across the package boundary.
 */
export interface WriteProjectControlRequest extends ProjectRef {
  readonly namespace: string
  readonly path: string
  readonly content: string
  readonly expectedRevision?: Revision
}

/** Describes the store project build request value exchanged across the package boundary.
 */
export interface StoreProjectBuildRequest extends ProjectRef {
  readonly digest: string
  readonly blueprint: string
  readonly certificate: string
  readonly sourceSnapshot: string
}

/** Host-only locator for an immutable active build; never returned over Remote. */
export interface ActiveProjectBuild {
  readonly projectId: ProjectId
  readonly digest: string
  readonly blueprintPath: string
}

/** Host-only Run database locator used to start one single-writer Worker. */
export interface ProjectRunStorage {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly databasePath: string
}

/** Describes the worldline project error code value exchanged across the package boundary.
 */
export type WorldlineProjectErrorCode =
  | 'root-not-configured'
  | 'root-unreadable'
  | 'project-not-found'
  | 'project-invalid'
  | 'path-outside-project'
  | 'path-invalid'
  | 'entry-not-found'
  | 'entry-exists'
  | 'entry-too-large'
  | 'revision-conflict'
  | 'manifest-conflict'
  | 'transfer-failed'

/** Owns the worldline project error capability and its lifecycle.
 */
export class WorldlineProjectError extends Error {
  constructor(
    readonly code: WorldlineProjectErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message)
    this.name = 'WorldlineProjectError'
  }
}
