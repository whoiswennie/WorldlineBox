import type { Branded } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Loader or Skill Registry state changed and inventory clients must read a fresh snapshot.
     * @mode emit
     */
    'plugin-inventory/change'(): void
  }
}

/** Qualified Loader-tree identity, including parent entry ids for nested rows. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
  /** Core application rows cannot be mutated from the local manager. */
  readonly protected: boolean
}

/** One skill visible to the local management surface, including disabled skills. */
export interface SkillInventoryEntry {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly provider: string
  readonly enabled: boolean
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** Host-resolved resource directory, when the provider exposes one. */
  readonly directory?: string
  /** Only filesystem-backed project, user, and custom skills can be deleted. */
  readonly canDelete: boolean
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
  /** Active browser module identities in the current boot graph. */
  readonly clientModules: readonly string[]
  /** Globally discoverable Skill identities after provider resolution. */
  readonly skillIds: readonly string[]
  readonly skills: readonly SkillInventoryEntry[]
}

/** Workspace-sensitive inventory read. Project Skill providers use this cwd for discovery. */
export interface PluginInventoryListRequest {
  readonly cwd?: string
}

/** Renderer intent for one local plugin row. */
export interface PluginInventoryMutationRequest {
  readonly entryId: PluginEntryId
  readonly enabled?: boolean
  /** Preserve the caller's project Skill view in the returned snapshot. */
  readonly cwd?: string
}

/** Renderer intent for one local skill. */
export interface SkillInventoryMutationRequest {
  readonly name: string
  readonly enabled?: boolean
  /** Project root used to resolve and reload filesystem-backed Skills. */
  readonly cwd?: string
}

/** Availability of one local command-line toolchain discovered by the Host. */
export interface ToolchainStatus {
  readonly ready: boolean
  /** Normalized semantic version without the tool's name prefix. */
  readonly version?: string
}

/** Startup snapshot used by trusted Client chrome; it contains no environment values or paths. */
export interface ToolchainStatusSnapshot {
  readonly python: ToolchainStatus
  readonly node: ToolchainStatus
  readonly git: ToolchainStatus
  readonly detectedAt: number
}
