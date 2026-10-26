import type { PreparedRecallRecovery } from './prepared-recall-recovery';
import type { CompanionPreparedRecallReference } from '../../shared/companion-prepared-recall';

export interface VcpMemoryEmbeddingConfig {
  /** OpenAI compatible service root, with an optional trailing /v1. */
  baseUrl: string;
  /** Optional query-purpose endpoint; document ingestion continues to use baseUrl. */
  queryBaseUrl?: string;
  model: string;
  apiKey: string;
  dimension: number;
  /** Stable identity of the embedding semantic space, including model revision. */
  modelSignature?: string;
}

/** The host derives this from the owner and the complete visibility domain. */
export interface VcpMemoryScope { scopeId: string }

export interface VcpMemoryNote {
  id: string;
  content: string;
  tags: string[];
  occurredAt?: string;
  author?: string;
  diaryName?: string;
  metadata?: Record<string, unknown>;
  /** Host-only calendar projection; source content/occurredAt remain unchanged. */
  hostProjection?: { timeZone: string };
}

/** Unweighted values copied from upstream's final ordered result; not probabilities. */
export interface VcpMemoryScoreDetails {
  engine: 'river' | 'knn';
  /** Original returned chunk position, before host note deduplication or visibility filtering. */
  rank: number;
  nativeRank?: number;
  finalScore?: number;
  originalScore?: number;
  vectorScore?: number;
  /** Continuous field and closure base; not a pure semantic/cosine score. */
  baseScore?: number;
  topologyBonus?: number;
  anchorBonus?: number;
  /** Query river observability, not confidence that a memory is correct. */
  omega?: number;
  role?: string;
  riverRegime?: string;
  matchedTags?: string[];
  coreTagsMatched?: string[];
  candidateSources?: string[];
  algorithmVersion?: string;
  queryMode?: string;
}
export interface VcpMemorySearchHit extends VcpMemoryNote {
  score?: number;
  scoreDetails?: VcpMemoryScoreDetails;
  sourceFile: string;
  engine: 'river' | 'knn';
}

export interface VcpMemorySearchResult {
  results: VcpMemorySearchHit[];
  diagnostics: Record<string, unknown>;
  degraded: boolean;
  retrieval?: {
    embeddingDimension: number;
    diaryCount: number;
    matchedTags: string[];
    coreTagsMatched: string[];
    counts: Partial<Record<'offeredCandidates' | 'projectedCandidates' | 'selectedCandidates' | 'rankedCandidates' | 'returnedCandidates' | 'artifactNodes' | 'artifactEdges', number>>;
    hits: Array<{ id: string; rank: number; text?: string; sourcePath?: string; matchedTags: string[]; coreTagsMatched: string[];
      anchor?: Partial<Record<'contactedSeeds' | 'exactContacts' | 'semanticContacts' | 'anchorReliability' | 'meanClosure', number>> }>;
  };
}

export interface VcpMemoryWorkerConfiguration {
  dataRoot: string;
  vendorRoot: string;
  scope: VcpMemoryScope;
  embedding: VcpMemoryEmbeddingConfig;
  plugins?: VcpMemoryPluginConfiguration;
}

