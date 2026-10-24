import type { VcpMemoryEmbeddingConfig } from './contracts';
export interface ColdKnowledgeDocument {
  id: string; sourceId: string; sourceDigest: string; text: string; title?: string;
  sourceVersion?: string; sourceType?: 'message' | 'memory' | 'learning'; metadata?: Record<string, unknown>;
}
export interface ColdKnowledgeRecord extends Omit<ColdKnowledgeDocument, 'text'> {
  version: string; contentDigest: string; snapshot: string; status: 'pending' | 'ready' | 'revoked'; chunks?: number;
}
export interface ColdKnowledgeHit extends Omit<ColdKnowledgeRecord, 'snapshot' | 'status'> {
  text: string; score: number; chunkIndex?: number; generation: string;
}
export interface ColdKnowledgeState { revision: number; generation?: string; embeddingKey?: string; documents: ColdKnowledgeRecord[] }
export interface ColdKnowledgeWorkerConfiguration { dataRoot: string; vendorRoot: string; embedding: VcpMemoryEmbeddingConfig }
export type ColdKnowledgeCommand =
  | { type: 'initialize'; configuration: ColdKnowledgeWorkerConfiguration }
  | { type: 'build'; owner: string; generation: string; previous?: string; documents: ColdKnowledgeRecord[]; embeddingKey: string }
  | { type: 'search'; owner: string; generation: string; embeddingKey: string; documents: ColdKnowledgeRecord[]; text: string; topK: number; expand?: boolean }
  | { type: 'barrier' }
  | { type: 'close' };
