import type { VcpMemoryOwnerIdentity } from './contracts';

export type VcpMemoryDreamClock = 'world' | 'real';
/** Host-authorized immutable read set. Neither the dream model nor filename
 * dates may assign ownership, versions, clocks or event times. */
export interface VcpMemoryDreamWaveRequest {
  owner: VcpMemoryOwnerIdentity;
  sourceRevision: string;
  now: string;
  clockDomain: VcpMemoryDreamClock;
  notes: Array<{ id: string; version: number; eventTime: string; clockDomain: VcpMemoryDreamClock; contentHash: string }>;
}
export interface VcpMemoryDreamWaveItem {
  id: string;
  version: number;
  eventTime: string;
  clockDomain: VcpMemoryDreamClock;
  /** Original engine's bounded _safeText, never synthetic evidence. */
  text: string;
  score?: number;
  retrievalEngine?: 'rivermemo' | 'knn';
}
export interface VcpMemoryDreamWaveResult {
  schema: 'worldlinebox.vcp-dream-wave';
  owner: VcpMemoryOwnerIdentity;
  sourceRevision: string;
  now: string;
  clockDomain: VcpMemoryDreamClock;
  boundaries: { recentDays: number; midDays: number };
  stages: {
    recent: { seeds: VcpMemoryDreamWaveItem[]; resonanceL1: VcpMemoryDreamWaveItem[]; cascadeL2: VcpMemoryDreamWaveItem[] };
    mid: { seeds: VcpMemoryDreamWaveItem[]; cascadeL1: VcpMemoryDreamWaveItem[] };
    deep: { recalls: VcpMemoryDreamWaveItem[] };
  };
  diagnostics: { algorithm: 'upstream-DreamWaveEngine'; sourceCount: number; indexedCount: number;
    queries: Array<{ phase: 'recent' | 'mid' | 'deep'; allowedNoteIds: string[]; returnedNoteIds: string[]; engine: 'rivermemo' | 'knn';
      candidateMode?: 'scoped-topology-v3' | 'scoped-knn' }> };
}