export interface VcpMemoryPluginConfiguration {
  /** Trusted live owner-file snapshot; never inferred from retrieval text. */
  ownerPrompts?: VcpMemoryOwnerPrompts;
  chat?: { baseUrl: string; model: string; apiKey: string;
    /** Non-secret signature of the provider behind a loopback facade. */
    sourceSignature?: string;
    /** In-memory credential generation; never a credential-derived public hash. */
    connectionGeneration?: number };
  riverThinkingEnabled?: boolean;
  /** Explicit A/B profile; default preserves corrections as the existing host did. */
  behaviorProfile?: 'preserve-corrections' | 'upstream';
}
/** Observed at the original formatter/model-input boundary, not inferred from top-K ranks. */
export interface VcpMemoryContextReference {
  id: string;
  role: 'returned' | 'focus_input';
  sourceFile?: string;
  textHash: string;
}
export interface VcpMemoryCapabilities {
  plugins: Record<string, { version: string; available: boolean }>;
  timelineGenerationConfigured: boolean;
  coldKnowledge: boolean;
  modes?: Record<string, { available: boolean; configured: boolean; enabledByDefault: boolean; exposure: string; cost: string; observedCalls: number;
    reason?: string; configurations?: string[] }>;
  behavior?: { profile: string; differences: Array<{ parameter: string; upstream: unknown; effective: unknown }>; generation: Record<string, unknown> };
}
export interface VcpMemoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
}
export interface VcpMemoryQueryClock { now: string; timeZone: string }
export interface VcpMemoryPreparationReceipt { ready: true; corpusEpoch: number }
export interface VcpMemoryPreprocessResult {
  messages: VcpMemoryMessage[];
  events: unknown[];
  contextReferences?: VcpMemoryContextReference[];
  contextReferenceCoverage?: 'observed' | 'partial';
  queryClock?: VcpMemoryQueryClock;
  automaticDecay?: VcpMemoryDecayObservation[];
  parsedTimeRanges?: Array<{ start: string; end: string }>;
  cacheClock?: { bucket: string; invalidated: boolean };
  receiptCache?: { hit: boolean; corpusEpoch: number; sourceQueryClock?: VcpMemoryQueryClock };
}
/** Opaque workspace-scoped handle. Candidate bodies remain in the owned host store. */
export interface VcpMemoryPreparedRecall {
  schema: 'worldlinebox.prepared-recall-v2'; id: string; scopeId: string; contentHash: string;
  createdAt: string; expiresAt: string; corpusEpoch: number;
  contextReferences: VcpMemoryContextReference[]; contextReferenceCoverage: 'observed' | 'partial';
  queryClock?: VcpMemoryQueryClock;
  /** Identity projection only. The complete recovery authority is loaded from
   * the verified, contentHash-bound owner packet, never inferred here. */
  hostEvidence?: Omit<VcpMemoryPreparedHostEvidence, 'recovery'>;
}
export interface VcpMemoryPreparedHostEvidence {
  schema: 'worldlinebox.prepared-recall-host-evidence';
  ownerId: string; revocationEpoch: number; capturedAt: string; sourceClosureDigest: string;
  recovery?: PreparedRecallRecovery;
}
export interface VcpMemoryPreparedFocusGroup {
  token: string; dbNames: string[]; userContent: string; aiContent: string | null;
  combinedQueryForDisplay: string; promptTemplate: string;
  config: { model: string; batchSize: number; maxTokensPerBatch: number; promptFile: string };
  options: { sourceFiles: Array<Record<string, unknown>>; [key: string]: unknown };
}
/** Trusted worker transport only; no credentials, native pointers or mutable file references. */
export interface VcpMemoryPreparedPayload {
  schema: 'worldlinebox.prepared-recall-payload'; receipt: VcpMemoryPreprocessResult;
  groups: VcpMemoryPreparedFocusGroup[]; modelIdentity: string;
  hostEvidence?: VcpMemoryPreparedHostEvidence;
}
export type VcpMemoryFocusValidationReason = 'fence' | 'model_admission' | 'publication';
export interface VcpMemoryFocusOptions {
  signal?: AbortSignal;
  /** Called before every actual model request and before publishing, including cache reuse. */
  validate?(reason?: VcpMemoryFocusValidationReason): Promise<void>;
  fetchFn?: typeof fetch;
  /** Required for an owner-bound host package, never inferred from a caller-supplied scope string. */
  ownerId?: string;
  /** Persist the receipt hash through the existing durable task checkpoint. */
  onFocused?(reference: CompanionPreparedRecallReference): Promise<void>;
  /** Shared host model quota; does not hold an original graph/worker permit. */
  runModel?<T>(operation: () => Promise<T>): Promise<T>;
}
export interface VcpMemoryAutomaticDecayPolicy { schema: 'episodic-v1'; halfLifeDays: 180; minScore: 0; protectedNoteIds: string[] }
export interface VcpMemoryDecayObservation {
  policy: 'episodic-v1'; halfLifeDays: 180; minScore: 0; eligibleCount: number; protectedCount: number;
  results: Array<{ id?: string; score?: number; originalScore?: number; diffDays?: number; decayFactor?: number; protected: boolean; explicitTime: boolean }>;
}
export type VcpMemoryPluginName = 'DailyNote' | 'DailyNoteManager' | 'LightMemo';
export interface VcpMemoryOwnerIdentity {
  version: 2;
  companionId: string;
  name: string;
  agentName: string;
}
export interface VcpMemoryTimelineRequest {
  operation: 'listAgents' | 'getAgentDetail' | 'generateTimelines' | 'generateSummaries' | 'saveTimelineFile' | 'saveSummary';
  agentName?: string;
  month?: string;
  content?: string;
  options?: Record<string, unknown>;
  owner?: VcpMemoryOwnerIdentity;
}
export interface VcpMemoryTimelineArtifacts {
  schema: 'worldlinebox.vcp-timeline-artifacts';
  sourceRevision: string;
  /** Calendar used to project source dates and group months; legacy is Shanghai. */
  calendarTimeZone?: string;
  /** Host provenance; legacy artifacts without this must be regenerated for a resident. */
  owner?: VcpMemoryOwnerIdentity;
  agents: Array<{ agentName: string; months: Array<{ month: string; sourceDigest: string; content?: string; summary?: string }> }>;
}

