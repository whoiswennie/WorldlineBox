/** Portable Agent Vault vocabulary. @module @deepseek-ai/dsh-agent-vault/types */

export const AGENT_VAULT_DOMAINS = ['self', 'memory', 'procedure', 'resource'] as const
/** Independently authorized semantic areas in an Agent Vault. */
export type AgentVaultDomain = typeof AGENT_VAULT_DOMAINS[number]
/** Human-inspired memory maturation stages. */
export type MemoryStage = 'short' | 'medium' | 'long'
/** Agent write authority granted by a Vault policy. */
export type VaultWriteMode = 'autonomous' | 'proposal' | 'readonly'
/** Portable address understood by Agent Vault tools. */
export type VaultUri = `vault://${string}` | `shared://${string}`
  | `agent://${string}/public/${string}` | `resource://sha256/${string}` | `temp://session/${string}`

/** Host-enforced write and freeze policy for one Vault. */
export interface VaultPolicy {
  readonly aiWriteMode: VaultWriteMode
  readonly domains: Readonly<Record<AgentVaultDomain, VaultWriteMode>>
  readonly userEditable: boolean
  readonly fullyFrozen: boolean
}

/** Principal responsible for one Vault mutation. */
export interface VaultActor {
  readonly type: 'agent' | 'user' | 'system'
  readonly id: string
}

/** Auditable mutation context and optional optimistic revision. */
export interface VaultWriteContext {
  readonly actor: VaultActor
  readonly reason: string
  readonly expectedRevision?: string
}

/** Portable package identity and format version. */
export interface AgentVaultManifest {
  readonly format: 'worldline-agent-vault'
  readonly formatVersion: 1
  readonly agent: { readonly id: string; readonly name: string }
  readonly createdAt: number
  readonly updatedAt: number
}

/** Lightweight filesystem or resource directory entry. */
export interface VaultEntry {
  readonly uri: VaultUri
  readonly id: string
  readonly domain: AgentVaultDomain
  readonly kind: 'directory' | 'document' | 'resource'
  readonly name: string
  readonly bytes: number
  readonly revision: string
  readonly updatedAt: number
}

/** Parsed Markdown document returned through a bounded read view. */
export interface VaultDocument extends VaultEntry {
  readonly kind: 'document'
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly aliases: readonly string[]
  readonly sources: readonly string[]
  readonly headings: readonly string[]
  readonly links: readonly string[]
  readonly content: string
  readonly totalLines: number
  readonly view: 'top' | 'section' | 'grep' | 'full'
}

/** Hard limits applied to an interactive recall. */
export interface RecallBudget {
  readonly maxResults?: number
  readonly maxChars?: number
  readonly maxMillis?: number
}

/** Model-free recall request scoped to one semantic domain. */
export interface RecallQuery {
  readonly agentId: string
  readonly domain: Exclude<AgentVaultDomain, 'self'>
  readonly query: string
  readonly tags?: readonly string[]
  readonly stage?: MemoryStage
  readonly budget?: RecallBudget
}

/** Directional result card that can be deepened progressively. */
export interface RecallCard {
  readonly uri: VaultUri
  readonly id: string
  readonly domain: Exclude<AgentVaultDomain, 'self'>
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly score: number
  readonly confidence: 'high' | 'medium' | 'low'
  readonly reasons: readonly string[]
  readonly matchedTerms: readonly string[]
  readonly revision: string
  readonly updatedAt: number
}

/** Bounded recall response and its derived-index revision. */
export interface RecallResult {
  readonly cards: readonly RecallCard[]
  readonly continuation?: string
  readonly elapsedMs: number
  readonly indexRevision: number
}

/** Structured, independently enabled facet of an Agent's self model. */
export interface SelfModule {
  readonly id: string
  readonly title: string
  readonly enabled: boolean
  readonly autonomous: boolean
  readonly locked: boolean
  readonly stability: 'core' | 'stable' | 'dynamic'
  readonly summary: string
  readonly details: readonly string[]
  readonly updatedAt: number
  readonly revision: string
}

