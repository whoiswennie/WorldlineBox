import {
  companionStateProposalSchema, companionAppraisalSchema, type CompanionRuntimeState, type CompanionStateProposal,
} from '../shared/companion-state';
import type { CompanionMessage, CompanionAction } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionConnection } from './store';
import { createHash } from 'node:crypto';
import { applyCompanionAppraisal, decayCompanionAffect, deriveCompanionMood, COMPANION_RELATIONSHIP_DAILY_POSITIVE_LIMIT, COMPANION_APPRAISAL_CONFIDENCE_THRESHOLD } from '../shared/companion-affect';
import type { CompanionRoutineRuntime } from '../shared/companion-routine';
import type { CompanionWorldEvent } from '../shared/companion-world';
import { companionTimeInZone } from '../shared/companion-schedule-time';
import { CompanionStateChangeStore } from './state-change-store';
import type { CompanionAppraisal } from '../shared/companion-state';

type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const rows = (values: unknown[]) => values.map(row);
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const isoDate = (at: number) => new Date(at).toISOString();
type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
export type CompanionMemoryStateIntegration = { eventKey: string; kind: 'capture' | 'sleep' | 'learning'; reason: string;
  expression?: CompanionRuntimeState['expression']; focus?: string | null; appraisals: CompanionAppraisal[]; sourceMessageIds: string[];
  memoryVersions: Array<{ id: string; version: number }>; expectedRevision?: number };
function stage(interactionCount: number, sharedEventCount: number): CompanionRuntimeState['familiarity']['stage'] {
  return interactionCount >= 30 || sharedEventCount >= 8 ? 'close' : interactionCount >= 6 || sharedEventCount >= 2 ? 'acquainted' : 'new';
}

/** Virtual energy and relationship counters describe persisted, actual activity. */
export class CompanionStateStore {
  private readonly changes: CompanionStateChangeStore;
  constructor(private readonly db: CompanionConnection,
    private readonly visibleSources: (scope: Scope, ids: string[]) => CompanionMessage[],
    private readonly advanceEnergy: (id: string, from: number, to: number, energy: number, busy: boolean) => number,
    private readonly routine: (scope: Scope, now: number) => CompanionRoutineRuntime,
    private readonly currentTime: (at: number) => number,
    private readonly clock: { virtualAt(realAt: number): number; elapsedVirtual(from: number, to: number): number; timeZone(): string }) {
    this.changes = new CompanionStateChangeStore(db, visibleSources);
  }

