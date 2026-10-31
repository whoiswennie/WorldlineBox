import { createHash } from 'node:crypto';
import { companionRuntimeStateSchema, companionStateProposalSchema, type CompanionRuntimeState, type CompanionStateProposal } from '../shared/companion-state';
import { companionCurrentExperienceSchema, companionRelationshipRecordSchema, type CurrentExperienceDraft, type RelationshipRecordDraft, type CurrentExperience, type RelationshipRecord } from '../shared/companion-current-experience';
import type { CompanionMessage, CompanionAction } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionConnection } from './store';
import type { CompanionRoutineRuntime } from '../shared/companion-routine';
import type { CompanionWorldEvent } from '../shared/companion-world';
import { CompanionStateChangeStore } from './state-change-store';
import { ensureQualitativeStateTables } from './qualitative-state-schema';
import { companionMessageFictionalLineage } from './fictional-source';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Stored = { data: string };
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
const iso = (at = Date.now()) => new Date(at).toISOString();
export type CompanionMemoryStateIntegration = { eventKey: string; kind: 'capture' | 'sleep' | 'learning'; reason: string;
  expression?: CompanionRuntimeState['expression']; focus?: string | null; experience?: CurrentExperienceDraft;
  relationshipUpdates?: RelationshipRecordDraft[]; sourceMessageIds: string[]; memoryVersions: Array<{ id: string; version: number }>; expectedRevision?: number };

