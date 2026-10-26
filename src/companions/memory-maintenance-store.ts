import { randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMemory } from '../shared/companions';
import { initialCompanionMemoryPolicy, type CompanionMemoryPolicy } from '../shared/companion-memory-policy';
import type { CompanionMemoryPolicyReceipt } from './memory-policy-files';

export type MaintenanceMode = 'sleep' | 'background';
export type MaintenanceSession = { id: string; companionId: string; mode: MaintenanceMode; startedAt: number;
  roll: number; dreamAllowed: boolean; dreamJobId?: string; narrativeAttempts: number; narrativeStatus: 'pending' | 'skipped' | 'completed' | 'failed';
  policy: CompanionMemoryPolicy; policyRevision: string; closedAt?: number };
type OwnerState = { companionId: string; lastDecisionAt?: number; lastDreamSuccessAt?: number; activeSessionId?: string; lastServiceAt?: number };

/** Cognitive maintenance state belongs to an owner, never to physical work or a
 * nightly timer. Sources, checkpoints and dream admission survive process exit.
 * This store has no model, file output or authority to manufacture experience. */
export class CompanionMemoryMaintenanceStore {
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_maintenance_owners(companion_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_memory_maintenance_sessions(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_memory_maintenance_owner_sessions ON companion_memory_maintenance_sessions(companion_id);
      CREATE TABLE IF NOT EXISTS companion_memory_maintenance_sources(companion_id TEXT NOT NULL,source_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL,source_checksum TEXT NOT NULL,outcome TEXT NOT NULL,processed_at INTEGER NOT NULL,
        PRIMARY KEY(companion_id,source_id,source_revision,source_checksum));`);
  }
  owner(companionId: string): OwnerState {
    const found = this.db.prepare('SELECT data FROM companion_memory_maintenance_owners WHERE companion_id=?').get(companionId) as { data: string } | undefined;
    return found ? JSON.parse(found.data) as OwnerState : { companionId };
  }
  private saveOwner(value: OwnerState): void {
    this.db.prepare('INSERT INTO companion_memory_maintenance_owners(companion_id,data) VALUES(?,?) ON CONFLICT(companion_id) DO UPDATE SET data=excluded.data')
      .run(value.companionId, JSON.stringify(value));
  }
  session(id?: string): MaintenanceSession | undefined {
    if (!id) return undefined;
    const found = this.db.prepare('SELECT data FROM companion_memory_maintenance_sessions WHERE id=?').get(id) as { data: string } | undefined;
    return found ? JSON.parse(found.data) as MaintenanceSession : undefined;
  }
  private saveSession(value: MaintenanceSession): void {
    this.db.prepare('INSERT INTO companion_memory_maintenance_sessions(id,companion_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(value.id, value.companionId, JSON.stringify(value));
  }
  /** A tag/title-only revision or another paraphrase with the same provenance
   * cannot create debt. An actual changed source revision remains distinct. */
  static unseenSourceSql(alias: string): string {
    return `EXISTS(SELECT 1 FROM json_each(${alias}.data,'$.sources') source WHERE NOT EXISTS(
      SELECT 1 FROM companion_memory_maintenance_sources covered WHERE covered.companion_id=${alias}.companion_id
      AND covered.source_id=json_extract(source.value,'$.messageId')
      AND covered.source_revision=json_extract(source.value,'$.revision') AND covered.source_checksum=json_extract(source.value,'$.checksum')))`;
  }
  /** A model may write several notes for one event. Count actual capture
   * episodes or independent source receipts, never the number of prose rows. */
  episodeKeys(companionId: string, notes: readonly CompanionMemory[]): string[] {
    const keys = new Set<string>();
    for (const note of notes) for (const source of note.sources) {
      if (this.db.prepare(`SELECT 1 FROM companion_memory_maintenance_sources WHERE companion_id=? AND source_id=? AND source_revision=? AND source_checksum=?`)
        .get(companionId, source.messageId, source.revision, source.checksum)) continue;
      const episode = this.db.prepare(`SELECT s.episode_id FROM companion_memory_episode_sources s JOIN vcp_capture_jobs j ON j.id=s.job_id
        WHERE j.companion_id=? AND j.message_id=? ORDER BY j.ordinal DESC LIMIT 1`).get(companionId, source.messageId) as { episode_id: string } | undefined;
      const captured = episode?.episode_id ?? (typeof note.metadata?.captureEpisodeId === 'string' ? note.metadata.captureEpisodeId : undefined);
      const action = captured ? undefined : this.db.prepare('SELECT action_id FROM messages WHERE id=? AND conversation_id=?').get(source.messageId, source.conversationId) as { action_id?: string } | undefined;
      keys.add(captured ? 'capture:' + captured : action?.action_id ? 'action:' + action.action_id
        : JSON.stringify(['receipt', source.conversationId, source.messageId, source.revision, source.checksum]));
    }
    return [...keys];
  }
  eligible(companionId: string, notes: readonly CompanionMemory[], now: number, mode: MaintenanceMode, policy = initialCompanionMemoryPolicy()): boolean {
    if (!notes.length) return false;
    const owner = this.owner(companionId), active = this.session(owner.activeSessionId);
    if (active && active.closedAt === undefined) return true;
    if (owner.lastDecisionAt !== undefined && now - owner.lastDecisionAt < policy.deep.intervalMs) return false;
    const oldest = Math.min(...notes.map(note => Date.parse(note.createdAt)).filter(Number.isFinite));
    return mode === 'sleep' || this.episodeKeys(companionId, notes).length >= policy.deep.minEpisodes
      || notes.some(note => note.tags.some(tag => ['重要', '重要约定', '更正', '冲突'].includes(tag)))
      || Number.isFinite(oldest) && now - oldest >= policy.deep.maxDebtAgeMs;
  }
  begin(companionId: string, mode: MaintenanceMode, now: number, receipt: Pick<CompanionMemoryPolicyReceipt, 'policy' | 'revision'> = { policy: initialCompanionMemoryPolicy(), revision: 'noncanonical-fixture' }): MaintenanceSession {
    const owner = this.owner(companionId), existing = this.session(owner.activeSessionId);
    if (existing && existing.closedAt === undefined) return existing;
    const roll = Math.random(), policy = structuredClone(receipt.policy);
    const allowed = (owner.lastDreamSuccessAt === undefined || now - owner.lastDreamSuccessAt >= policy.dream.cooldownMs)
      && roll < policy.dream.probability;
    const session: MaintenanceSession = { id: randomUUID(), companionId, mode, startedAt: now, roll, dreamAllowed: allowed,
      policy, policyRevision: receipt.revision, narrativeAttempts: 0, narrativeStatus: allowed ? 'pending' : 'skipped' };
    owner.activeSessionId = session.id; this.saveOwner(owner); this.saveSession(session); return session;
  }
  bindDream(sessionId: string, jobId: string): boolean {
    const session = this.session(sessionId);
    if (!session || !session.dreamAllowed || session.narrativeStatus !== 'pending') return false;
    if (session.dreamJobId && session.dreamJobId !== jobId) return false;
    session.dreamJobId = jobId; this.saveSession(session); return true;
  }
  static sourceKeys(notes: readonly CompanionMemory[]): string[] {
    return [...new Set(notes.flatMap(note => note.sources.map(source => JSON.stringify([source.messageId, source.revision, source.checksum]))))];
  }
  recordSources(companionId: string, notes: readonly CompanionMemory[], now: number, outcome: 'processed' | 'stopped' | 'failed' = 'processed'): void {
    this.recordSourceKeys(companionId, CompanionMemoryMaintenanceStore.sourceKeys(notes), now, outcome);
  }
  recordSourceKeys(companionId: string, keys: readonly string[], now: number, outcome: 'processed' | 'stopped' | 'failed'): void {
    const write = this.db.prepare('INSERT OR IGNORE INTO companion_memory_maintenance_sources(companion_id,source_id,source_revision,source_checksum,outcome,processed_at) VALUES(?,?,?,?,?,?)');
    for (const key of keys) {
      const [id, revision, checksum] = JSON.parse(key) as [string, number, string];
      write.run(companionId, id, revision, checksum, outcome, now);
    }
    const owner = this.owner(companionId); owner.lastServiceAt = now; this.saveOwner(owner);
  }
  finishDecision(companionId: string, sessionId: string | undefined, hasMore: boolean, now: number): void {
    const owner = this.owner(companionId); owner.lastServiceAt = now;
    if (!hasMore) {
      owner.lastDecisionAt = now; delete owner.activeSessionId;
      const session = this.session(sessionId);
      if (session) { session.closedAt = now; this.saveSession(session); }
    }
    this.saveOwner(owner);
  }
  narrativeAttempt(sessionId: string, jobId: string): number {
    const session = this.session(sessionId);
    if (!session || session.dreamJobId !== jobId || session.narrativeStatus !== 'pending'
      || session.narrativeAttempts >= session.policy.dream.maxAttempts) throw new Error('联想叙述阶段已结束或重试预算已用尽。');
    session.narrativeAttempts++; this.saveSession(session); return session.narrativeAttempts;
  }
  refundNarrativeAttempt(sessionId: string, jobId: string, attempt: number): number {
    const session = this.session(sessionId);
    if (!session || session.dreamJobId !== jobId || session.narrativeStatus !== 'pending'
      || session.narrativeAttempts !== attempt || attempt < 1) throw new Error('联想准入延期不属于当前尚未完成的尝试。');
    session.narrativeAttempts--; this.saveSession(session); return session.narrativeAttempts;
  }
  finishNarrative(sessionId: string, jobId: string, success: boolean, now: number): void {
    const session = this.session(sessionId);
    if (!session || session.dreamJobId !== jobId) throw new Error('联想叙述不属于当前维护会话。');
    session.narrativeStatus = success ? 'completed' : session.narrativeAttempts >= session.policy.dream.maxAttempts ? 'failed' : 'pending';
    if (success) { const owner = this.owner(session.companionId); owner.lastDreamSuccessAt = now; this.saveOwner(owner); }
    this.saveSession(session);
  }
  skipNarrative(sessionId: string, jobId: string): void {
    const session = this.session(sessionId);
    if (!session || session.dreamJobId !== jobId) return;
    session.narrativeStatus = 'skipped'; this.saveSession(session);
  }
}