  private worldDay(at: number): string {
    const local = companionTimeInZone(at, this.clock.timeZone());
    return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_runtime_states (companion_id TEXT PRIMARY KEY REFERENCES companions(id), data TEXT NOT NULL, energy_clock INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_state_interactions (companion_id TEXT NOT NULL REFERENCES companions(id), message_id TEXT NOT NULL REFERENCES messages(id), conversation_id TEXT NOT NULL, PRIMARY KEY(companion_id,message_id));
      CREATE TABLE IF NOT EXISTS companion_state_actions (action_id TEXT NOT NULL REFERENCES actions(id), status TEXT NOT NULL, PRIMARY KEY(action_id,status));
      CREATE TABLE IF NOT EXISTS companion_state_events (companion_id TEXT NOT NULL REFERENCES companions(id), event_key TEXT NOT NULL, conversation_id TEXT NOT NULL, PRIMARY KEY(companion_id,event_key));
      CREATE TABLE IF NOT EXISTS companion_state_event_sources(companion_id TEXT NOT NULL,event_key TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),
        PRIMARY KEY(companion_id,event_key,message_id),FOREIGN KEY(companion_id,event_key) REFERENCES companion_state_events(companion_id,event_key) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS companion_state_event_source ON companion_state_event_sources(message_id,companion_id);
      CREATE TABLE IF NOT EXISTS companion_state_appraisals (id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, source_date TEXT NOT NULL, positive_change REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_appraisal_budget ON companion_state_appraisals(companion_id,source_date,active);
      CREATE TABLE IF NOT EXISTS companion_appraisal_sources (companion_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),appraisal_id TEXT NOT NULL REFERENCES companion_state_appraisals(id),PRIMARY KEY(companion_id,message_id));
    `);
    this.changes.initialize();
    this.db.transaction(() => {
      const key = 'vcp-memory-replacement/retired-fact-events';
      if (!this.db.prepare("SELECT 1 FROM metadata WHERE key=? AND value='pending'").get(key)) return;
      // Old inferred facts cannot substantiate a host experience receipt.
      this.db.prepare("DELETE FROM companion_state_events WHERE event_key NOT GLOB 'world:*' AND event_key NOT GLOB 'experience:*'").run();
      for (const entry of rows(this.db.prepare('SELECT companion_id,data FROM companion_runtime_states').all())) {
        const state = decode<CompanionRuntimeState>(entry.data);
        state.familiarity.sharedEventCount = Number(row(this.db.prepare("SELECT count(*) AS n FROM companion_state_events WHERE companion_id=? AND event_key GLOB 'experience:*'").get(entry.companion_id)).n);
        state.familiarity.stage = stage(state.familiarity.interactionCount, state.familiarity.sharedEventCount);
        this.db.prepare('UPDATE companion_runtime_states SET data=? WHERE companion_id=?').run(JSON.stringify(state), entry.companion_id);
      }
      this.db.prepare("UPDATE metadata SET value='done' WHERE key=?").run(key);
    }).immediate();
  }

  private requireCompanion(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('伙伴不存在或已移除。');
  }
  private requireScope(scope: Scope): Row {
    this.requireCompanion(scope.companionId);
    const conversation = this.db.prepare('SELECT * FROM conversations WHERE id=? AND dissolved_at IS NULL').get(scope.conversationId);
    if (!conversation || !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(scope.conversationId, scope.companionId)) throw new Error('状态不属于当前聊天范围。');
    return row(conversation);
  }
  private load(id: string): CompanionRuntimeState {
    this.requireCompanion(id);
    const found = this.db.prepare('SELECT data FROM companion_runtime_states WHERE companion_id=?').get(id);
    if (found) return decode<CompanionRuntimeState>(row(found).data);
    const state: CompanionRuntimeState = { companionId: id, energy: 100, mood: 'calm', expression: 'gentle', affect: { pleasure: 0, arousal: 0, dominance: 0 }, relationship: { affinity: 50, trust: 50, respect: 50 }, familiarity: { stage: 'new', interactionCount: 0, sharedEventCount: 0 }, updatedAt: new Date().toISOString(), revision: 1 };
    this.db.prepare('INSERT INTO companion_runtime_states(companion_id,data,energy_clock) VALUES(?,?,?)').run(id, JSON.stringify(state), Date.now());
    return state;
  }
  private save(state: CompanionRuntimeState, at = Date.now()): void {
    at = this.currentTime(at);
    state.energy = Math.max(0, Math.min(100, state.energy));
    state.updatedAt = new Date(at).toISOString(); state.revision++;
    this.db.prepare('UPDATE companion_runtime_states SET data=?,energy_clock=? WHERE companion_id=?').run(JSON.stringify(state), at, state.companionId);
  }
  private busy(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM actions WHERE companion_id=? AND status='running' UNION ALL SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status='running' LIMIT 1").get(id, id);
  }
  energy(id: string, now = Date.now()): number {
    now = this.currentTime(now);
    return this.db.transaction(() => {
      const state = this.load(id), found = row(this.db.prepare('SELECT energy_clock FROM companion_runtime_states WHERE companion_id=?').get(id));
      const elapsedAffect = this.clock.elapsedVirtual(Date.parse(state.updatedAt), now);
      const previous = Number(found.energy_clock);
      const active = !!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND COALESCE(json_extract(data,'$.active'),1)=1").get(id);
      if (now > previous && active) {
        if (elapsedAffect) state.affect = decayCompanionAffect(state.affect, elapsedAffect);
        state.energy = this.advanceEnergy(id, previous, now, state.energy, this.busy(id));
        state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(id));
        state.updatedAt = isoDate(now);
        // Advancing the simulation clock is not a concurrent authored change.
        this.db.prepare('UPDATE companion_runtime_states SET data=?,energy_clock=? WHERE companion_id=?').run(JSON.stringify(state), now, id);
      }
      return state.energy;
    }).immediate();
  }
  get(scope: Scope): CompanionRuntimeState {
    const conversation = this.requireScope(scope);
    this.energy(scope.companionId);
    const state = this.load(scope.companionId);
    state.recentChanges = this.changes.recent(scope);
    state.routine = this.routine(scope, Date.parse(state.updatedAt));
    const sourceIds = state.sourceMessageIds ?? [];
    const visible = sourceIds.length ? this.visibleSources(scope, sourceIds) : [];
    const allowed = !sourceIds.length || visible.length === sourceIds.length;
    if (!allowed || (conversation.kind === 'group' && state.sourceConversationId && state.sourceConversationId !== scope.conversationId)) {
      state.reason = state.mood === 'focused' ? '正在专注处理安排。' : state.mood === 'tired' ? '近期活动后需要休息。' : '当前状态来自已有互动与经历。';
      state.focus = state.focus ? '处理已有安排' : undefined;
      state.sourceConversationId = undefined; state.sourceMessageIds = []; state.evidence = [];
    }
    // Restored delivery fields can have different evidence from the current
    // reason. Check the focus's own provenance before exposing it in a room.
    const delivery = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('state-delivery-origin/' + scope.companionId);
    const focusIds = delivery ? decode<{ focus?: { sourceMessageIds: string[] } }>(row(delivery).value).focus?.sourceMessageIds ?? [] : [];
    if (state.focus && focusIds.length) {
      const focusSources = this.visibleSources(scope, focusIds);
      if (focusSources.length !== focusIds.length || conversation.kind === 'group' && focusSources.some(source => source.conversationId !== scope.conversationId)) state.focus = '处理已有安排';
    } else if (state.focus && conversation.kind === 'group' && !state.sourceConversationId) state.focus = '处理已有安排';
    if (conversation.kind === 'group') {
      const interactionCount = Number(row(this.db.prepare('SELECT count(*) AS n FROM companion_state_interactions WHERE companion_id=? AND conversation_id=?').get(scope.companionId, scope.conversationId)).n);
      const sharedEventCount = Number(row(this.db.prepare("SELECT count(*) AS n FROM companion_state_events WHERE companion_id=? AND conversation_id=? AND event_key GLOB 'experience:*'").get(scope.companionId, scope.conversationId)).n);
      state.familiarity = { interactionCount, sharedEventCount, stage: stage(interactionCount, sharedEventCount) };
    }
    return state;
  }
  invalidateEvidence(companionId: string, sourceIds: string[]): void {
    if (!sourceIds.length) return;
    this.db.transaction(() => {
      this.energy(companionId);
      const state = this.load(companionId), seen = new Set<string>(), now = this.currentTime(Date.now());
      for (let index = 0; index < sourceIds.length; index += 200) {
        const batch = sourceIds.slice(index, index + 200);
        const events = rows(this.db.prepare(`SELECT DISTINCT event_key FROM companion_state_event_sources WHERE companion_id=? AND message_id IN (${batch.map(() => '?').join(',')})`).all(companionId, ...batch));
        for (const event of events) {
          this.db.prepare('DELETE FROM companion_state_events WHERE companion_id=? AND event_key=?').run(companionId, event.event_key);
          state.familiarity.sharedEventCount = Math.max(0, state.familiarity.sharedEventCount - 1);
        }
        for (const found of rows(this.db.prepare(`SELECT a.id,a.data FROM companion_state_appraisals a WHERE a.companion_id=? AND a.active=1 AND (a.id IN(SELECT appraisal_id FROM companion_appraisal_sources WHERE message_id IN (${batch.map(() => '?').join(',')})) OR a.id IN(SELECT change_id FROM companion_state_change_sources WHERE message_id IN (${batch.map(() => '?').join(',')})))`).all(companionId, ...batch, ...batch))) {
          if (seen.has(String(found.id))) continue; seen.add(String(found.id));
          const data = decode<{ appliedAt: string; affectDelta: CompanionRuntimeState['affect']; relationshipDelta: CompanionRuntimeState['relationship'] }>(found.data);
          const remaining = decayCompanionAffect({ pleasure: data.affectDelta.pleasure / 2, arousal: data.affectDelta.arousal / 2, dominance: data.affectDelta.dominance / 2 }, this.clock.elapsedVirtual(Date.parse(data.appliedAt), now));
          for (const dimension of ['pleasure', 'arousal', 'dominance'] as const) state.affect[dimension] = Math.max(-1, Math.min(1, state.affect[dimension] - 2 * remaining[dimension]));
          for (const dimension of ['affinity', 'trust', 'respect'] as const) state.relationship[dimension] = Math.max(0, Math.min(100, state.relationship[dimension] - data.relationshipDelta[dimension]));
          this.db.prepare('UPDATE companion_state_appraisals SET active=0 WHERE id=?').run(found.id);
        }
      }
      this.changes.withdraw(companionId, sourceIds);
      if ((state.sourceMessageIds ?? []).some(id => sourceIds.includes(id))) { state.focus = undefined; state.reason = undefined; state.evidence = []; state.sourceMessageIds = []; state.sourceConversationId = undefined; }
      this.restoreDelivery(state, sourceIds);
      state.familiarity.stage = stage(state.familiarity.interactionCount, state.familiarity.sharedEventCount);
      state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(companionId)); this.save(state);
    }).immediate();
  }
  update(scope: Scope, input: CompanionStateProposal, expectedRevision?: number): CompanionRuntimeState {
    return this.db.transaction(() => {
      this.requireScope(scope);
      const proposal = companionStateProposalSchema.parse(input), sources = this.visibleSources(scope, proposal.sourceMessageIds);
      if (sources.length !== new Set(proposal.sourceMessageIds).size || sources.some(source => source.conversationId !== scope.conversationId)) throw new Error('状态提议需要当前聊天中实际可见的正式来源。');
      for (const id of proposal.sourceMessageIds) if (!proposal.evidence.some(evidence => evidence.sourceMessageId === id)) throw new Error('每条状态来源都需要原文证据。');
      for (const evidence of proposal.evidence) {
        if (!sources.find(source => source.id === evidence.sourceMessageId)?.content.includes(evidence.quote)) throw new Error('状态证据不是来源中的实际原文。');
      }
      this.energy(scope.companionId);
      const observedAt = this.currentTime(Date.now());
      if (sources.some(source => Date.parse(source.createdAt) > observedAt)) throw new Error('世界存档仍在补算，状态来源尚未到达已推进时刻，请稍后重试。');
      const state = this.load(scope.companionId);
      const before = structuredClone(state);
      if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new Error('伙伴状态已更新，请重新读取。');
      this.applyAppraisals(state, proposal, sources);
      const latestSource = Math.max(...sources.map(source => source.sequence));
      const previousSource = Math.max(0, ...(state.sourceMessageIds ?? []).map(id => Number(row(this.db.prepare('SELECT sequence FROM messages WHERE id=?').get(id)).sequence)));
      if (latestSource < previousSource) {
        this.save(state);
        this.changes.add(scope.companionId, { id: 'state-' + createHash('sha256').update(scope.companionId + ':' + state.revision).digest('hex'), kind: 'appraisal', appliedAt: state.updatedAt,
          occurredAt: sources[0]!.createdAt, reason: proposal.reason, sourceConversationId: scope.conversationId, sourceMessageIds: sources.map(source => source.id) }, before, state);
        return this.get(scope);
      }
      if (proposal.expression) state.expression = proposal.expression;
      if (proposal.focus !== undefined) state.focus = proposal.focus ?? undefined;
      this.rememberDelivery(state, proposal, sources.map(source => source.id));
      state.reason = proposal.reason; state.sourceConversationId = scope.conversationId;
      state.sourceMessageIds = [...new Set(proposal.sourceMessageIds)]; state.evidence = proposal.evidence;
      this.save(state);
      this.changes.add(scope.companionId, { id: 'state-' + createHash('sha256').update(scope.companionId + ':' + state.revision).digest('hex'), kind: 'appraisal',
        appliedAt: state.updatedAt, occurredAt: sources.reduce((last, source) => source.createdAt > last ? source.createdAt : last, sources[0]!.createdAt),
        reason: proposal.reason, sourceConversationId: scope.conversationId, sourceMessageIds: sources.map(source => source.id) }, before, state);
      return this.get(scope);
    }).immediate();
  }
  private rememberDelivery(state: CompanionRuntimeState, fields: { expression?: unknown; focus?: unknown }, sources: string[], changeId?: string): void {
    const key = 'state-delivery-origin/' + state.companionId;
    const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
    const origins = saved ? JSON.parse(saved.value) as Record<string, unknown> : { companionId: state.companionId };
    for (const field of ['expression', 'focus'] as const) if (fields[field] !== undefined) origins[field] = { sourceMessageIds: sources, changeId };
    this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify(origins));
  }
  private restoreDelivery(state: CompanionRuntimeState, sourceIds: string[], changeIds: string[] = []): void {
    const key = 'state-delivery-origin/' + state.companionId, saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
    if (!saved) return;
    const origins = JSON.parse(saved.value) as { expression?: { sourceMessageIds: string[]; changeId?: string }; focus?: { sourceMessageIds: string[]; changeId?: string } };
    for (const field of ['expression', 'focus'] as const) {
      const origin = origins[field];
      if (!origin || !origin.sourceMessageIds.some(id => sourceIds.includes(id)) && !(origin.changeId && changeIds.includes(origin.changeId))) continue;
      const restored = this.changes.delivery({ companionId: state.companionId, conversationId: 'world_' + state.companionId }, field);
      const value = restored?.[field]?.after;
      if (field === 'expression') state.expression = value as CompanionRuntimeState['expression'] || 'gentle';
      else state.focus = value;
      // A restored value still has evidence. Retain it so a later revocation
      // can restore the next valid state instead of stranding a stale value.
      if (restored) origins[field] = { sourceMessageIds: restored.sourceMessageIds, changeId: restored.id };
      else delete origins[field];
    }
    this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ ...origins, companionId: state.companionId }), key);
  }
  /** Revisions withdraw only a derived memory impulse, never the real user's original appraisal. */
  invalidateMemoryVersions(companionId: string, versions: Array<{ id: string; version: number }>): void {
    if (!versions.length) return;
    this.db.transaction(() => {
      this.energy(companionId); const state = this.load(companionId), now = this.currentTime(Date.now()), withdrawn: string[] = [];
      for (const version of versions) {
        const receipts = this.db.prepare(`SELECT c.id,a.data,c.data AS receipt FROM companion_state_change_memories v JOIN companion_state_changes c ON c.id=v.change_id JOIN companion_state_appraisals a ON a.id=c.id
          WHERE v.note_id=? AND v.note_version=? AND c.companion_id=? AND c.kind='memory' AND c.active=1`).all(version.id, version.version, companionId) as { id: string; data: string; receipt: string }[];
        for (const receipt of receipts) {
          if (withdrawn.includes(receipt.id)) continue;
          const data = JSON.parse(receipt.data) as { appliedAt: string; affectDelta: CompanionRuntimeState['affect'] };
          const delta = decayCompanionAffect({ pleasure: data.affectDelta.pleasure / 2, arousal: data.affectDelta.arousal / 2, dominance: data.affectDelta.dominance / 2 }, this.clock.elapsedVirtual(Date.parse(data.appliedAt), now));
          for (const axis of ['pleasure', 'arousal', 'dominance'] as const) state.affect[axis] = Math.max(-1, Math.min(1, state.affect[axis] - 2 * delta[axis]));
          this.db.prepare('UPDATE companion_state_changes SET active=0 WHERE id=?').run(receipt.id); this.db.prepare('UPDATE companion_state_appraisals SET active=0 WHERE id=?').run(receipt.id); withdrawn.push(receipt.id);
          if (state.reason === (JSON.parse(receipt.receipt) as { reason: string }).reason) {
            state.reason = undefined; state.sourceMessageIds = []; state.evidence = []; delete state.sourceConversationId;
          }
        }
      }
      if (!withdrawn.length) return;
      this.restoreDelivery(state, [], withdrawn);
      state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(companionId)); this.save(state);
    }).immediate();
  }
  private applyAppraisals(state: CompanionRuntimeState, proposal: ReturnType<typeof companionStateProposalSchema.parse>, sources: CompanionMessage[]): void {
    if (!proposal.appraisals.length || sources.some(source => this.db.prepare('SELECT 1 FROM companion_appraisal_sources WHERE companion_id=? AND message_id=?').get(state.companionId, source.id))) return;
    const quotes = proposal.evidence.filter(evidence => sources.find(source => source.id === evidence.sourceMessageId)?.authorId === 'user').map(evidence => evidence.quote).join('\n');
    const reportedSpeech = /(?:他说|她说|他们说|有人说|引用|台词|举例|例如|假如|假设|原话|he said|she said|they said|for example)|[“「『"]/iu.test(quotes);
    const positiveTypes = new Set(['support', 'respect', 'shared_success', 'repair']);
    const positiveNegation = /(?:不|没|别|无|未|不要|不用|无需|不必|拒绝|停止|取消).{0,10}(?:支持|尊重|理解|相信|谢谢|感谢|一起|共同|道歉|抱歉|对不起)|(?:do not|don't|not|never|no need).{0,20}(?:support|respect|trust|thank|together|sorry|apolog)/iu;
    const patterns = { support: /支持|陪你|帮你|相信你|陪着你|support|here for you/iu, respect: /尊重|理解你|谢谢|感谢|respect|thank/iu,
      boundary_violation: /不管你|强迫|必须听我的|不尊重|越界|ignore your|force you/iu, hostility: /废物|蠢|傻|滚|恨你|讨厌你|idiot|stupid|hate you|shut up/iu,
      shared_success: /一起|我们|多亏你|谢谢|共同|we |together|thanks/iu, repair: /对不起|抱歉|道歉|改正|sorry|apolog/iu, disappointment: /不再相信你|失望于你|对你失望|don't trust you|disappointed in you/iu };
    const appraisals = proposal.appraisals.filter(appraisal => {
      if (appraisal.confidence < COMPANION_APPRAISAL_CONFIDENCE_THRESHOLD) return false;
      if (appraisal.target !== 'user') return true;
      if (!sources.some(source => source.authorId === 'user') || reportedSpeech || !patterns[appraisal.type].test(quotes)) return false;
      return !positiveTypes.has(appraisal.type) || (!positiveNegation.test(quotes) && !/[?？]/u.test(quotes));
    });
    // An uncertain or mechanically unsupported classification must not reserve its source.
    if (!appraisals.length) return;
    const latest = sources.reduce((latest, source) => source.createdAt > latest.createdAt ? source : latest, sources[0]!);
    const occurredAt = latest.createdAt, occurredWorldAt = latest.worldCreatedAt ?? isoDate(this.clock.virtualAt(Date.parse(occurredAt)));
    const sourceDate = this.worldDay(Date.parse(occurredWorldAt)), now = this.currentTime(Date.now()), elapsed = this.clock.elapsedVirtual(Date.parse(occurredAt), now);
    const used = Number(row(this.db.prepare('SELECT COALESCE(sum(positive_change),0) AS n FROM companion_state_appraisals WHERE companion_id=? AND source_date=?').get(state.companionId, sourceDate)).n);
    let positiveChange = 0;
    const before = { affect: { ...state.affect }, relationship: { ...state.relationship } };
    for (const appraisal of appraisals) {
      const result = applyCompanionAppraisal(state, appraisal, elapsed, Math.max(0, COMPANION_RELATIONSHIP_DAILY_POSITIVE_LIMIT - used - positiveChange));
      state.affect = result.affect; state.relationship = result.relationship; positiveChange += result.positiveChange;
    }
    const id = createHash('sha256').update(state.companionId + '/' + [...sources.map(source => source.id)].sort().join('/')).digest('hex');
    const data = { sourceMessageIds: sources.map(source => source.id), sourceConversationId: sources[0]!.conversationId, occurredAt, occurredWorldAt, appliedAt: isoDate(now),
      affectDelta: Object.fromEntries(Object.keys(state.affect).map(key => [key, state.affect[key as keyof typeof state.affect] - before.affect[key as keyof typeof before.affect]])),
      relationshipDelta: Object.fromEntries(Object.keys(state.relationship).map(key => [key, state.relationship[key as keyof typeof state.relationship] - before.relationship[key as keyof typeof before.relationship]])) };
    this.db.prepare('INSERT INTO companion_state_appraisals(id,companion_id,source_date,positive_change,data) VALUES(?,?,?,?,?)').run(id, state.companionId, sourceDate, positiveChange, JSON.stringify(data));
    for (const source of sources) this.db.prepare('INSERT INTO companion_appraisal_sources(companion_id,message_id,appraisal_id) VALUES(?,?,?)').run(state.companionId, source.id, id);
    state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(state.companionId));
  }
  /** Only verified, formally committed notes may influence current delivery. No user relationship inference here. */
  applyMemoryIntegration(scope: Scope, input: CompanionMemoryStateIntegration): CompanionRuntimeState {
    return this.db.transaction(() => {
      this.requireScope(scope);
      if (!input.eventKey || input.eventKey.length > 300 || !input.reason.trim() || input.reason.length > 1000
        || !input.memoryVersions.length || input.memoryVersions.length > 30 || !input.sourceMessageIds.length || input.sourceMessageIds.length > 100) throw new Error('记忆整合状态缺少正式来源。');
      const sources = this.visibleSources(scope, [...new Set(input.sourceMessageIds)]);
      if (sources.length !== new Set(input.sourceMessageIds).size) throw new Error('记忆整合来源已撤回。');
      for (const note of input.memoryVersions) {
        if (!this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status') IN('queued','indexed')").get(note.id, scope.companionId, note.version)) throw new Error('正式记忆版本或归属已变化。');
        const links = this.db.prepare('SELECT s.message_id,s.revision,s.checksum,m.revision AS current_revision FROM vcp_note_sources s JOIN messages m ON m.id=s.message_id WHERE s.note_id=?').all(note.id) as { message_id: string; revision: number; checksum: string; current_revision: number }[];
        const visible = this.visibleSources(scope, links.map(link => link.message_id));
        if (!links.length || visible.length !== links.length || links.some(link => { const current = visible.find(source => source.id === link.message_id);
          return !current || link.current_revision !== link.revision || createHash('sha256').update(current.content).digest('hex') !== link.checksum;
        })) throw new Error('正式记忆的原文证据已经变化或撤回。');
      }
      const noteIds = [...new Set(input.memoryVersions.map(note => note.id))];
      for (const source of sources) if (!this.db.prepare(`SELECT 1 FROM vcp_note_sources WHERE message_id=? AND note_id IN (${noteIds.map(() => '?').join(',')})`).get(source.id, ...noteIds)) throw new Error('状态来源不属于本次正式记忆。');
      const appraisals = input.appraisals.map(item => companionAppraisalSchema.parse(item));
      if (appraisals.length > 8 || appraisals.some(item => item.target === 'user')) throw new Error('记忆整理不能重复评价用户关系。');
      this.energy(scope.companionId);
      // A retry or a later learning round reusing identical formal versions is
      // not a fresh emotional experience, even when its job/event ID differs.
      const key = 'memory-state:' + createHash('sha256').update(JSON.stringify([...input.memoryVersions].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
      const state = this.load(scope.companionId);
      if (this.db.prepare('SELECT 1 FROM companion_state_events WHERE companion_id=? AND event_key=?').get(scope.companionId, key)) return this.get(scope);
      if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) {
        this.db.prepare('INSERT INTO companion_state_events(companion_id,event_key,conversation_id) VALUES(?,?,?)').run(scope.companionId, key, scope.conversationId);
        this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('state-memory-integration/' + scope.companionId + '/' + key,
          JSON.stringify({ companionId: scope.companionId, status: 'skipped', reason: 'state_revision_changed', eventKey: input.eventKey, expectedRevision: input.expectedRevision,
            currentRevision: state.revision, at: isoDate(this.currentTime(Date.now())), memoryVersions: input.memoryVersions }));
        return this.get(scope);
      }
      const now = this.currentTime(Date.now());
      if (sources.some(source => Date.parse(source.createdAt) > now)) throw new Error('世界存档仍在补算，记忆整合尚未到达当前时刻。');
      const before = structuredClone(state);
      for (const appraisal of appraisals) { const result = applyCompanionAppraisal(state, appraisal, 0, 0); state.affect = result.affect; }
      if (input.expression) state.expression = companionStateProposalSchema.shape.expression.parse(input.expression)!;
      if (input.focus !== undefined) state.focus = companionStateProposalSchema.shape.focus.parse(input.focus) ?? undefined;
      const receiptId = 'memory-' + createHash('sha256').update(scope.companionId + ':' + key).digest('hex');
      this.rememberDelivery(state, { ...(input.expression !== undefined && before.expression !== state.expression ? { expression: input.expression } : {}),
        ...(input.focus !== undefined && before.focus !== state.focus ? { focus: input.focus } : {}) }, sources.map(source => source.id), receiptId);
      state.reason = input.reason; state.sourceConversationId = scope.conversationId; state.sourceMessageIds = sources.map(source => source.id);
      state.evidence = []; state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(scope.companionId)); this.save(state);
      this.db.prepare('INSERT INTO companion_state_events(companion_id,event_key,conversation_id) VALUES(?,?,?)').run(scope.companionId, key, scope.conversationId);
      this.storeHostImpulse(state, receiptId, 'memory', before,
        { reason: input.reason, occurredAt: state.updatedAt, sourceConversationId: scope.conversationId, sourceMessageIds: state.sourceMessageIds, memoryIds: noteIds, memoryVersions: input.memoryVersions });
      return this.get(scope);
    }).immediate();
  }
  private protectedActivity(id: string): string | undefined {
    const saved = this.db.prepare('SELECT data FROM companion_world WHERE id=1').get() as { data: string } | undefined;
    const actor = saved ? (JSON.parse(saved.data) as { actors: Array<{ companionId: string; activity: string }> }).actors.find(item => item.companionId === id) : undefined;
    return actor && ['sleeping', 'eating', 'working'].includes(actor.activity) ? actor.activity : undefined;
  }
  private storeHostImpulse(state: CompanionRuntimeState, id: string, kind: 'memory' | 'interruption', before: CompanionRuntimeState,
    receipt: { reason: string; occurredAt: string; sourceConversationId: string; sourceMessageIds: string[]; memoryIds?: string[]; memoryVersions?: Array<{ id: string; version: number }> }): void {
    const affectDelta = { pleasure: state.affect.pleasure - before.affect.pleasure, arousal: state.affect.arousal - before.affect.arousal, dominance: state.affect.dominance - before.affect.dominance };
    this.db.prepare('INSERT OR IGNORE INTO companion_state_appraisals(id,companion_id,source_date,positive_change,data) VALUES(?,?,?,?,?)').run(id, state.companionId, this.worldDay(this.clock.virtualAt(Date.parse(receipt.occurredAt))), 0,
      JSON.stringify({ appliedAt: state.updatedAt, affectDelta, relationshipDelta: { affinity: 0, trust: 0, respect: 0 } }));
    this.changes.add(state.companionId, { id, kind, ...receipt, appliedAt: state.updatedAt }, before, state);
  }
  /** Notification burden is a bounded host event, not a penalty for ordinary questions. */
  private notificationBurden(scope: Scope, source: CompanionMessage, urgent: boolean): void {
    const active = this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND COALESCE(json_extract(data,'$.active'),1)=1").get(scope.companionId);
    if (!active || source.status !== 'sent' || source.authorId === scope.companionId || source.authorId === 'system') return;
    // Form submissions also create user evidence messages. Only an admitted
    // chat notification counts toward a burst, never those audit documents.
    if (!urgent && !this.db.prepare("SELECT 1 FROM messages WHERE id=? AND json_extract(request_fingerprint,'$.replyDirective') IN('auto','queue','parallel','chat')").get(source.id)) return;
    const activity = this.protectedActivity(scope.companionId);
    if (!activity) return;
    const now = this.currentTime(Date.now());
    if (Date.parse(source.createdAt) > now || now - Date.parse(source.createdAt) > 30 * 60000) return;
    const id = 'notification-' + createHash('sha256').update(scope.companionId + ':' + source.id).digest('hex');
    if (this.db.prepare('SELECT 1 FROM companion_state_appraisals WHERE id=?').get(id)
      || this.db.prepare("SELECT 1 FROM companion_state_changes WHERE companion_id=? AND kind='interruption' AND applied_at>? LIMIT 1").get(scope.companionId, isoDate(now - 120000))) return;
    const pending = urgent ? [source] : (this.db.prepare(`SELECT id FROM messages WHERE conversation_id=? AND author_id='user' AND kind='text' AND status='sent' AND json_extract(request_fingerprint,'$.replyDirective') IN('auto','queue','parallel','chat') AND created_at>=? AND sequence<=?
      AND sequence>COALESCE((SELECT MAX(sequence) FROM messages WHERE conversation_id=? AND author_id=? AND kind='text' AND status='sent' AND sequence<?),0) ORDER BY sequence DESC LIMIT 4`)
      .all(scope.conversationId, isoDate(now - 90000), source.sequence, scope.conversationId, scope.companionId, source.sequence) as { id: string }[]).map(item => this.visibleSources(scope, [item.id])[0]).filter((item): item is CompanionMessage => !!item);
    if (!urgent && pending.length < 4) return;
    this.energy(scope.companionId); const state = this.load(scope.companionId), before = structuredClone(state);
    const result = applyCompanionAppraisal(state, { type: 'disappointment', target: 'self', intensity: urgent ? .35 : .2, confidence: 1 }, this.clock.elapsedVirtual(Date.parse(source.createdAt), now), 0);
    state.affect = result.affect; state.energy = Math.max(0, state.energy - (urgent ? 2 : 1));
    const label = activity === 'sleeping' ? '睡眠' : activity === 'eating' ? '用餐' : '集中工作';
    const reason = urgent ? `实际优先处理紧急联系，${label}中的注意力切换产生少量负担；不据此评价对方人品或降低信任。`
      : `${label}期间 90 秒内收到至少 4 条尚未回应的通知，产生一次少量注意力负担；正常提问与消息数量不作为关系惩罚。`;
    state.reason = reason; state.sourceConversationId = scope.conversationId; state.sourceMessageIds = pending.map(message => message.id); state.evidence = [];
    state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(scope.companionId)); this.save(state);
    this.storeHostImpulse(state, id, 'interruption', before, { reason, occurredAt: source.createdAt, sourceConversationId: scope.conversationId, sourceMessageIds: state.sourceMessageIds });
  }
  interaction(companionId: string, messageId: string): void {
    const found = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    if (!found) throw new Error('互动消息不存在。');
    const message = row(found), scope = { companionId, conversationId: String(message.conversation_id) };
    this.requireScope(scope);
    if (!this.visibleSources(scope, [messageId]).length || message.kind !== 'text' || !['user', companionId].includes(String(message.author_id))) return;
    this.db.transaction(() => {
      if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_interactions(companion_id,message_id,conversation_id) VALUES(?,?,?)').run(companionId, messageId, scope.conversationId).changes) return;
      this.energy(companionId);
      const state = this.load(companionId);
      state.familiarity.interactionCount++;
      state.familiarity.stage = stage(state.familiarity.interactionCount, state.familiarity.sharedEventCount);
      if (message.author_id === companionId) {
        state.energy -= 2;
        if (state.energy < 20) { state.mood = 'tired'; state.reason = '完成对话后需要恢复精力。'; state.sourceConversationId = scope.conversationId; state.sourceMessageIds = [messageId]; state.evidence = []; }
      }
      state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(companionId));
      this.save(state);
      if (message.author_id === 'user') this.notificationBurden(scope, this.visibleSources(scope, [messageId])[0]!, false);
    }).immediate();
  }
  action(actionId: string): void {
    const found = this.db.prepare('SELECT data FROM actions WHERE id=?').get(actionId);
    if (!found) throw new Error('行动不存在。');
    const action = decode<CompanionAction>(row(found).data);
    if (!['running', 'succeeded', 'failed', 'cancelled'].includes(action.status)) return;
    this.db.transaction(() => {
      this.requireCompanion(action.companionId);
      if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_actions(action_id,status) VALUES(?,?)').run(actionId, action.status).changes) return;
      this.energy(action.companionId);
      const state = this.load(action.companionId);
      const before = structuredClone(state);
      if (action.status === 'running') { state.energy -= 12; state.focus = action.title; state.reason = '正在执行已授权的安排。'; }
      else { state.focus = undefined; state.reason = action.status === 'succeeded' ? '完成了一项安排。' : action.status === 'failed' ? '刚才的安排未能完成。' : '已经停止当前安排。'; }
      if (action.status === 'succeeded' || action.status === 'failed') { const evaluated = applyCompanionAppraisal(state, { type: action.status === 'succeeded' ? 'shared_success' : 'disappointment', target: 'task', intensity: 1, confidence: 1 }, 0, 0); state.affect = evaluated.affect; }
      state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(action.companionId));
      state.sourceConversationId = action.conversationId;
      const evidence = this.db.prepare('SELECT id FROM messages WHERE action_id=? AND status=\'sent\' ORDER BY sequence DESC LIMIT 1').get(action.id);
      state.sourceMessageIds = [evidence ? String(row(evidence).id) : action.sourceMessageId]; state.evidence = [];
      if (['succeeded', 'failed'].includes(action.status) && (action.result || action.error)) this.addExperience(state,
        { companionId: action.companionId, conversationId: action.conversationId }, 'action:' + action.id, [action.sourceMessageId]);
      this.save(state);
      this.changes.add(action.companionId, { id: 'action-state-' + action.id + '-' + action.status, kind: 'task', appliedAt: state.updatedAt,
        occurredAt: state.updatedAt, reason: state.reason!, sourceConversationId: action.conversationId, sourceMessageIds: state.sourceMessageIds ?? [] }, before, state);
    }).immediate();
  }
  /** A real task receipt contributes once; diary wording and tag counts never do. */
  private addExperience(state: CompanionRuntimeState, scope: Scope, key: string, sourceIds: string[]): void {
    const sources = this.visibleSources(scope, sourceIds);
    if (!sources.length || sources.length !== sourceIds.length || !sources.some(source => source.authorId === 'user')) return;
    const eventKey = 'experience:' + key;
    if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_events(companion_id,event_key,conversation_id) VALUES(?,?,?)').run(scope.companionId, eventKey, scope.conversationId).changes) return;
    for (const source of sources) this.db.prepare('INSERT INTO companion_state_event_sources VALUES(?,?,?)').run(scope.companionId, eventKey, source.id);
    state.familiarity.sharedEventCount++;
    state.familiarity.stage = stage(state.familiarity.interactionCount, state.familiarity.sharedEventCount);
  }
  experience(scope: Scope, key: string, sourceIds: string[]): void {
    this.db.transaction(() => { this.requireScope(scope); this.energy(scope.companionId); const state = this.load(scope.companionId);
      this.addExperience(state, scope, key, sourceIds); this.save(state); }).immediate();
  }
  worldState(companionId: string): Pick<CompanionRuntimeState, 'energy' | 'mood' | 'expression' | 'affect'> {
    this.energy(companionId); const state = this.load(companionId);
    return { energy: state.energy, mood: state.mood, expression: state.expression, affect: { ...state.affect } };
  }
  /** Host-only simulated environment/peer effects never change the player's relationship or familiarity. */
  worldEvent(event: CompanionWorldEvent): void {
    if (event.kind === 'social_interrupt' && event.targetId && event.sourceMessageId && event.conversationId) {
      const scope = { companionId: event.targetId, conversationId: event.conversationId };
      const source = this.visibleSources(scope, [event.sourceMessageId])[0];
      if (source) this.notificationBurden(scope, source, true);
      return;
    }
    if (!event.actorId || !event.effect) return;
    this.db.transaction(() => {
      const companionId = event.actorId!, key = 'world:' + event.id;
      if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_events(companion_id,event_key,conversation_id) VALUES(?,?,?)').run(companionId, key, event.conversationId ?? 'world').changes) return;
      const sources = event.sourceMessageId && event.conversationId ? this.visibleSources({ companionId, conversationId: event.conversationId }, [event.sourceMessageId]) : [];
      if (event.sourceMessageId && !sources.length || sources.some(source => this.db.prepare('SELECT 1 FROM companion_appraisal_sources WHERE companion_id=? AND message_id=?').get(companionId, source.id))) return;
      this.energy(companionId); const state = this.load(companionId), beforeState = structuredClone(state), before = { ...state.affect }, now = this.currentTime(Date.now());
      const result = applyCompanionAppraisal(state, { type: event.effect!.type === 'stress' ? 'disappointment' : event.effect!.type === 'shared_success' ? 'shared_success' : 'support', target: 'other', intensity: Math.min(.4, event.effect!.intensity), confidence: 1 }, this.clock.elapsedVirtual(Date.parse(event.realAt), now), 0);
      state.affect = result.affect; state.mood = deriveCompanionMood(state.affect, state.energy, this.busy(companionId));
      const appraisalId = 'world-' + event.id;
      this.db.prepare('INSERT INTO companion_state_appraisals(id,companion_id,source_date,positive_change,data) VALUES(?,?,?,?,?)').run(appraisalId, companionId, this.worldDay(Date.parse(event.at)), 0,
        JSON.stringify({ appliedAt: isoDate(now), affectDelta: { pleasure: state.affect.pleasure - before.pleasure, arousal: state.affect.arousal - before.arousal, dominance: state.affect.dominance - before.dominance }, relationshipDelta: { affinity: 0, trust: 0, respect: 0 } }));
      for (const source of sources) this.db.prepare('INSERT INTO companion_appraisal_sources(companion_id,message_id,appraisal_id) VALUES(?,?,?)').run(companionId, source.id, appraisalId);
      this.save(state);
      this.changes.add(companionId, { id: appraisalId, kind: 'world', appliedAt: state.updatedAt, occurredAt: event.realAt,
        reason: event.text, ...(event.conversationId ? { sourceConversationId: event.conversationId } : {}), sourceMessageIds: sources.map(source => source.id) }, beforeState, state);
    }).immediate();
  }
  tick(at = new Date().toISOString()): void {
    const now = new Date(at).getTime();
    for (const companion of rows(this.db.prepare("SELECT id FROM companions c WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')").all())) this.energy(String(companion.id), now);
  }
  rehomeConversation(oldId: string, newId: string): void {
    this.db.prepare('UPDATE companion_state_interactions SET conversation_id=? WHERE conversation_id=?').run(newId, oldId);
    this.db.prepare('UPDATE companion_state_events SET conversation_id=? WHERE conversation_id=?').run(newId, oldId);
    for (const item of rows(this.db.prepare('SELECT data FROM companion_runtime_states WHERE json_extract(data,\'$.sourceConversationId\')=?').all(oldId))) { const state = decode<CompanionRuntimeState>(item.data); state.sourceConversationId = newId; this.save(state); }
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'state.get': case 'state.inspect': return { ok: true, runtimeState: this.get(command) };
      case 'state.update': return { ok: true, runtimeState: this.update(command, command.proposal, command.expectedRevision) };
      case 'state.interaction': this.interaction(command.companionId, command.messageId); return { ok: true };
      case 'state.action': this.action(command.actionId); return { ok: true };
      case 'state.tick': this.tick(command.at); return { ok: true };
      default: return undefined;
    }
  }
}
