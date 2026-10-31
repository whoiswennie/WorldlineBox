import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionAgendaRuleDraftSchema } from '../shared/companion-agenda';

export type CompanionAgendaNativeLane = 'decision' | 'dream' | 'social' | 'notification';
export type CompanionAgendaNativeClaim = { companionId?: string; id?: string; agendaRunId?: string; agendaLeaseToken?: string };
type Binding = { companionId: string; runId: string; leaseToken: string; nativeLeaseToken: string; lane: CompanionAgendaNativeLane; nativeId: string };
const key = (lane: CompanionAgendaNativeLane, id: string) => `agenda-native-parent/${lane}/${id}`;
const ruleMetadata = new Set(['id', 'companionId', 'revision', 'origin', 'status', 'createdAt', 'updatedAt', 'sourceMessageId', 'nextAt', 'category', 'classification', 'taskResponse', 'presentation']);
const semanticRule = (value: string) => companionAgendaRuleDraftSchema.parse(Object.fromEntries(Object.entries(JSON.parse(value) as Record<string, unknown>).filter(([name]) => !ruleMetadata.has(name))));

/** Internal worker authority. Every publication rechecks the exact sealed
 * occurrence and token, so pause/resume of the same run cannot revive a child. */
export function assertCompanionAgendaNativeClaim(db: CompanionConnection, input: CompanionAgendaNativeClaim, lane: CompanionAgendaNativeLane): void {
  if (!input.agendaRunId && !input.agendaLeaseToken) return;
  if (!input.companionId || !input.agendaRunId || !input.agendaLeaseToken) throw new Error('日程子行为缺少完整的主体与执行凭据。');
  const parent = db.prepare(`SELECT r.companion_id,r.status,json_extract(r.data,'$.leaseToken') AS token,r.lease_until,
    o.rule_data,s.data AS current_rule_data,s.status AS rule_status,s.revision AS rule_revision FROM companion_agenda_runs r
    JOIN companion_agenda_occurrences o ON o.id=r.occurrence_id JOIN companion_agenda_rules s ON s.id=r.rule_id WHERE r.id=?`)
    .get(input.agendaRunId) as { companion_id: string; status: string; token?: string; lease_until?: string; rule_data: string; current_rule_data: string; rule_status: string; rule_revision: number } | undefined;
  if (!parent || parent.companion_id !== input.companionId || parent.status !== 'running' || parent.token !== input.agendaLeaseToken
    || !parent.lease_until || parent.lease_until <= new Date().toISOString() || parent.rule_status !== 'active') throw new Error('日程执行已经停止或租约失效，旧子行为不能继续。');
  const rule = JSON.parse(parent.rule_data) as { companionId: string; revision: number; executor: string; referenceId?: string; referenceVersion?: string; goalId?: string; grantId?: string };
  if (rule.companionId !== input.companionId || rule.revision !== parent.rule_revision && JSON.stringify(semanticRule(parent.rule_data)) !== JSON.stringify(semanticRule(parent.current_rule_data))
    || !(lane === 'dream' ? ['world', 'memory', 'reflection'] : ['world']).includes(rule.executor)
    || rule.referenceVersion === 'world-native-v1' && rule.referenceId !== input.id) throw new Error('日程不属于当前世界行为或准确事件。');
  if (db.prepare('SELECT 1 FROM metadata WHERE key=?').get('recovery-review-required/' + input.companionId)) throw new Error('恢复后的伙伴资料仍在等待复核。');
  const owner = db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(input.companionId) as { data: string } | undefined;
  if (!owner || (JSON.parse(owner.data) as { active?: boolean }).active === false) throw new Error('伙伴已经暂停或退役。');
  if (rule.goalId && !db.prepare("SELECT 1 FROM companion_agenda_goals WHERE id=? AND companion_id=? AND status='active'").get(rule.goalId, input.companionId)) throw new Error('本次行为的长期方向已暂停或结束。');
  if (rule.grantId) {
    const grant = db.prepare("SELECT data FROM companion_agenda_grants WHERE id=? AND companion_id=? AND status='active'").get(rule.grantId, input.companionId) as { data: string } | undefined;
    const expiry = grant ? (JSON.parse(grant.data) as { expiresAt?: string }).expiresAt : undefined;
    if (!grant || expiry && Date.parse(expiry) <= Date.now()) throw new Error('本次行为的授权已经撤销或到期。');
  }
}
export function companionAgendaNativeBound(db: CompanionConnection, lane: CompanionAgendaNativeLane, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM metadata WHERE key=?').get(key(lane, id));
}
export function companionAgendaNativeParentId(db: CompanionConnection, lane: CompanionAgendaNativeLane, id: string, owner: string): string | undefined {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key(lane, id)) as { value: string } | undefined;
  if (!row) return; const binding = JSON.parse(row.value) as Binding;
  return binding.companionId === owner && binding.nativeId === id && binding.lane === lane ? binding.runId : undefined;
}
export function bindCompanionAgendaNative(db: CompanionConnection, input: CompanionAgendaNativeClaim, lane: CompanionAgendaNativeLane, id: string, nativeLeaseToken: string): void {
  if (!input.agendaRunId || !input.agendaLeaseToken || !input.companionId) return;
  assertCompanionAgendaNativeClaim(db, { ...input, id }, lane);
  const binding: Binding = { companionId: input.companionId, runId: input.agendaRunId, leaseToken: input.agendaLeaseToken, nativeLeaseToken, lane, nativeId: id };
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(lane, id), JSON.stringify(binding));
}
export function assertCompanionAgendaNativeParent(db: CompanionConnection, lane: CompanionAgendaNativeLane, id: string, companionId: string, nativeLeaseToken: string): void {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(key(lane, id)) as { value: string } | undefined;
  if (!row) return;
  const parent = JSON.parse(row.value) as Binding;
  if (parent.companionId !== companionId || parent.nativeId !== id || parent.lane !== lane || parent.nativeLeaseToken !== nativeLeaseToken) throw new Error('子行为执行凭据已变化，迟到结果不能提交。');
  assertCompanionAgendaNativeClaim(db, { companionId, id, agendaRunId: parent.runId, agendaLeaseToken: parent.leaseToken }, lane);
}