export interface VcpMemoryOwnerPrompts { aimemoTemplate: string; timelineTemplate?: string; summaryTemplate?: string }
export type VcpMemoryCommand = (
  | { type: 'initialize'; configuration: VcpMemoryWorkerConfiguration }
  | { type: 'remember'; note: VcpMemoryNote }
  | { type: 'replace'; notes: VcpMemoryNote[] }
  | { type: 'projection-delta'; notes: VcpMemoryNote[]; removedIds: string[] }
  | { type: 'prepare' }
  | { type: 'search'; text: string; topK?: number }
  | { type: 'read'; id: string }
  | { type: 'list' }
  | { type: 'forget'; id: string }
  | { type: 'plugin'; plugin: VcpMemoryPluginName; arguments: Record<string, unknown> }
  | { type: 'preprocess'; messages: VcpMemoryMessage[]; clock?: VcpMemoryQueryClock; automaticDecay?: VcpMemoryAutomaticDecayPolicy }
  | { type: 'prepare-recall'; messages: VcpMemoryMessage[]; clock?: VcpMemoryQueryClock; automaticDecay?: VcpMemoryAutomaticDecayPolicy }
  | { type: 'dream-wave'; request: VcpMemoryDreamWaveRequest }
  | { type: 'timeline'; request: VcpMemoryTimelineRequest }
  | { type: 'capabilities' }
  | { type: 'export-notes' }
  | { type: 'export-timelines'; sourceRevision: string }
  | { type: 'import-timelines'; sourceRevision: string; artifacts: VcpMemoryTimelineArtifacts }
  | { type: 'close' }) & { ownerPrompts?: VcpMemoryOwnerPrompts };

export interface VcpMemoryWriteReceipt { id: string; indexed: true }
export interface VcpMemoryDeleteReceipt { id: string; deleted: true }
import { createHash } from 'node:crypto';

/** Stable single-component alias accepted unchanged by upstream DailyNote and RAG markers. */
export function vcpMemoryNotebookFolder(diaryName?: string): string {
  const name = diaryName?.trim();
  if (!name || name === 'memories') return 'memories';
  const label = Array.from(name.replaceAll('日记本', '日记').replace(/[^\p{L}\p{N}-]/gu, '_').replace(/_+/gu, '_').replace(/^_+|_+$/gu, '')).slice(0, 24).join('') || 'notebook';
  return `nb-${label}-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
}
import type { VcpMemoryDreamWaveRequest } from './dream-contracts';