/** Current enabled and disabled self modules for one Agent. */
export interface SelfSnapshot {
  readonly agentId: string
  readonly modules: readonly SelfModule[]
  readonly compiled: string
  readonly revision: string
}

/** Immediate short-term memory capture request. */
export interface CaptureMemoryInput {
  readonly agentId: string
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly aliases?: readonly string[]
  readonly sources?: readonly string[]
  readonly importance?: 1 | 2 | 3 | 4 | 5
  readonly occurredAt?: number
}

/** Durable checkpointed transition between adjacent memory stages. */
export interface ConsolidationJob {
  readonly id: string
  readonly agentId: string
  readonly status: 'queued' | 'running' | 'paused' | 'completed' | 'failed'
  readonly sourceStage: MemoryStage
  readonly targetStage: MemoryStage
  readonly total: number
  readonly processed: number
  readonly checkpoint?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly error?: string
}

/** Supported purposes for a resource within the Vault. */
export type VaultResourceRole = 'expression' | 'appearance' | 'source' | 'attachment'

/** Indexed metadata for a content-addressed or external resource. */
export interface VaultResource {
  readonly id: string
  readonly agentId: string
  readonly uri: VaultUri
  readonly enabled: boolean
  readonly roles: readonly VaultResourceRole[]
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
  readonly originalTags: readonly string[]
  readonly transcript: string
  readonly mimeType: string
  readonly bytes: number
  readonly durationMs?: number
  readonly usageCount: number
  readonly lastUsedAt?: number
  readonly sha256?: string
  readonly externalUrl?: string
  readonly builtIn: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: string
}

/** Metadata accepted when importing a new Vault resource. */
export interface VaultResourceDraft {
  readonly enabled: boolean
  readonly roles: readonly VaultResourceRole[]
  readonly title: string
  readonly description: string
  readonly tags: readonly string[]
  readonly originalTags: readonly string[]
  readonly transcript: string
  readonly mimeType: string
  readonly bytes: number
  readonly durationMs?: number
  readonly externalUrl?: string
  readonly builtIn: boolean
  readonly usageCount?: number
  readonly lastUsedAt?: number
  /** Host migration only: preserve stable event references from the legacy catalog. */
  readonly preferredId?: string
  readonly createdAt?: number
}

/** Bounded resource discovery request. */
export interface ResourceSearchInput {
  readonly agentId: string
  readonly query: string
  readonly tags?: readonly string[]
  readonly roles?: readonly VaultResourceRole[]
  readonly includeDisabled?: boolean
  readonly cursor?: number
  readonly limit?: number
}

/** Cursor page returned by resource discovery. */
export interface ResourcePage {
  readonly items: readonly VaultResource[]
  readonly nextCursor: number
}

/** Host-only delivery target; resolved filesystem paths never cross model or Client boundaries. */
export type VaultResourceContent =
  | { readonly type: 'file'; readonly path: string; readonly mimeType: string; readonly bytes: number }
  | { readonly type: 'external'; readonly url: string; readonly mimeType: string }

/** Integrity and size report for an imported or exported character package. */
export interface VaultPackageReport {
  readonly agentId: string
  readonly files: number
  readonly resources: number
  readonly bytes: number
  readonly sha256: string
  readonly warnings: readonly string[]
}

/** Stable machine-readable failures exposed by the service boundary. */
export type AgentVaultErrorCode =
  | 'INVALID_AGENT_ID' | 'INVALID_URI' | 'DOMAIN_VIOLATION' | 'VAULT_NOT_FOUND'
  | 'ENTRY_NOT_FOUND' | 'REVISION_CONFLICT' | 'VAULT_READONLY' | 'DOMAIN_READONLY'
  | 'USER_LOCKED' | 'INVALID_RESOURCE' | 'INTEGRITY_FAILED' | 'IMPORT_REJECTED'
  | 'BUDGET_EXCEEDED'
