export type CompanionInstanceLeaseKind = 'task' | 'session' | 'question' | 'background' | 'workbench' | 'keep-alive' | 'discovery';

/** In-memory use, not ownership: durable native state must still prove idle before shutdown. */
export class CompanionInstanceLeases {
  private readonly entries = new Map<string, Map<symbol, CompanionInstanceLeaseKind>>();
  private readonly epochs = new Map<string, number>();
  touch(id: string): number { const epoch = this.epoch(id) + 1; this.epochs.set(id, epoch); return epoch; }
  epoch(id: string): number { return this.epochs.get(id) ?? 0; }
  count(id: string): number { return this.entries.get(id)?.size ?? 0; }
  acquire(id: string, kind: CompanionInstanceLeaseKind, released: () => void): () => void {
    this.touch(id);
    const entry = this.entries.get(id) ?? new Map<symbol, CompanionInstanceLeaseKind>();
    const key = Symbol(kind); entry.set(key, kind); this.entries.set(id, entry);
    let active = true;
    return () => {
      if (!active) return; active = false;
      entry.delete(key); if (!entry.size) this.entries.delete(id);
      this.touch(id); released();
    };
  }
  forget(id: string): void { this.entries.delete(id); this.epochs.delete(id); }
}

/** Old or unavailable bridge versions cannot certify a safe idle shutdown. */
export function nativeIdleConfirmed(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const proof = value as Record<string, unknown>;
  return proof.known === true && proof.idle === true
    && ['activeTurns', 'backgroundJobs', 'pendingQuestions', 'pendingInbox', 'settling', 'activeSubagents'].every(key => proof[key] === 0);
}
