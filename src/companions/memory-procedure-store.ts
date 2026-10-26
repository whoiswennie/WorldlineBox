import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CompanionConnection } from './store';
import type { CompanionMemory, CompanionMessage, CompanionAction } from '../shared/companions';
import type { CompanionTaskCheckpoint } from '../shared/companion-storage';
import { companionExecutionReadsetSchema } from '../shared/companion-execution-evidence';
import { companionMemoryProcedureProposalSchema, type CompanionMemoryProcedureProposal, type CompanionMemoryProcedureValidation } from '../shared/companion-procedure';

type Scope = { companionId: string; conversationId: string };
type Ports = {
  /** Exact captured content revision may survive later annotation versions. */
  load(owner: string, id: string, version: number): CompanionMemory | undefined;
  visibleSources(scope: Scope, ids: string[]): CompanionMessage[];
};
type Observation = { noteId: string; contentRevision: number; validation: CompanionMemoryProcedureValidation };
type Receipt = CompanionMemoryProcedureValidation['evidence'][number] & { companionId: string; noteId: string; actionAttempt: number;
  taskId: string; proposalHash: string; actionHash: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
const actionHash = (action: CompanionAction) => hash([action.id, action.companionId, action.conversationId, action.sourceMessageId,
  action.attempt ?? 1, action.taskId, action.status, action.finishedAt, action.executionSummary]);
const proposal = (note: CompanionMemory): CompanionMemoryProcedureProposal | undefined => {
  if (!note.procedure) return;
  const parsed = companionMemoryProcedureProposalSchema.safeParse({ applicability: note.procedure.applicability, steps: note.procedure.steps,
    limitations: note.procedure.limitations, verification: note.procedure.verification });
  return parsed.success ? parsed.data : undefined;
};

/** Outcome receipts are annotation evidence, not another notebook or a grant.
 * Reads recheck current source visibility, so withdrawing a trial removes its
 * validation without deleting a still-lawful original method. */
export class CompanionMemoryProcedureStore {
  constructor(private readonly db: CompanionConnection, private readonly ports: Ports) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_procedure_outcomes(
      companion_id TEXT NOT NULL,note_id TEXT NOT NULL,content_revision INTEGER NOT NULL,action_id TEXT NOT NULL,
      action_attempt INTEGER NOT NULL,source_message_id TEXT NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(companion_id,note_id,content_revision,action_id,action_attempt));
      CREATE INDEX IF NOT EXISTS companion_memory_procedure_note ON companion_memory_procedure_outcomes(companion_id,note_id,content_revision);`);
  }
  private action(id: string): CompanionAction | undefined {
    const found = this.db.prepare('SELECT data FROM actions WHERE id=?').get(id) as { data: string } | undefined;
    return found ? JSON.parse(found.data) as CompanionAction : undefined;
  }
  private currentReceipt(receipt: Receipt, scope: Scope): boolean {
    if (scope.companionId !== receipt.companionId) return false;
    const entrance = this.db.prepare('SELECT kind,private_companion_id FROM conversations WHERE id=?').get(scope.conversationId) as { kind: string; private_companion_id?: string } | undefined;
    const privateEntrance = scope.conversationId === 'world_' + scope.companionId
      || entrance?.kind === 'private' && entrance.private_companion_id === scope.companionId;
    // Owner recollection spans witnessed entrances, but a published trial
    // receipt must not reveal a private action ID through a shared room.
    if (!privateEntrance && receipt.conversationId !== scope.conversationId) return false;
    const action = this.action(receipt.actionId);
    if (!action || actionHash(action) !== receipt.actionHash || action.taskId !== receipt.taskId || action.stop) return false;
    try {
      return this.ports.visibleSources(scope, [receipt.sourceMessageId]).some(source => source.id === receipt.sourceMessageId
        && source.conversationId === receipt.conversationId && source.actionId === receipt.actionId
        && source.kind === 'action' && source.authorId === scope.companionId && checksum(source.content) === receipt.checksum);
    } catch { return false; }
  }
  validation(note: CompanionMemory, scope: Scope): CompanionMemoryProcedureValidation {
    const method = proposal(note), empty: CompanionMemoryProcedureValidation = { state: 'unverified', successes: 0, failures: 0, evidence: [] };
    if (!method || note.companionId !== scope.companionId || !note.contentRevision) return empty;
    const rows = this.db.prepare(`SELECT data FROM companion_memory_procedure_outcomes
      WHERE companion_id=? AND note_id=? AND content_revision=? ORDER BY rowid DESC LIMIT 20`)
      .all(note.companionId, note.id, note.contentRevision) as Array<{ data: string }>;
    const receipts = rows.map(row => JSON.parse(row.data) as Receipt)
      .filter(receipt => receipt.proposalHash === hash(method) && this.currentReceipt(receipt, scope));
    const successes = receipts.filter(receipt => receipt.outcome === 'passed').length, failures = receipts.filter(receipt => receipt.outcome === 'failed').length;
    return { state: failures ? 'disabled' : successes ? 'validated' : 'unverified', successes, failures,
      evidence: receipts.map(({ actionId, sourceMessageId, conversationId, checksum, contentRevision, outcome, recordedAt }) =>
        ({ actionId, sourceMessageId, conversationId, checksum, contentRevision, outcome, recordedAt })) };
  }
  /** A revocation refreshes only methods that actually used that result. The
   * caller publishes these annotations through the normal ledger/outbox. */
  refresh(owner: string, sourceIds: readonly string[] = []): Observation[] {
    if (!sourceIds.length) return [];
    const rows = this.db.prepare(`SELECT DISTINCT note.id,note.data FROM companion_memory_procedure_outcomes trial
      JOIN vcp_memory_notes note ON note.id=trial.note_id AND note.companion_id=trial.companion_id
      WHERE trial.companion_id=? AND trial.source_message_id IN(SELECT value FROM json_each(?))`)
      .all(owner, JSON.stringify([...new Set(sourceIds)])) as Array<{ id: string; data: string }>;
    return rows.flatMap(row => {
      const saved = JSON.parse(row.data) as CompanionMemory, note = this.ports.load(owner, row.id, saved.version);
      return note?.procedure && note.contentRevision ? [{ noteId: note.id, contentRevision: note.contentRevision,
        validation: this.validation(note, { companionId: owner, conversationId: 'world_' + owner }) }] : [];
    });
  }
  observeAction(actionId: string): Observation[] {
    const action = this.action(actionId);
    if (!action || action.stop || !['succeeded', 'failed'].includes(action.status) || !action.taskId || action.thought) return [];
    const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('task-checkpoint/' + actionId) as { value: string } | undefined;
    const checkpoint = saved ? JSON.parse(saved.value) as CompanionTaskCheckpoint : undefined;
    const parsed = companionExecutionReadsetSchema.safeParse(checkpoint?.executionReadset);
    const summary = action.executionSummary, execution = checkpoint?.execution;
    if (!parsed.success || !parsed.data.complete || parsed.data.companionId !== action.companionId
      || parsed.data.conversationId !== action.conversationId || !summary?.complete || summary.storageLimited
      || summary.recordId !== action.taskId || !execution || execution.id !== action.taskId || execution.status !== action.status
      || summary.status !== action.status || !execution.finishedAt || !summary.toolCalls) return [];
    const scope = { companionId: action.companionId, conversationId: action.conversationId };
    const sources = this.db.prepare("SELECT id FROM messages WHERE action_id=? AND kind='action' AND author_id=? ORDER BY sequence DESC LIMIT 10")
      .all(actionId, action.companionId) as Array<{ id: string }>;
    const outcomeSource = this.ports.visibleSources(scope, sources.map(source => source.id)).find(source => {
      try { const value = JSON.parse(source.content) as { actionId?: string; status?: string; recordId?: string; verification?: unknown };
        return source.conversationId === action.conversationId && value.actionId === actionId && value.status === action.status
          && value.recordId === action.taskId && hash(value.verification) === hash(summary.verification);
      } catch { return false; }
    });
    if (!outcomeSource) return [];
    const results: Observation[] = [];
    for (const reference of parsed.data.memories.slice(0, 100)) {
      const note = this.ports.load(action.companionId, reference.id, reference.version), method = note && proposal(note);
      if (!note || !method || !note.contentRevision || !['queued', 'indexed'].includes(note.status) || note.archivedAt
        || Date.parse(note.createdAt) > Date.parse(action.createdAt)) continue;
      const required = method.verification.artifactRequirements, actual = checkpoint?.dshTask?.delivery?.artifacts ?? [];
      // Merely reading a method, an exit code, or an LLM's "I succeeded" is not
      // practice evidence. The trial must bind its exact objective contract.
      if (!required.every(rule => actual.some(ruleInTask => hash(ruleInTask) === hash(rule)))) continue;
      const verification = summary.verification;
      const success = action.status === 'succeeded' && execution.code === 0 && verification?.status === 'passed'
        && verification.artifactChecks >= required.length && verification.unverifiedRequirements.length === 0
        && required.every(rule => summary.artifacts?.some(artifact => path.resolve(artifact.path) === path.resolve(execution.taskWorkspaceRoot ?? execution.workspacePath ?? '', rule.path)
          && typeof artifact.bytes === 'number' && /^[a-f0-9]{64}$/u.test(artifact.sha256 ?? '')
          && (rule.minBytes === undefined || artifact.bytes >= rule.minBytes) && (rule.maxBytes === undefined || artifact.bytes <= rule.maxBytes)
          && (!rule.sha256 || artifact.sha256 === rule.sha256)));
      if (action.status === 'succeeded' && !success) continue;
      if (success && this.validation(note, scope).state === 'disabled') continue;
      const receipt: Receipt = { companionId: action.companionId, noteId: note.id, contentRevision: note.contentRevision,
        actionId, actionAttempt: action.attempt ?? 1, taskId: action.taskId, actionHash: actionHash(action), proposalHash: hash(method),
        sourceMessageId: outcomeSource.id, conversationId: outcomeSource.conversationId, checksum: checksum(outcomeSource.content),
        outcome: success ? 'passed' : 'failed', recordedAt: new Date().toISOString() };
      this.db.prepare('INSERT OR IGNORE INTO companion_memory_procedure_outcomes(companion_id,note_id,content_revision,action_id,action_attempt,source_message_id,data) VALUES(?,?,?,?,?,?,?)')
        .run(receipt.companionId, receipt.noteId, receipt.contentRevision, receipt.actionId, receipt.actionAttempt, receipt.sourceMessageId, JSON.stringify(receipt));
      results.push({ noteId: note.id, contentRevision: note.contentRevision, validation: this.validation(note, scope) });
    }
    return results;
  }
}