/** Physical resource state plus explicitly sourced qualitative records. */
export class CompanionStateStore {
  private readonly changes: CompanionStateChangeStore;
  constructor(private readonly db: CompanionConnection,
    private readonly visibleSources: (scope: Scope, ids: string[]) => CompanionMessage[],
    private readonly advanceEnergy: (id: string, from: number, to: number, energy: number, busy: boolean) => number,
    private readonly routine: (scope: Scope, now: number) => CompanionRoutineRuntime,
    private readonly currentTime: (at: number) => number) {
    this.changes = new CompanionStateChangeStore(db, visibleSources);
  }
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_runtime_states(companion_id TEXT PRIMARY KEY REFERENCES companions(id),data TEXT NOT NULL,energy_clock INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_state_interactions(companion_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),conversation_id TEXT NOT NULL,PRIMARY KEY(companion_id,message_id));
      CREATE TABLE IF NOT EXISTS companion_state_events(companion_id TEXT NOT NULL,event_key TEXT NOT NULL,conversation_id TEXT NOT NULL,PRIMARY KEY(companion_id,event_key));
      CREATE TABLE IF NOT EXISTS companion_state_event_sources(companion_id TEXT NOT NULL,event_key TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(companion_id,event_key,message_id));`);
    ensureQualitativeStateTables(this.db); this.changes.initialize();
  }
  private requireCompanion(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('伙伴不存在或已移除。');
  }
  private requireScope(scope: Scope): { kind: string } {
    this.requireCompanion(scope.companionId);
    const room = this.db.prepare('SELECT kind FROM conversations WHERE id=? AND dissolved_at IS NULL').get(scope.conversationId) as { kind: string } | undefined;
    if (!room || !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(scope.conversationId, scope.companionId)) throw new Error('状态不属于当前聊天范围。');
    return room;
  }
  private load(id: string, initializedAt = Date.now()): CompanionRuntimeState {
    this.requireCompanion(id);
    const found = this.db.prepare('SELECT data FROM companion_runtime_states WHERE companion_id=?').get(id) as Stored | undefined;
    if (found) {
      const parsed = companionRuntimeStateSchema.safeParse(JSON.parse(found.data));
      if (!parsed.success) throw new Error('伙伴运行状态不是当前定性协议；请通过开发版清空重建流程建立新实例。');
      return parsed.data;
    }
    // Initialization must not advance the world: ensureThrough can call energy()
    // again while materializing pending events and would race this first insert.
    const state: CompanionRuntimeState = { schema: 'companion-runtime-qualitative-v1', companionId: id, energy: 100, expression: 'gentle', relationshipRecords: [], updatedAt: iso(initializedAt), revision: 1 };
    this.db.prepare('INSERT INTO companion_runtime_states(companion_id,data,energy_clock) VALUES(?,?,?)').run(id, JSON.stringify(state), initializedAt);
    return state;
  }
  private save(state: CompanionRuntimeState, at = Date.now()): void {
    const observedAt = this.currentTime(at);
    state.updatedAt = iso(observedAt); state.revision++; state.energy = Math.max(0, Math.min(100, state.energy));
    // The separate source-backed tables are authoritative for qualitative data.
    const persisted = companionRuntimeStateSchema.parse({ ...state, experience: undefined, relationshipRecords: [], routine: undefined, recentChanges: undefined });
    this.db.prepare('UPDATE companion_runtime_states SET data=?,energy_clock=? WHERE companion_id=?').run(JSON.stringify(persisted), observedAt, state.companionId);
  }
  private busy(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM actions WHERE companion_id=? AND status='running' UNION ALL SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status='running' LIMIT 1").get(id, id);
  }
  energy(id: string, now = Date.now()): number {
    now = this.currentTime(now);
    return this.db.transaction(() => {
      const state = this.load(id, now), found = this.db.prepare('SELECT energy_clock FROM companion_runtime_states WHERE companion_id=?').get(id) as { energy_clock: number };
      const active = !!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND COALESCE(json_extract(data,'$.active'),1)=1").get(id);
      if (now > found.energy_clock && active) {
        state.energy = Math.max(0, Math.min(100, this.advanceEnergy(id, found.energy_clock, now, state.energy, this.busy(id)))); state.updatedAt = iso(now);
        this.db.prepare('UPDATE companion_runtime_states SET data=?,energy_clock=? WHERE companion_id=?').run(JSON.stringify(state), now, id);
      }
      return state.energy;
    }).immediate();
  }
  private messageRevision(messageId: string): number {
    const source = this.db.prepare('SELECT revision FROM messages WHERE id=?').get(messageId) as { revision: number } | undefined;
    if (!source) throw new Error('体验来源不存在。'); return source.revision;
  }
  private sourceSequence(ids: string[] = []): number {
    return Math.max(0, ...ids.map(id => (this.db.prepare('SELECT sequence FROM messages WHERE id=?').get(id) as { sequence: number } | undefined)?.sequence ?? 0));
  }
  private recordVisible(scope: Scope, record: CurrentExperience | RelationshipRecord, group: boolean): boolean {
    if (group && record.sourceConversationId !== scope.conversationId) return false;
    const sources = this.visibleSources(scope, record.sourceMessageIds);
    return sources.length === record.sourceMessageIds.length && record.sourceVersions.every(version => {
      const source = sources.find(item => item.id === version.messageId);
      return source && this.messageRevision(source.id) === version.revision && checksum(source.content) === version.checksum;
    });
  }
  private project(scope: Scope, state: CompanionRuntimeState, now: number): CompanionRuntimeState {
    const room = this.requireScope(scope), sequence = scope.beforeSequence ?? Number.MAX_SAFE_INTEGER;
    const experienceRows = this.db.prepare('SELECT data FROM companion_current_experiences WHERE companion_id=? AND active=1 AND source_sequence<=? ORDER BY source_sequence DESC,rowid DESC LIMIT 32').all(scope.companionId, sequence) as Stored[];
    state.experience = experienceRows.map(row => companionCurrentExperienceSchema.parse(JSON.parse(row.data))).find(record =>
      (!record.validUntil || Date.parse(record.validUntil) > now) && this.recordVisible(scope, record, room.kind === 'group'));
    const relationshipRows = this.db.prepare('SELECT data FROM companion_relationship_records WHERE companion_id=? AND active=1 AND source_sequence<=? ORDER BY source_sequence DESC,rowid DESC LIMIT 128').all(scope.companionId, sequence) as Stored[];
    state.relationshipRecords = relationshipRows.map(row => companionRelationshipRecordSchema.parse(JSON.parse(row.data)))
      .filter(record => this.recordVisible(scope, record, room.kind === 'group')).slice(0, 24);
    return state;
  }
  get(scope: Scope): CompanionRuntimeState {
    const room = this.requireScope(scope), observedAt = this.currentTime(Date.now()); this.energy(scope.companionId, observedAt);
    const state = this.project(scope, this.load(scope.companionId, observedAt), observedAt);
    state.recentChanges = this.changes.recent(scope); state.routine = this.routine(scope, observedAt);
    const ids = state.sourceMessageIds ?? [];
    const visible = this.visibleSources(scope, ids), changed = (state.sourceVersions ?? []).some(version => {
      const source = visible.find(item => item.id === version.messageId);
      return !source || this.messageRevision(source.id) !== version.revision || checksum(source.content) !== version.checksum;
    });
    if (changed || ids.length && visible.length !== ids.length || room.kind === 'group' && state.sourceConversationId !== scope.conversationId) {
      state.reason = undefined; state.focus = undefined; state.sourceConversationId = undefined; state.sourceMessageIds = []; state.sourceVersions = []; state.evidence = []; state.expression = 'gentle';
    }
    return state;
  }
  private sources(scope: Scope, ids: string[]): CompanionMessage[] {
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('定性状态需要不重复的正式来源。');
    const sources = this.visibleSources(scope, ids);
    if (sources.length !== ids.length || sources.some(source => source.status !== 'sent' || source.isReplyDraft || source.replyDraft)) throw new Error('定性状态来源不可用或尚未正式发布。');
    if (sources.some(source => companionMessageFictionalLineage(this.db, source.id))) throw new Error('游戏、故事或其派生资料不能写成全局本人体验与关系认识。');
    const observedAt = this.currentTime(Date.now());
    if (sources.some(source => Date.parse(source.createdAt) > observedAt)) throw new Error('定性状态来源尚未到达当前世界时刻。');
    return sources;
  }
  private provenance(scope: Scope, key: string, sources: CompanionMessage[]) {
    return { id: 'qual_' + checksum(scope.companionId + ':' + key).slice(0, 48), companionId: scope.companionId,
      sourceConversationId: scope.conversationId, sourceMessageIds: sources.map(source => source.id),
      sourceVersions: sources.map(source => ({ messageId: source.id, revision: this.messageRevision(source.id), checksum: checksum(source.content) })),
      occurredAt: sources.reduce((last, source) => source.createdAt > last ? source.createdAt : last, sources[0]!.createdAt), recordedAt: iso(this.currentTime(Date.now())), revision: 1 };
  }
  private link(kind: 'experience' | 'relationship', recordId: string, owner: string, sources: CompanionMessage[], memories: Array<{ id: string; version: number }>): void {
    for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO companion_qualitative_state_sources VALUES(?,?,?,?)').run(kind, recordId, owner, source.id);
    for (const memory of memories) this.db.prepare('INSERT OR IGNORE INTO companion_qualitative_state_memories VALUES(?,?,?,?,?)').run(kind, recordId, owner, memory.id, memory.version);
  }
  private recordIdentity(kind: string, draft: CurrentExperienceDraft | RelationshipRecordDraft, sources: CompanionMessage[]): string {
    const versions = sources.map(source => ({ id: source.id, revision: this.messageRevision(source.id), checksum: checksum(source.content) })).sort((a, b) => a.id.localeCompare(b.id));
    return kind + ':' + checksum(JSON.stringify({ draft, versions }));
  }
  private recordExperience(scope: Scope, draft: CurrentExperienceDraft, sources: CompanionMessage[], memories: Array<{ id: string; version: number }> = []): CurrentExperience {
    const value = companionCurrentExperienceSchema.parse({ ...draft, ...this.provenance(scope, this.recordIdentity('experience', draft, sources), sources), type: 'current_experience' });
    const existing = this.db.prepare('SELECT data FROM companion_current_experiences WHERE id=?').get(value.id) as Stored | undefined;
    if (existing) return companionCurrentExperienceSchema.parse(JSON.parse(existing.data));
    const sequence = Math.max(...sources.map(source => source.sequence));
    const newer = this.db.prepare('SELECT 1 FROM companion_current_experiences WHERE companion_id=? AND source_sequence>? LIMIT 1').get(scope.companionId, sequence);
    if (newer) throw new Error('迟到体验不能覆盖较新的本人体验。');
    this.db.prepare('UPDATE companion_current_experiences SET active=0 WHERE companion_id=? AND active=1').run(scope.companionId);
    this.db.prepare('INSERT INTO companion_current_experiences(id,companion_id,conversation_id,source_sequence,data) VALUES(?,?,?,?,?)').run(value.id, scope.companionId, scope.conversationId, sequence, JSON.stringify(value));
    this.link('experience', value.id, scope.companionId, sources, memories); return value;
  }
  private recordRelationships(scope: Scope, drafts: RelationshipRecordDraft[], sources: CompanionMessage[], memories: Array<{ id: string; version: number }> = []): RelationshipRecord[] {
    return drafts.map(draft => {
      if (draft.targetId === scope.companionId || draft.targetId !== 'user' && !this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(draft.targetId)) throw new Error('关系经历的对象无效。');
      const value = companionRelationshipRecordSchema.parse({ ...draft, ...this.provenance(scope, this.recordIdentity('relationship', draft, sources), sources), type: 'relationship_record' });
      const existing = this.db.prepare('SELECT data FROM companion_relationship_records WHERE id=?').get(value.id) as Stored | undefined;
      if (existing) return companionRelationshipRecordSchema.parse(JSON.parse(existing.data));
      for (const oldId of value.replacesRecordIds) {
        const oldRow = this.db.prepare('SELECT data FROM companion_relationship_records WHERE id=? AND companion_id=? AND active=1').get(oldId, scope.companionId) as Stored | undefined;
        const old = oldRow && companionRelationshipRecordSchema.parse(JSON.parse(oldRow.data));
        if (!old || old.targetId !== value.targetId || old.topic !== value.topic || old.context !== value.context || !this.recordVisible(scope, old, this.requireScope(scope).kind === 'group')) throw new Error('只能修订同对象、事项与场景的可见关系经历。');
        this.db.prepare('UPDATE companion_relationship_records SET active=0 WHERE id=?').run(oldId);
      }
      this.db.prepare('INSERT INTO companion_relationship_records(id,companion_id,target_id,topic,context,conversation_id,source_sequence,data) VALUES(?,?,?,?,?,?,?,?)')
        .run(value.id, scope.companionId, value.targetId, value.topic, value.context, scope.conversationId, Math.max(...sources.map(source => source.sequence)), JSON.stringify(value));
      this.link('relationship', value.id, scope.companionId, sources, memories); return value;
    });
  }
  update(scope: Scope, input: CompanionStateProposal, expectedRevision?: number): CompanionRuntimeState {
    return this.db.transaction(() => {
      this.requireScope(scope); const proposal = companionStateProposalSchema.parse(input), sources = this.sources(scope, proposal.sourceMessageIds);
      if (sources.some(source => source.conversationId !== scope.conversationId)) throw new Error('状态提议只能引用当前入口的正式来源。');
      for (const source of sources) if (!proposal.evidence.some(item => item.sourceMessageId === source.id)) throw new Error('每条状态来源均需逐字证据。');
      if (proposal.evidence.some(item => !sources.find(source => source.id === item.sourceMessageId)?.content.includes(item.quote))) throw new Error('体验证据不属于实际来源。');
      const observedAt = this.currentTime(Date.now()); this.energy(scope.companionId, observedAt);
      const state = this.project(scope, this.load(scope.companionId, observedAt), observedAt), before = structuredClone(state);
      if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new Error('伙伴状态已更新，请重新读取。');
      const key = 'update:' + checksum(JSON.stringify(proposal));
      if (this.db.prepare('SELECT 1 FROM companion_state_events WHERE companion_id=? AND event_key=?').get(scope.companionId, key)) return this.get(scope);
      if (Math.max(...sources.map(source => source.sequence)) < this.sourceSequence(state.sourceMessageIds)) throw new Error('迟到状态不能覆盖较新的当前关注。');
      this.db.prepare('INSERT INTO companion_state_events VALUES(?,?,?)').run(scope.companionId, key, scope.conversationId);
      if (proposal.experience) state.experience = this.recordExperience(scope, proposal.experience, sources);
      const relationships = this.recordRelationships(scope, proposal.relationshipUpdates, sources);
      if (proposal.expression) state.expression = proposal.expression;
      if (proposal.focus !== undefined) state.focus = proposal.focus ?? undefined;
      if (proposal.focus !== undefined || proposal.expression !== undefined) this.db.prepare('DELETE FROM metadata WHERE key=?').run('qualitative-memory-delivery/' + scope.companionId);
      state.reason = proposal.reason; state.sourceConversationId = scope.conversationId; state.sourceMessageIds = sources.map(source => source.id); state.sourceVersions = this.provenance(scope, key, sources).sourceVersions; state.evidence = proposal.evidence;
      state.relationshipRecords = [...relationships, ...state.relationshipRecords].slice(0, 24); this.save(state);
      this.changes.add(scope.companionId, { id: key, kind: 'experience', appliedAt: state.updatedAt, occurredAt: this.provenance(scope, key, sources).occurredAt,
        reason: proposal.reason, sourceConversationId: scope.conversationId, sourceMessageIds: state.sourceMessageIds }, before, state);
      return this.get(scope);
    }).immediate();
  }
  invalidateEvidence(companionId: string, sourceIds: string[]): void {
    if (!sourceIds.length) return;
    this.db.transaction(() => {
      for (const source of sourceIds) for (const [kind, table] of [['experience', 'companion_current_experiences'], ['relationship', 'companion_relationship_records']] as const)
        this.db.prepare(`UPDATE ${table} SET active=0 WHERE companion_id=? AND id IN(SELECT record_id FROM companion_qualitative_state_sources WHERE companion_id=? AND kind=? AND source_id=?)`).run(companionId, companionId, kind, source);
      this.changes.withdraw(companionId, sourceIds); const state = this.load(companionId);
      if (state.sourceMessageIds?.some(id => sourceIds.includes(id))) { state.focus = undefined; state.reason = undefined; state.expression = 'gentle'; state.sourceMessageIds = []; state.sourceVersions = []; state.evidence = []; state.sourceConversationId = undefined; }
      this.save(state);
    }).immediate();
  }
  invalidateMemoryVersions(companionId: string, versions: Array<{ id: string; version: number }>): void {
    this.db.transaction(() => {
      for (const version of versions) {
        for (const [kind, table] of [['experience', 'companion_current_experiences'], ['relationship', 'companion_relationship_records']] as const)
          this.db.prepare(`UPDATE ${table} SET active=0 WHERE companion_id=? AND id IN(SELECT record_id FROM companion_qualitative_state_memories WHERE companion_id=? AND kind=? AND note_id=? AND note_version=?)`).run(companionId, companionId, kind, version.id, version.version);
        this.db.prepare('UPDATE companion_state_changes SET active=0 WHERE companion_id=? AND id IN(SELECT change_id FROM companion_state_change_memories WHERE note_id=? AND note_version=?)').run(companionId, version.id, version.version);
      }
      const key = 'qualitative-memory-delivery/' + companionId;
      const origin = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
      if (origin && (JSON.parse(origin.value) as Array<{ id: string; version: number }>).some(note => versions.some(version => version.id === note.id && version.version === note.version))) {
        const state = this.load(companionId); state.focus = undefined; state.reason = undefined; state.expression = 'gentle'; state.sourceConversationId = undefined; state.sourceMessageIds = []; state.sourceVersions = []; state.evidence = []; this.save(state);
        this.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
      }
    }).immediate();
  }
  applyMemoryIntegration(scope: Scope, input: CompanionMemoryStateIntegration): CompanionRuntimeState {
    return this.db.transaction(() => {
      this.requireScope(scope); const sources = this.sources(scope, input.sourceMessageIds);
      if (!input.memoryVersions.length || input.memoryVersions.length > 30) throw new Error('反思状态需要本次正式记忆版本。');
      for (const memory of input.memoryVersions) {
        if (!this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status') IN('queued','indexed')").get(memory.id, scope.companionId, memory.version)) throw new Error('正式记忆版本或归属已变化。');
        const links = this.db.prepare('SELECT s.message_id,s.revision,s.checksum FROM vcp_note_sources s WHERE s.note_id=?').all(memory.id) as Array<{ message_id: string; revision: number; checksum: string }>;
        const visible = this.visibleSources(scope, links.map(link => link.message_id));
        if (!links.length || links.some(link => { const source = visible.find(source => source.id === link.message_id); return !source || this.messageRevision(source.id) !== link.revision || checksum(source.content) !== link.checksum; })) throw new Error('反思的原始证据已撤回或变化。');
      }
      for (const source of sources) if (!input.memoryVersions.some(memory => this.db.prepare('SELECT 1 FROM vcp_note_sources WHERE note_id=? AND message_id=?').get(memory.id, source.id))) throw new Error('状态来源不属于本次正式记忆。');
      const observedAt = this.currentTime(Date.now()); this.energy(scope.companionId, observedAt);
      const state = this.project(scope, this.load(scope.companionId, observedAt), observedAt);
      const key = 'memory-state:' + checksum(JSON.stringify([...input.memoryVersions].sort((a, b) => a.id.localeCompare(b.id))));
      if (this.db.prepare('SELECT 1 FROM companion_state_events WHERE companion_id=? AND event_key=?').get(scope.companionId, key)) return this.get(scope);
      this.db.prepare('INSERT INTO companion_state_events VALUES(?,?,?)').run(scope.companionId, key, scope.conversationId);
      const late = Math.max(...sources.map(source => source.sequence)) < this.sourceSequence(state.sourceMessageIds);
      if (late || input.expectedRevision !== undefined && input.expectedRevision !== state.revision) {
        this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('state-memory-integration/' + scope.companionId + '/' + key,
          JSON.stringify({ status: 'skipped', reason: late ? 'newer_current_state_source' : 'state_revision_changed', expectedRevision: input.expectedRevision, currentRevision: state.revision, memoryVersions: input.memoryVersions }));
        return this.get(scope);
      }
      const before = structuredClone(state);
      if (input.experience) state.experience = this.recordExperience(scope, input.experience, sources, input.memoryVersions);
      const relationships = this.recordRelationships(scope, input.relationshipUpdates ?? [], sources, input.memoryVersions);
      if (input.expression) state.expression = companionStateProposalSchema.shape.expression.parse(input.expression)!;
      if (input.focus !== undefined) state.focus = companionStateProposalSchema.shape.focus.parse(input.focus) ?? undefined;
      if (input.focus !== undefined || input.expression !== undefined) this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('qualitative-memory-delivery/' + scope.companionId, JSON.stringify(input.memoryVersions));
      state.reason = input.reason; state.sourceConversationId = scope.conversationId; state.sourceMessageIds = sources.map(source => source.id); state.sourceVersions = this.provenance(scope, key, sources).sourceVersions; state.evidence = [];
      state.relationshipRecords = [...relationships, ...state.relationshipRecords].slice(0, 24); this.save(state);
      this.changes.add(scope.companionId, { id: key, kind: 'memory', appliedAt: state.updatedAt, occurredAt: state.updatedAt, reason: input.reason,
        sourceConversationId: scope.conversationId, sourceMessageIds: state.sourceMessageIds, memoryIds: input.memoryVersions.map(memory => memory.id), memoryVersions: input.memoryVersions }, before, state);
      return this.get(scope);
    }).immediate();
  }
  interaction(companionId: string, messageId: string): void {
    const found = this.db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(messageId) as { conversation_id: string } | undefined;
    if (!found) return; const scope = { companionId, conversationId: found.conversation_id };
    if (!this.visibleSources(scope, [messageId]).length) return;
    this.db.prepare('INSERT OR IGNORE INTO companion_state_interactions(companion_id,message_id,conversation_id) VALUES(?,?,?)').run(companionId, messageId, found.conversation_id);
    // Recording delivery does not infer intimacy, trust, mood or maturity.
  }
  action(actionId: string): void {
    const found = this.db.prepare('SELECT data FROM actions WHERE id=?').get(actionId) as Stored | undefined;
    if (!found) return; const action = JSON.parse(found.data) as CompanionAction;
    if (action.thought || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(action.status)) return;
    if (!action.sourceMessageId) return;
    const scope = { companionId: action.companionId, conversationId: action.conversationId };
    const source = this.visibleSources(scope, [action.sourceMessageId]); if (!source.length) return;
    this.db.transaction(() => {
      this.energy(action.companionId); const state = this.load(action.companionId), before = structuredClone(state);
      const key = 'action:' + action.id + ':' + action.status;
      if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_events VALUES(?,?,?)').run(action.companionId, key, action.conversationId).changes) return;
      if (action.status === 'running') { state.energy = Math.max(0, state.energy - 12); state.focus = action.title; state.reason = '正在执行已授权的安排。'; }
      else { state.focus = undefined; state.reason = action.status === 'succeeded' ? '已完成本次安排。' : action.status === 'failed' ? '本次安排未能完成，结果需要核查。' : '本次安排已经停止。'; }
      state.sourceConversationId = action.conversationId; state.sourceMessageIds = [action.sourceMessageId!]; state.sourceVersions = this.provenance(scope, key, source).sourceVersions; state.evidence = []; this.save(state);
      this.changes.add(action.companionId, { id: key, kind: 'task', appliedAt: state.updatedAt, occurredAt: state.updatedAt, reason: state.reason!, sourceConversationId: action.conversationId, sourceMessageIds: state.sourceMessageIds }, before, state);
    }).immediate();
  }
  experience(scope: Scope, key: string, sourceIds: string[]): void {
    this.db.transaction(() => {
      this.requireScope(scope); const sources = this.sources(scope, sourceIds), eventKey = 'experience:' + key;
      if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_events VALUES(?,?,?)').run(scope.companionId, eventKey, scope.conversationId).changes) return;
      for (const source of sources) this.db.prepare('INSERT OR IGNORE INTO companion_state_event_sources VALUES(?,?,?)').run(scope.companionId, eventKey, source.id);
      // Evidence receipt only: no counter reward or automatically inferred relationship.
    }).immediate();
  }
  worldState(companionId: string): Pick<CompanionRuntimeState, 'energy' | 'expression' | 'experience'> {
    this.energy(companionId); const state = this.load(companionId);
    // World rendering cannot read private subjective reasons through a global snapshot.
    return { energy: state.energy, expression: state.expression };
  }
  worldEvent(event: CompanionWorldEvent): void {
    // Simulated effect.intensity is not a measurement of the owner's feelings.
    // Actual social/physical events remain in the world's evidence log; the owner
    // can later express an experience from authorized source material.
    if (!event.actorId || !event.sourceMessageId || !event.conversationId) return;
    // Fictional speech is valid communication in its original topic. It cannot
    // create a global experience receipt or abort that communication transaction.
    if (companionMessageFictionalLineage(this.db, event.sourceMessageId)) return;
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(event.actorId)
      || !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(event.conversationId, event.actorId)) return;
    const scope = { companionId: event.actorId, conversationId: event.conversationId };
    if (this.visibleSources(scope, [event.sourceMessageId]).length) this.experience(scope, 'world:' + event.id, [event.sourceMessageId]);
  }
  tick(at = iso()): void {
    for (const companion of this.db.prepare("SELECT id FROM companions c WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')").all() as Array<{ id: string }>) this.energy(companion.id, Date.parse(at));
  }
  rehomeConversation(oldId: string, newId: string): void {
    this.db.prepare('UPDATE companion_state_interactions SET conversation_id=? WHERE conversation_id=?').run(newId, oldId);
    this.db.prepare('UPDATE companion_state_events SET conversation_id=? WHERE conversation_id=?').run(newId, oldId);
    // Moving a container cannot grant an old private record to a new audience.
    this.db.prepare('UPDATE companion_current_experiences SET active=0 WHERE conversation_id=?').run(oldId);
    this.db.prepare('UPDATE companion_relationship_records SET active=0 WHERE conversation_id=?').run(oldId);
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
