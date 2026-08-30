/** Portable file-native Agent Vault service (`ctx.agentVaults`). @module @deepseek-ai/dsh-agent-vault */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AgentVaultErrorCode,
  AgentVaultChange,
  AgentVaultManifest,
  AgentVaultTrashEntry,
  CaptureMemoryInput,
  ConsolidationJob,
  MemoryStage,
  RecallQuery,
  RecallResult,
  ResourcePage,
  ResourceSearchInput,
  SelfModule,
  SelfSnapshot,
  VaultDocument,
  VaultEntry,
  VaultPackageReport,
  VaultPolicy,
  VaultResource,
  VaultResourceContent,
  VaultResourceDraft,
  VaultUri,
  VaultWriteContext,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agentVaults: AgentVaultService }
}

/** Error carrying a stable code across Host, tool, and Client boundaries. */
export class AgentVaultError extends Error {
  constructor(
    message: string,
    readonly code: AgentVaultErrorCode,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgentVaultError'
  }
}

/** Host service contract for portable, file-native Agent Vaults. */
export abstract class AgentVaultService extends Service {
  constructor(ctx: Context) { super(ctx, 'agentVaults') }

  /**
   * Observe durable semantic file changes. Consumers must re-read the Markdown source after a signal.
   * @param listener - Called after an internal write or a watched external filesystem change.
   * @returns Subscription disposer.
   */
  abstract subscribeChanges(listener: (change: AgentVaultChange) => void): () => void

