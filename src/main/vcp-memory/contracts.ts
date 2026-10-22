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
}

export interface VcpMemorySearchHit extends VcpMemoryNote {
  score: number;
  sourceFile: string;
  engine: 'river' | 'knn';
}

export interface VcpMemorySearchResult {
  results: VcpMemorySearchHit[];
  diagnostics: Record<string, unknown>;
  degraded: boolean;
}

export interface VcpMemoryWorkerConfiguration {
  dataRoot: string;
  vendorRoot: string;
  scope: VcpMemoryScope;
  embedding: VcpMemoryEmbeddingConfig;
  plugins?: VcpMemoryPluginConfiguration;
}

export interface VcpMemoryPluginConfiguration {
  chat?: { baseUrl: string; model: string; apiKey: string };
  riverThinkingEnabled?: boolean;
}
export interface VcpMemoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
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
  /** Host provenance; legacy artifacts without this must be regenerated for a resident. */
  owner?: VcpMemoryOwnerIdentity;
  agents: Array<{ agentName: string; months: Array<{ month: string; sourceDigest: string; content?: string; summary?: string }> }>;
}

export type VcpMemoryCommand =
  | { type: 'initialize'; configuration: VcpMemoryWorkerConfiguration }
  | { type: 'remember'; note: VcpMemoryNote }
  | { type: 'replace'; notes: VcpMemoryNote[] }
  | { type: 'search'; text: string; topK?: number }
  | { type: 'read'; id: string }
  | { type: 'list' }
  | { type: 'forget'; id: string }
  | { type: 'plugin'; plugin: VcpMemoryPluginName; arguments: Record<string, unknown> }
  | { type: 'preprocess'; messages: VcpMemoryMessage[] }
  | { type: 'timeline'; request: VcpMemoryTimelineRequest }
  | { type: 'capabilities' }
  | { type: 'export-notes' }
  | { type: 'export-timelines'; sourceRevision: string }
  | { type: 'import-timelines'; sourceRevision: string; artifacts: VcpMemoryTimelineArtifacts }
  | { type: 'close' };

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
