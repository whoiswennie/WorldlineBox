import { Context, Service } from '@deepseek-ai/cordis'

/** One child row returned by a Workspace directory listing. */
export interface WorkspaceTreeEntry {
  name: string
  path: string
  hidden: boolean
  kind: 'directory' | 'file'
  size?: number
  modifiedAt?: number
}

/** Bounded contents of one Workspace-relative directory. */
export interface WorkspaceTreeListing {
  path: string
  entries: WorkspaceTreeEntry[]
  truncated: boolean
}

/** One ranked file match returned by a Workspace-wide search. */
export interface WorkspaceTreeSearchResult {
  name: string
  path: string
  relativePath: string
  size: number
  modifiedAt: number
}

/** Bounded Workspace-wide filename search result. */
export interface WorkspaceTreeSearchListing {
  query: string
  results: WorkspaceTreeSearchResult[]
  scanned: number
  truncated: boolean
}

/** Bounded metadata and optional content for one Workspace file preview. */
export interface WorkspaceTreePreview {
  path: string
  name: string
  size: number
  modifiedAt: number
  kind: 'text' | 'image' | 'audio' | 'video' | 'binary'
  mimeType: string
  encoding?: 'utf8' | 'base64'
  content?: string
  tooLarge: boolean
}

/** Validated filesystem mutation below a registered Workspace root. */
export type WorkspaceTreeMutation =
  | { operation: 'create-file'; parent: string; name: string; content?: string }
  | { operation: 'create-directory'; parent: string; name: string }
  | { operation: 'rename'; path: string; name: string }
  | { operation: 'copy'; path: string; targetDirectory: string }
  | { operation: 'move'; path: string; targetDirectory: string }
  | { operation: 'delete'; path: string }
  | { operation: 'clear-workspace'; path: string }
  | { operation: 'write'; path: string; content: string }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A lazily watched registered Workspace changed on disk.
     * @param workspaceRoot - canonical root of the changed Workspace.
     * @mode emit
     */
    'workspace-tree/changed'(workspaceRoot: string): void
  }
  interface Context {
    workspaceTree: WorkspaceTree
  }
}

/** Replaceable host capability for a registered Workspace explorer. */
export abstract class WorkspaceTree extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspaceTree')
  }

  /**
   * List one directory below a registered Workspace root.
   * @param workspaceRoot - canonical Workspace root.
   * @param path - path relative to the Workspace root.
   * @param signal - optional cancellation for the read.
   * @returns the bounded directory listing.
   */
  abstract list(workspaceRoot: string, path: string, signal?: AbortSignal): Promise<WorkspaceTreeListing>
  /**
   * Search file names and relative paths below one registered Workspace.
   * @param workspaceRoot - canonical Workspace root.
   * @param query - non-blank case-insensitive query.
   * @param signal - optional cancellation for the traversal.
   * @returns ranked bounded file matches and traversal truncation facts.
   */
  abstract search(workspaceRoot: string, query: string, signal?: AbortSignal): Promise<WorkspaceTreeSearchListing>
  /**
   * Read a bounded preview for one Workspace file.
   * @param workspaceRoot - canonical Workspace root.
   * @param path - path relative to the Workspace root.
   * @param signal - optional cancellation for the read.
   * @returns preview metadata and optional encoded content.
   */
  abstract preview(workspaceRoot: string, path: string, signal?: AbortSignal): Promise<WorkspaceTreePreview>
  /**
   * Apply one validated mutation below a registered Workspace root.
   * @param workspaceRoot - canonical Workspace root.
   * @param mutation - requested create, rename, move, delete, or write operation.
   * @returns the affected relative path when the operation has one.
   */
  abstract mutate(workspaceRoot: string, mutation: WorkspaceTreeMutation): Promise<{ path?: string }>
}

export default WorkspaceTree