  /**
   * List every Vault manifest.
   * @returns Available manifests.
   */
  abstract listAgents(): Promise<readonly AgentVaultManifest[]>
  /**
   * Bind a runtime Agent to its only private Vault.
   * @param runtimeAgentId - Runtime identity.
   * @param agentId - Vault identity.
   * @returns Binding disposer.
   */
  abstract bindRuntimeAgent(runtimeAgentId: string, agentId: string): () => void
  /**
   * Resolve an authorized private Vault.
   * @param runtimeAgentId - Runtime identity.
   * @returns Bound Vault identity, if any.
   */
  abstract resolveRuntimeAgent(runtimeAgentId: string): string | undefined
  /**
   * Create a new Vault.
   * @param agentId - Portable Agent identity.
   * @param name - Display name.
   * @returns Created manifest.
   */
  abstract createAgent(agentId: string, name: string): Promise<AgentVaultManifest>
  /**
   * Move a Vault to recoverable trash.
   * @param agentId - Vault identity.
   * @param context - Authorized mutation context.
   * @returns Completion.
   */
  abstract removeAgent(agentId: string, context: VaultWriteContext): Promise<void>
  /**
   * List complete Vault snapshots in recoverable account trash.
   * @returns Trash entries newest first.
   */
  abstract listTrash(): Promise<readonly AgentVaultTrashEntry[]>
  /**
   * Resolve only the designated profile appearance from one trashed Vault.
   * @param trashId - Opaque trash entry identity.
   * @returns Host-only image delivery target.
   */
  abstract trashAppearanceContent(trashId: string): Promise<VaultResourceContent>
  /**
   * Restore one trashed Vault without overwriting an active Vault.
   * @param trashId - Opaque trash entry identity.
   * @returns Restored manifest.
   */
  abstract restoreTrash(trashId: string): Promise<AgentVaultManifest>
  /**
   * Permanently remove one trashed Vault.
   * @param trashId - Opaque trash entry identity.
   * @returns Completion.
   */
  abstract deleteTrash(trashId: string): Promise<void>
  /**
   * Permanently remove every trashed Vault.
   * @returns Number of removed entries.
   */
  abstract emptyTrash(): Promise<number>
  /**
   * Read a Vault manifest.
   * @param agentId - Vault identity.
   * @returns Manifest.
   */
  abstract manifest(agentId: string): Promise<AgentVaultManifest>
  /**
   * Read a Vault policy.
   * @param agentId - Vault identity.
   * @returns Policy.
   */
  abstract policy(agentId: string): Promise<VaultPolicy>
  /**
   * Replace a Vault policy.
   * @param agentId - Vault identity.
   * @param policy - New policy.
   * @param context - Authorized mutation context.
   * @returns Persisted policy.
   */
  abstract setPolicy(agentId: string, policy: VaultPolicy, context: VaultWriteContext): Promise<VaultPolicy>
  /**
   * List a portable directory.
   * @param agentId - Vault identity.
   * @param uri - Directory URI.
   * @param cursor - Entry offset.
   * @param limit - Result bound.
   * @returns Directory entries.
   */
  abstract list(agentId: string, uri: VaultUri, cursor?: number, limit?: number): Promise<readonly VaultEntry[]>
  /**
   * Read a bounded document view.
   * @param agentId - Vault identity.
   * @param uri - Document URI.
   * @param view - Read mode.
   * @param selector - Section or grep selector.
   * @returns Parsed document.
   */
  abstract read(agentId: string, uri: VaultUri, view?: VaultDocument['view'], selector?: string): Promise<VaultDocument>
  /**
   * Write one document.
   * @param agentId - Vault identity.
   * @param uri - Document URI.
   * @param content - Markdown source.
   * @param context - Authorized mutation context.
   * @returns Persisted document.
   */
  abstract write(agentId: string, uri: VaultUri, content: string, context: VaultWriteContext): Promise<VaultDocument>
  /**
   * Create one portable directory.
   * @param agentId - Vault identity.
   * @param uri - Directory URI.
   * @param context - Authorized mutation context.
   * @returns Created directory.
   */
  abstract createDirectory(agentId: string, uri: VaultUri, context: VaultWriteContext): Promise<VaultEntry>
  /**
   * Copy one document or directory inside its semantic domain.
   * @param agentId - Vault identity.
   * @param source - Source URI.
   * @param target - Target URI.
   * @param context - Authorized mutation context.
   * @returns Copied entry.
   */
  abstract copy(agentId: string, source: VaultUri, target: VaultUri,
    context: VaultWriteContext): Promise<VaultEntry>
  /**
   * Move one document or directory inside its semantic domain.
   * @param agentId - Vault identity.
   * @param source - Source URI.
   * @param target - Target URI.
   * @param context - Authorized mutation context.
   * @returns Moved entry.
   */
  abstract move(agentId: string, source: VaultUri, target: VaultUri, context: VaultWriteContext): Promise<VaultEntry>
  /**
   * Read revision history.
   * @param agentId - Vault identity.
   * @param uri - Document URI.
   * @param limit - Result bound.
   * @returns Historical entries.
   */
  abstract history(agentId: string, uri: VaultUri, limit?: number): Promise<readonly VaultEntry[]>
  /**
   * Recall directional cards.
   * @param input - Bounded query.
   * @returns Ranked cards.
   */
  abstract recall(input: RecallQuery): Promise<RecallResult>
  /**
   * Follow local Wiki links progressively.
   * @param agentId - Vault identity.
   * @param origins - Starting URIs.
   * @param maxPages - Page bound.
   * @param maxChars - Character bound.
   * @returns Read documents.
   */
  abstract explore(agentId: string, origins: readonly VaultUri[], maxPages?: number, maxChars?: number): Promise<readonly VaultDocument[]>
  /**
   * Inspect structured self.
   * @param agentId - Vault identity.
   * @returns Self snapshot.
   */
  abstract inspectSelf(agentId: string): Promise<SelfSnapshot>
  /**
   * Update one self module.
   * @param agentId - Vault identity.
   * @param module - Replacement module.
   * @param context - Authorized mutation context.
   * @returns Persisted module.
   */
  abstract updateSelf(agentId: string, module: SelfModule, context: VaultWriteContext): Promise<SelfModule>
  /**
   * Capture immediately searchable memory.
   * @param input - Memory facts.
   * @param context - Authorized mutation context.
   * @returns Short-term document.
   */
  abstract captureMemory(input: CaptureMemoryInput, context: VaultWriteContext): Promise<VaultDocument>
  /**
   * Queue an adjacent-stage consolidation.
   * @param agentId - Vault identity.
   * @param source - Source stage.
   * @param target - Target stage.
   * @param context - Authorized mutation context.
   * @returns Queued job.
   */
  abstract queueConsolidation(agentId: string, source: MemoryStage, target: MemoryStage,
    context: VaultWriteContext): Promise<ConsolidationJob>
  /**
   * Run one bounded consolidation batch.
   * @param jobId - Job identity.
   * @param maxItems - Batch bound.
   * @returns Updated job.
   */
  abstract runConsolidation(jobId: string, maxItems?: number): Promise<ConsolidationJob>
  /**
   * List consolidation jobs.
   * @param agentId - Vault identity.
   * @returns Jobs newest first.
   */
  abstract consolidationJobs(agentId: string): Promise<readonly ConsolidationJob[]>
  /**
   * Import resource bytes or an external reference.
   * @param agentId - Vault identity.
   * @param draft - Resource metadata.
   * @param data - Optional bytes.
   * @param context - Authorized mutation context.
   * @returns Imported resource.
   */
  abstract importResource(agentId: string, draft: VaultResourceDraft, data: Uint8Array | undefined,
    context: VaultWriteContext): Promise<VaultResource>
  /**
   * Stream a file into resource storage.
   * @param agentId - Vault identity.
   * @param draft - Resource metadata.
   * @param sourceFile - Host source path.
   * @param context - Authorized mutation context.
   * @returns Imported resource.
   */
  abstract importResourceFromFile(agentId: string, draft: VaultResourceDraft, sourceFile: string,
    context: VaultWriteContext): Promise<VaultResource>
  /**
   * Search resource metadata.
   * @param input - Bounded resource query.
   * @returns Cursor page.
   */
  abstract searchResources(input: ResourceSearchInput): Promise<ResourcePage>
  /**
   * Read resource metadata.
   * @param agentId - Vault identity.
   * @param id - Resource identity.
   * @returns Resource metadata.
   */
  abstract resource(agentId: string, id: string): Promise<VaultResource>
  /**
   * Resolve a resource delivery target.
   * @param agentId - Vault identity.
   * @param id - Resource identity.
   * @returns Host-only content target.
   */
  abstract resourceContent(agentId: string, id: string): Promise<VaultResourceContent>
  /**
   * Update resource metadata.
   * @param agentId - Vault identity.
   * @param id - Resource identity.
   * @param patch - Mutable fields.
   * @param context - Authorized mutation context.
   * @returns Updated resource.
   */
  abstract updateResource(agentId: string, id: string, patch: Partial<Pick<VaultResource,
    'title' | 'description' | 'tags' | 'originalTags' | 'transcript' | 'roles' | 'durationMs'>>,
    context: VaultWriteContext): Promise<VaultResource>
  /**
   * Remove a resource record.
   * @param agentId - Vault identity.
   * @param id - Resource identity.
   * @param context - Authorized mutation context.
   * @returns Completion.
   */
  abstract removeResource(agentId: string, id: string, context: VaultWriteContext): Promise<void>
  /**
   * Toggle resource availability.
   * @param agentId - Vault identity.
   * @param id - Resource identity.
   * @param enabled - New state.
   * @param context - Authorized mutation context.
   * @returns Updated resource.
   */
  abstract setResourceEnabled(agentId: string, id: string, enabled: boolean, context: VaultWriteContext): Promise<VaultResource>
  /**
   * Export one portable character package.
   * @param agentId - Vault identity.
   * @param targetFile - Package target.
   * @param shareable - Whether private history is omitted.
   * @returns Package report.
   */
  abstract exportAgent(agentId: string, targetFile: string, shareable: boolean): Promise<VaultPackageReport>
  /**
   * Import a portable character package.
   * @param packageFile - Package source.
   * @param targetAgentId - Optional replacement identity.
   * @returns Import report.
   */
  abstract importAgent(packageFile: string, targetAgentId?: string): Promise<VaultPackageReport>
  /**
   * Rebuild the disposable projection.
   * @param agentId - Vault identity.
   * @returns New index revision.
   */
  abstract rebuildIndex(agentId: string): Promise<number>
  /**
   * Resolve a URI for exceptional Host editing.
   * @param agentId - Vault identity.
   * @param uri - Portable URI.
   * @param mode - Access mode.
   * @param context - Required write context.
   * @returns Host path and optional write lease.
   */
  abstract resolvePath(agentId: string, uri: VaultUri, mode: 'read' | 'write', context?: VaultWriteContext): Promise<{ readonly path: string; readonly leaseId?: string }>
  /**
   * Reconcile an external write lease.
   * @param agentId - Vault identity.
   * @param leaseId - Lease identity.
   * @returns Reindexed entry.
   */
  abstract reconcile(agentId: string, leaseId: string): Promise<VaultEntry>
}

export default AgentVaultService