type NativeState = { id: string; companionId: string; status: string; leaseToken?: string; terminal?: boolean; error?: string;
  agendaInputVersion?: string; agendaRevision?: number; agendaCycleFailureCount?: number; agendaUncertain?: boolean };
/** Exact-version explicit controls retain raw events and cumulative failures.
 * The surrounding worker IMMEDIATE transaction owns read/CAS/write/receipt. */
export function controlCompanionAgendaNative<T extends NativeState>(db: CompanionConnection, lane: 'social' | 'notification',
  input: { companionId: string; id: string; inputVersion: string; expectedRevision: number; operationId: string; action: 'park' | 'resume' | 'abandon' },
  current: T, write: (state: T) => void): T {
  const fingerprint = createHash('sha256').update(JSON.stringify([lane, input.companionId, input.id, input.inputVersion, input.expectedRevision, input.action])).digest('hex');
  const receiptKey = 'agenda-native-control/' + input.operationId;
  const receipt = db.prepare('SELECT value FROM metadata WHERE key=?').get(receiptKey) as { value: string } | undefined;
  if (receipt) { const old = JSON.parse(receipt.value) as { fingerprint: string; state: T }; if (old.fingerprint !== fingerprint) throw new Error('处置操作标识已用于另一项行为。'); return old.state; }
  if (current.companionId !== input.companionId || current.id !== input.id || current.agendaInputVersion !== input.inputVersion || current.agendaRevision !== input.expectedRevision)
    throw new Error('行为的准确输入或处理状态已经变化，请重新读取。');
  if (['done', 'cancelled', 'abandoned'].includes(current.status)) throw new Error('该行为已经终结，不能恢复旧事件。');
  if (input.action === 'resume' && current.status !== 'parked') throw new Error('只有已搁置的准确行为可以明确恢复。');
  current.status = input.action === 'resume' ? 'pending' : input.action === 'park' ? 'parked' : 'abandoned';
  delete current.leaseToken; delete current.terminal;
  if (input.action === 'resume') { current.agendaCycleFailureCount = 0; delete current.error; delete current.agendaUncertain; }
  write(current);
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(receiptKey, JSON.stringify({ fingerprint, state: current }));
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(`agenda-native-audit/${input.companionId}/${lane}/${input.id}/${input.operationId}`,
    JSON.stringify({ companionId: input.companionId, lane, id: input.id, action: input.action, inputVersion: input.inputVersion, revision: current.agendaRevision, at: new Date().toISOString() }));
  return current;
}
