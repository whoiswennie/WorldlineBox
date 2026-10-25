import type { ActivityMemoryOperation } from '../shared/companion-activity-task';
import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { AppendCompanionMessage, CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionExecutionReadsetSchema, type CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import type { CompanionMessage } from '../shared/companions';
import { activityTaskSchema, activityMemorySchema, activityDecisionSchema, COMPANION_ACTIVITY_HANDOFF_NOTICE, type ActivityDecision, type CompanionActivityTask } from '../shared/companion-activity-task';
import type { CompanionWorldStore } from './world-store';
import type { CompanionSocialStore } from './social-store';
import { companionTimeInZone } from '../shared/companion-schedule-time';
import { companionPlayerPhoneBusy } from './social-continuity-store';
import type { CompanionWorldSnapshot } from '../shared/companion-world';
import { companionTopicOperationSchema, COMPANION_TOPIC_STATE_WRITE_RECEIPT, companionGameStateHandoffReceipt, type CompanionTopicModeratorTransferApproval } from '../shared/companion-topic';
import { companionSocialGoalOrigin } from './social-goal-origin';
import type { CompanionActivityThoughtAuthorization } from '../shared/companion-activity-thought';
import { companionFinalProposalJsonText } from '../shared/companion-final-proposal';
import { companionPeerActivitySourceValid } from './peer-activity-source';
import { findCompanionActivityPortCandidate, findJoinedCompanionActivityPortCandidate, publicCompanionActivityPortCandidate } from './activity-port-candidates';
type Row = { data: string };
type GoalSocialOrigin = { messageId: string; sourceMessageId: string; deliveryClientId: string; conversationId: string; topicId?: string; chainId: string };
type Stored = CompanionActivityTask & { clientId: string; sourceChecksum?: string; nextAt: number; leaseUntil?: number;
  planningMs?: number; planningStartedAt?: number; reportVersion?: number;
  planningMilestoneStep?: number; planningMilestoneMs?: number;
  reportPending?: boolean; memoryIntentId?: string;
  reportReadset?: CompanionExecutionReadset;
  reportLeaseToken?: string; reportLeaseUntil?: number; reportObservation?: string; reportAttempts?: number; reportRejected?: boolean;
  reportError?: string; executionKnowledgeReads?: CompanionExecutionReadset['knowledgeReads'];
  observedProgressEvidence?: { leaseToken: string; observationChecksum: string };
  peerConversationId?: string;
  peerTopicId?: string | null;
  seededSocialClientIds?: string[];
  deferredDecision?: { step: number; decision: ActivityDecision; socialEvidence: Array<{ id: string; checksum: string }>; executionReadset?: CompanionExecutionReadset;
    topicModeratorTransferApproval?: CompanionTopicModeratorTransferApproval };
  observedSocialEvidence?: { leaseToken: string; messages: Array<{ id: string; checksum: string }> };
  worldDay?: string; createdVirtualAt?: number;
  evidence?: Array<{ id: string; conversationId: string; checksum: string }>;
  topicEvidence?: Array<{ conversationId: string; topicId: string; eventId: string }>;
  memoryVersions?: Array<{ id: string; version: number }>;
  wholeGoalPlan?: NonNullable<CompanionStorageResponse['activityPlanningState']>;
  condition?: { visitId?: string; until: number; afterSequence: number; sceneId?: string; x?: number; y?: number; virtualAt?: number } };
const iso = (at = Date.now()) => new Date(at).toISOString();
const terminal = (task: CompanionActivityTask) => ['succeeded', 'failed', 'cancelled'].includes(task.status);
const checksum = (source: CompanionMessage) => createHash('sha256').update(source.content).digest('hex');
const PLANNING_BUDGET_MS = 3600000;
const PLANNING_LEASE_MS = 120000;
const LEGACY_WAIT_TIMEOUT = '行动达到一小时或32步安全上限，已停止；已发生的行为保留。';
const LEGACY_CONTACT_REJECTION = '拟发内容或收件人超出了原委托的分享范围，已停止发送。';

/** Durable agent goals and atomic world effects share the existing SQLite transaction. */
export class CompanionActivityTaskStore {
  constructor(private readonly db: CompanionConnection, private readonly world: CompanionWorldStore, private readonly social: CompanionSocialStore,
    private readonly visible: (scope: { companionId: string; conversationId: string }, ids: string[]) => CompanionMessage[],
    private readonly append: (input: AppendCompanionMessage) => unknown,
    private readonly experienced: (task: CompanionActivityTask, sourceMessageId: string) => void,
    private readonly topicExecute?: (command: Extract<CompanionStorageCommand, { type: `topic.${string}` }>) => CompanionStorageResponse | undefined,
    private readonly agentRunExecute?: (command: Extract<CompanionStorageCommand, { type: 'agent.run.get' }>) => CompanionStorageResponse | undefined,
    private readonly memoryValid?: (owner: string, id: string, version: number) => boolean) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_activity_memory_intents(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES companion_activity_tasks(id) ON DELETE CASCADE,
      companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,lease_token TEXT,lease_until INTEGER);
      CREATE INDEX IF NOT EXISTS companion_activity_memory_pending ON companion_activity_memory_intents(status,lease_until)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_activity_tasks(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),source_message_id TEXT REFERENCES messages(id),status TEXT NOT NULL,next_at INTEGER NOT NULL,client_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_activity_due ON companion_activity_tasks(status,next_at);
      CREATE INDEX IF NOT EXISTS companion_activity_owner ON companion_activity_tasks(companion_id,status);
      CREATE INDEX IF NOT EXISTS companion_activity_room ON companion_activity_tasks(conversation_id,next_at);`);
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_activity_day ON companion_activity_tasks(companion_id,json_extract(data,'$.worldDay'))");
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_activity_source ON companion_activity_tasks(companion_id,source_message_id,conversation_id)');
    this.db.exec("CREATE INDEX IF NOT EXISTS companion_activity_recovery ON companion_activity_tasks(status,json_extract(data,'$.createdAt'))");
    if (!(this.db.prepare('PRAGMA table_info(companion_activity_tasks)').all() as { name: string }[]).some(column => column.name === 'report_pending')) this.db.exec('ALTER TABLE companion_activity_tasks ADD COLUMN report_pending INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_activity_reports ON companion_activity_tasks(report_pending,next_at)');
  }
  private save(task: Stored): void { task.updatedAt = iso(); this.db.prepare('UPDATE companion_activity_tasks SET status=?,next_at=?,report_pending=?,data=? WHERE id=?').run(task.status, task.nextAt, Number(!!task.reportPending), JSON.stringify(task), task.id); }
  /** Only leased planning consumes the budget. Offline time and durable waits do not. */
  private chargePlanning(task: Stored): void {
    if (task.planningStartedAt !== undefined) {
      const elapsed = Math.max(0, Math.min(PLANNING_LEASE_MS, Date.now() - task.planningStartedAt));
      task.planningMs = (task.planningMs ?? 0) + elapsed;
      task.planningMilestoneMs = (task.planningMilestoneMs ?? 0) + elapsed;
    }
    delete task.planningStartedAt;
  }
  private get(id: string): Stored {
    const row = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('行动任务不存在。'); return JSON.parse(row.data) as Stored;
  }
  private public(task: Stored): CompanionActivityTask {
    const parsed = activityTaskSchema.parse({ ...task, historyAvailable: true, history: task.history.slice(-32) });
    if (this.valid(task)) {
      if (terminal(task) && task.reportRejected) return { ...parsed, stage: '这条任务记录已结束，实际结果尚未核验。' };
      if (task.seededSocialClientIds?.length && !terminal(task)) {
        const authors = [...new Set(this.goalSocialMessages(task).messages.map(message => message.authorId))];
        const progress = authors.length
          ? `本目标已收到${authors.length}位伙伴的真实回信（${authors.slice(0, 6).join('、')}${authors.length > 6 ? '等' : ''}）。回信不等于报名；本轮未读正文时应说仍在确认，不能断言无人回复、报名0人或全员同意。`
          : '本目标当前尚无可见的真实回信凭证；这不是“无人报名”的证明，不能替未读的对方作判断。';
        // Read-only progress derived solely from this goal's actual invitation
        // chains. Other rooms' message bodies never become chat's recent flow.
        return { ...parsed, stage: `${progress}\n${parsed.stage}`.slice(0, 2000) };
      }
      return parsed;
    }
    return { ...parsed, title: '来源不可访问的行动', goal: '[来源已撤回，任务内容已隐藏]', stage: '来源已撤回、更新或主体不可访问，不能读取旧目标和过程。', historyAvailable: false, history: [], targetId: undefined, wait: undefined };
  }
  private valid(task: Stored): boolean {
    try { return this.validScope(task); } catch { return false; }
  }
  private validScope(task: Stored): boolean {
    if (this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status<>'completed')").get(task.companionId, task.companionId) === undefined) return false;
    if (task.targetId && !this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(task.targetId)) return false;
    if (task.gamePort && !this.gamePortValid(task)) return false;
    if (task.clientId.startsWith('schedule_activity_')) {
      const occurrenceId = task.clientId.slice('schedule_activity_'.length);
      const found = this.db.prepare("SELECT s.data FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id WHERE o.id=? AND s.status='active' AND o.status<>'cancelled'").get(occurrenceId) as Row | undefined;
      if (!found || (JSON.parse(found.data) as { prompt: string }).prompt !== task.goal) return false;
    }
    for (const item of task.evidence ?? []) {
      const message = this.visible({ companionId: task.companionId, conversationId: item.conversationId }, [item.id])[0];
      if (!message || checksum(message) !== item.checksum) return false;
    }
    for (const reference of task.topicEvidence ?? []) {
      const checked = this.topicExecute?.({ type: 'topic.sources.valid', conversationId: reference.conversationId,
        topicId: reference.topicId, readerId: task.companionId, sourceMessageIds: [], checkpointEventIds: [reference.eventId] });
      if (!checked?.ok || !checked.topicSourcesValid) return false;
    }
    for (const note of task.memoryVersions ?? []) if (this.memoryValid ? !this.memoryValid(task.companionId, note.id, note.version)
      : !this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status') IN('queued','indexed')")
        .get(note.id, task.companionId, note.version)) return false;
    for (const read of [...task.wholeGoalPlan?.knowledgeReads ?? [], ...task.executionKnowledgeReads ?? []]) {
      if (read.sourceType === 'learning' && !this.db.prepare('SELECT 1 FROM companion_learning_grants WHERE id=? AND companion_id=? AND enabled=1 AND revision=?')
        .get(read.grantId, task.companionId, read.grantRevision)) return false;
      if (read.sourceType === 'message') {
        const source = this.visible({ companionId: task.companionId, conversationId: read.conversationId }, [read.sourceId])[0];
        if (!source || checksum(source) !== read.sourceDigest) return false;
      }
      if (read.sourceType === 'memory' && (this.memoryValid ? !this.memoryValid(task.companionId, read.sourceId, Number(read.sourceVersion))
        : !this.db.prepare("SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status') IN('queued','indexed')")
          .get(read.sourceId, task.companionId, Number(read.sourceVersion)))) return false;
    }
    if (!task.sourceMessageId) return true;
    const source = this.visible(task, [task.sourceMessageId])[0];
    return !!source && checksum(source) === task.sourceChecksum && (source.authorId === 'user'
      ? !task.peerResponsibility : companionPeerActivitySourceValid(this.db, this.visible, task));
  }
  private gamePortValid(task: Stored): boolean {
    const port = task.gamePort;
    if (!port || !task.sourceMessageId) return false;
    if (port.delegatedCandidateId) {
      const candidate = findJoinedCompanionActivityPortCandidate(this.db, this.social, this.visible, { companionId: task.companionId,
        conversationId: port.conversationId, topicId: port.topicId }, { includeClosed: true });
      return !!candidate && candidate.id === port.delegatedCandidateId && candidate.rootConversationId === task.conversationId
        && candidate.rootSourceMessageId === task.sourceMessageId && candidate.rootSourceChecksum === task.sourceChecksum
        && candidate.deliveryClientId === port.deliveryClientId;
    }
    const found = this.db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(port.topicId, port.conversationId) as Row | undefined;
    const topic = found ? JSON.parse(found.data) as { kind: string; deletedAt?: string; participantIds: string[] } : undefined;
    if (!topic || topic.kind !== 'game' || topic.deletedAt || !topic.participantIds.includes(task.companionId)
      || !this.db.prepare('SELECT 1 FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=? AND m.companion_id=? AND c.dissolved_at IS NULL').get(port.conversationId, task.companionId)) return false;
    const outbox = this.db.prepare('SELECT companion_id,conversation_id,status,data FROM companion_social_outbox WHERE client_id=?').get(port.deliveryClientId) as { companion_id: string; conversation_id: string; status: string; data: string } | undefined;
    const sent = outbox ? JSON.parse(outbox.data) as { companionId: string; conversationId: string; topicId?: string | null;
      authorizationMessageId?: string; agentSource?: { conversationId: string; messageId: string } } : undefined;
    return !!outbox && !!sent && ['pending', 'sent'].includes(outbox.status) && outbox.companion_id === task.companionId
      && sent.companionId === task.companionId && outbox.conversation_id === port.conversationId && sent.conversationId === port.conversationId
      && sent.topicId === port.topicId && (sent.authorizationMessageId === task.sourceMessageId
        || sent.agentSource?.conversationId === task.conversationId && sent.agentSource.messageId === task.sourceMessageId
        || !!port.peerOriginId && !!sent.agentSource && this.peerGoalOrigins(task.companionId, sent.agentSource.conversationId,
          sent.agentSource.messageId).some(origin => origin.id === port.peerOriginId && origin.sourceMessageId === task.sourceMessageId
            && origin.conversationId === task.conversationId));
  }
  private bindGamePort(task: Stored, deliveryClientId: string, conversationId: string, topicId: string | null | undefined, peerOriginId?: string): void {
    if (!task.sourceMessageId || !topicId) return;
    const previous = task.gamePort;
    const candidate = { conversationId, topicId, deliveryClientId, ...(peerOriginId ? { peerOriginId } : {}) };
    if (!this.gamePortValid({ ...task, gamePort: candidate })) return;
    if (previous && (previous.conversationId !== conversationId || previous.topicId !== topicId)) {
      const old = this.topicExecute?.({ type: 'topic.read', conversationId: previous.conversationId,
        topicId: previous.topicId, readerId: task.companionId })?.topic;
      if (!old || old.deletedAt || old.status !== 'closed') throw new Error('当前目标的原游戏端口尚未明确关闭，不能迁移到另一局；原端口缺失、删除或暂停也不等于已结束。');
    }
    task.gamePort = candidate;
  }
  /** Only an actual owner peer job in the original host delegation may carry
   * its created port back. Peer prose and a convenient member list prove none
   * of this relationship. Revalidate the host origin on every later read. */
  private peerGoalOrigins(owner: string, conversationId: string, sourceMessageId: string) {
    const jobs = this.db.prepare("SELECT data FROM companion_social_jobs WHERE companion_id=? AND conversation_id=? AND json_extract(data,'$.sourceMessageId')=? AND status IN('running','done')")
      .all(owner, conversationId, sourceMessageId) as Row[];
    const found = new Map<string, { id: string; conversationId: string; sourceMessageId: string }>();
    for (const row of jobs) {
      const job = JSON.parse(row.data) as { chainId: string; readSet?: Array<{ id: string; checksum: string }> };
      const origin = this.social.continuity.forChain(job.chainId);
      if (!origin || origin.initiatorKind !== 'human_player' || origin.ownerId !== owner || origin.initiatorId !== 'user'
        || !this.social.continuity.validOrigin(origin.id)) continue;
      const peer = this.visible({ companionId: owner, conversationId }, [sourceMessageId])[0];
      if (!peer || peer.authorId === owner || peer.authorId === 'user' || peer.authorId === 'system'
        || !job.readSet?.some(source => source.id === sourceMessageId && source.checksum === createHash('sha256')
          .update(JSON.stringify([peer.id, peer.conversationId, peer.topicId, peer.authorId, peer.content, peer.status, peer.replyToId])).digest('hex'))) continue;
      const delegation = this.db.prepare("SELECT data FROM companion_social_delegations WHERE id=? AND companion_id=? AND status='active'").get(origin.id, owner) as Row | undefined;
      if (!delegation) continue;
      const original = JSON.parse(delegation.data) as { conversationId: string; sourceMessageId: string };
      found.set(origin.id, { id: origin.id, conversationId: original.conversationId, sourceMessageId: original.sourceMessageId });
    }
    return [...found.values()];
  }
  private bindPeerPort(input: Extract<CompanionStorageCommand, { type: 'activity.social.bind_peer_port' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT companion_id,status,data FROM companion_social_outbox WHERE client_id=?').get(input.deliveryClientId) as { companion_id: string; status: string; data: string } | undefined;
      const sent = row ? JSON.parse(row.data) as { companionId: string; conversationId: string; topicId?: string | null;
        agentSource?: { conversationId: string; messageId: string } } : undefined;
      const missing = { ok: true, error: '当前新话题没有唯一、有效且仍在进行的原玩家任务出处；未绑定持续目标。' };
      if (!row || !sent || row.companion_id !== input.companionId || sent.companionId !== input.companionId
        || !['pending', 'sent'].includes(row.status) || !sent.topicId || sent.agentSource?.conversationId !== input.conversationId
        || sent.agentSource.messageId !== input.sourceMessageId) return missing;
      const origins = this.peerGoalOrigins(input.companionId, input.conversationId, input.sourceMessageId);
      const keys = new Set(origins.map(origin => origin.conversationId + '/' + origin.sourceMessageId));
      if (keys.size !== 1) return missing;
      const origin = origins[0]!;
      const tasks = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? AND source_message_id=? AND status IN('queued','running','waiting')")
        .all(input.companionId, origin.conversationId, origin.sourceMessageId) as Row[];
      if (tasks.length !== 1) return missing;
      const task = JSON.parse(tasks[0]!.data) as Stored;
      if (!this.valid(task)) return missing;
      if (task.gamePort && (task.gamePort.conversationId !== sent.conversationId || task.gamePort.topicId !== sent.topicId)) {
        const previous = this.topicExecute?.({ type: 'topic.read', conversationId: task.gamePort.conversationId,
          topicId: task.gamePort.topicId, readerId: task.companionId })?.topic;
        if (!previous || previous.deletedAt || previous.status !== 'closed') return missing;
      }
      this.bindGamePort(task, input.deliveryClientId, sent.conversationId, sent.topicId, origin.id);
      if (!task.gamePort || task.gamePort.deliveryClientId !== input.deliveryClientId) return missing;
      const peer = this.visible(input, [input.sourceMessageId])[0]!;
      if (!task.evidence?.some(item => item.id === peer.id)) (task.evidence ??= []).push({ id: peer.id, conversationId: peer.conversationId, checksum: checksum(peer) });
      if (!(task.seededSocialClientIds ??= []).includes(input.deliveryClientId)) task.seededSocialClientIds.push(input.deliveryClientId);
      task.peerConversationId = sent.conversationId; task.peerTopicId = sent.topicId;
      task.stage = '本人的真实原目标通信产生了游戏端口，已关联回同一持续目标；仍须依据真实加入和回执推进。';
      this.save(task); return { ok: true, activityTask: this.public(task) };
    }).immediate();
  }
  private portCandidate(task: Stored) {
    return task.sourceMessageId && !task.peerResponsibility ? findCompanionActivityPortCandidate(this.db, this.social, this.visible,
      { companionId: task.companionId, conversationId: task.conversationId, sourceMessageId: task.sourceMessageId }) : undefined;
  }
  private adoptCandidate(input: Extract<CompanionStorageCommand, { type: 'activity.port.adopt_candidate' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const candidate = findJoinedCompanionActivityPortCandidate(this.db, this.social, this.visible, input);
      if (!candidate) return { ok: true };
      const rows = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? AND source_message_id=? AND status IN('queued','running','waiting')")
        .all(input.companionId, candidate.rootConversationId, candidate.rootSourceMessageId) as Row[];
      if (rows.length !== 1) return { ok: true };
      const task = JSON.parse(rows[0]!.data) as Stored;
      if (!this.valid(task) || task.sourceChecksum !== candidate.rootSourceChecksum) return { ok: true };
      if (task.gamePort && (task.gamePort.conversationId !== input.conversationId || task.gamePort.topicId !== input.topicId)) {
        const previous = this.topicExecute?.({ type: 'topic.read', readerId: task.companionId,
          conversationId: task.gamePort.conversationId, topicId: task.gamePort.topicId })?.topic;
        if (!previous || previous.deletedAt || previous.status !== 'closed') return { ok: true };
      }
      task.gamePort = { conversationId: candidate.conversationId, topicId: candidate.topicId,
        deliveryClientId: candidate.deliveryClientId, delegatedCandidateId: candidate.id };
      if (!this.gamePortValid(task)) throw new Error('原目标候选端口的真实来源已变化，未采纳。');
      task.peerConversationId = candidate.conversationId; task.peerTopicId = candidate.topicId;
      task.targetId ??= candidate.memberIds.find(id => id !== task.companionId);
      this.save(task); return { ok: true, activityTask: this.public(task) };
    }).immediate();
  }
  private finish(task: Stored, status: 'succeeded' | 'failed' | 'cancelled', summary: string): void {
    this.chargePlanning(task);
    if (status !== 'succeeded' && task.wait?.kind === 'arrival' && task.condition) this.world.stopTaskMovement(task, task.condition, task.id);
    if (status === 'succeeded' && task.visitTargetId && task.visitArrivedAt && task.visitInteractionAt) {
      const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId);
      const target = this.db.prepare("SELECT json_extract(data,'$.name') AS name FROM companions WHERE id=?").get(task.visitTargetId) as { name: string } | undefined;
      summary = `已经到过${target?.name ?? '对方'}的小屋，并完成了双方当面交流。`;
      if (self && self.sceneId === self.homeSceneId) summary += '现在已经回到自己的小屋。';
      else if (world.scenes.some(scene => scene.id === self?.sceneId && scene.ownerId === task.visitTargetId)) summary += '现在仍在对方的小屋。';
    }
    task.status = status; task.stage = summary; delete task.wait; delete task.condition; delete task.leaseToken; delete task.leaseUntil; delete task.deferredDecision;
    task.reportPending = !!task.sourceMessageId && this.valid(task); task.nextAt = Date.now();
    if (status !== 'cancelled' && task.sourceMessageId && this.valid(task)
      && task.history.some(item => item.ok && !item.action.startsWith('memory.') && item.action !== 'observe')) this.experienced(task, task.sourceMessageId);
    this.save(task); this.flushReports();
  }
  /** This is a read gate for the current exact human source, not an alternate
   * planner or an effect replay. Only a recorded social client identity can
   * identify an already dispatched effect; argument similarity proves none. */
  private handoff(input: Extract<CompanionStorageCommand, { type: 'activity.handoff' }>): CompanionStorageResponse {
    const missing = { ok: true };
    try {
      if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1").get(input.companionId)) return missing;
      const source = this.visible(input, [input.sourceMessageId]).find(message => message.id === input.sourceMessageId && message.conversationId === input.conversationId);
      if (!source || source.authorId !== 'user' || source.status !== 'sent' || source.isReplyDraft || source.replyDraft || checksum(source) !== input.sourceChecksum) return missing;
      const tasks = (this.db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? AND source_message_id=? AND status IN('queued','running','waiting')")
        .all(input.companionId, input.conversationId, source.id) as Row[]).map(row => JSON.parse(row.data) as Stored)
        .filter(task => task.companionId === input.companionId && task.conversationId === input.conversationId && task.sourceMessageId === source.id
          && ['queued', 'running', 'waiting'].includes(task.status) && task.sourceChecksum === input.sourceChecksum && this.valid(task));
      if (tasks.length !== 1) return missing;
      const task = tasks[0]!, published = this.public(task);
      if (!published.historyAvailable) return missing;
      return { ok: true, activityHandoff: { task: published, existingEffect: !!input.clientId && this.handoffEffect(task, source, input.clientId),
        executor: 'background_activity', newVirtualActionDispatched: false, notice: COMPANION_ACTIVITY_HANDOFF_NOTICE } };
    } catch { return missing; }
  }
  private handoffEffect(task: Stored, original: CompanionMessage, clientId: string): boolean {
    if (!task.seededSocialClientIds?.includes(clientId)) return false;
    const row = this.db.prepare('SELECT companion_id,conversation_id,status,message_id,data FROM companion_social_outbox WHERE client_id=?').get(clientId) as
      { companion_id: string; conversation_id: string; status: string; message_id?: string; data: string } | undefined;
    if (!row || row.companion_id !== task.companionId || !['pending', 'sent'].includes(row.status)) return false;
    const sent = JSON.parse(row.data) as { companionId: string; conversationId: string; content: string; topicId?: string | null;
      authorizationMessageId?: string; sourceMessageId?: string; agentSource?: { conversationId: string; messageId: string };
      authorizationChecksum?: string; sourceChecksum?: string; agentChecksum?: string };
    if (sent.companionId !== task.companionId || row.conversation_id !== sent.conversationId
      || !this.db.prepare('SELECT 1 FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=? AND m.companion_id=? AND c.dissolved_at IS NULL').get(sent.conversationId, task.companionId)) return false;
    const digest = (message: CompanionMessage) => createHash('sha256').update(JSON.stringify([message.id, message.conversationId, message.topicId, message.authorId, message.content, message.status, message.replyToId])).digest('hex');
    const read = (room: string, id: string, expected?: string) => {
      const source = this.visible({ companionId: task.companionId, conversationId: room }, [id]).find(message => message.id === id && message.conversationId === room);
      return source && digest(source) === expected ? source : undefined;
    };
    const authorization = sent.authorizationMessageId ? read(original.conversationId, sent.authorizationMessageId, sent.authorizationChecksum) : undefined;
    const peer = sent.sourceMessageId ? read(sent.conversationId, sent.sourceMessageId, sent.sourceChecksum) : undefined;
    const agent = sent.agentSource ? read(sent.agentSource.conversationId, sent.agentSource.messageId, sent.agentChecksum) : undefined;
    if (sent.authorizationMessageId && (!authorization || authorization.authorId !== 'user' || authorization.id !== original.id)
      || sent.sourceMessageId && (!peer || peer.authorId === 'user' || peer.authorId === 'system') || sent.agentSource && !agent) return false;
    const causal = agent ?? authorization ?? peer;
    const goal = causal ? companionSocialGoalOrigin(this.db, this.social, this.visible, task.companionId, causal) : undefined;
    if (!goal || goal.conversationId !== original.conversationId || goal.sourceMessageId !== original.id || goal.checksum !== checksum(original)) return false;
    if (row.status === 'sent') {
      const message = row.message_id ? this.visible({ companionId: task.companionId, conversationId: sent.conversationId }, [row.message_id])[0] : undefined;
      if (!message || message.id !== row.message_id || message.authorId !== task.companionId || message.conversationId !== sent.conversationId
        || (message.topicId ?? null) !== (sent.topicId ?? null) || message.content !== sent.content) return false;
    }
    return true;
  }
  private flushReports(): void {
    const rows = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE report_pending=1 AND next_at<=? ORDER BY next_at,id LIMIT 16').all(Date.now()) as Row[];
    for (const row of rows) {
      const task = JSON.parse(row.data) as Stored;
      if (!this.valid(task)) { task.reportPending = false; this.save(task); continue; }
      this.world.snapshot(task);
      if (!this.world.socialAvailable(task.companionId, 'phone', []) || companionPlayerPhoneBusy(this.db, task.companionId)) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
      // A model's reviewed prose still needs Main's current async context/file
      // validation after an offline or phone wait. Fixed host statuses below
      // do not certify model prose and require no model inference.
      if (task.reportReadset) continue;
      // Model prose is published only with its actual reviewed input closure.
      // A legacy/unreviewed terminal checkpoint gets a truthful host status,
      // never retrospective certification of its old narrative.
      const description = task.reportReadset ? task.stage : task.status === 'succeeded' ? '这条任务记录已结束，实际结果尚未核验。'
        : task.status === 'cancelled' ? '这项持续任务已取消，停止后续步骤；已发生的实际行为保留。' : '这项持续任务未完成，已停止自动后续步骤；已发生的实际行为保留。';
      const readset = this.reportEvidence(task, task.reportReadset);
      this.append({ conversationId: task.conversationId, authorId: task.companionId,
        ...(task.peerResponsibility && task.sourceMessageId ? { topicId: this.visible(task, [task.sourceMessageId])[0]?.topicId ?? null } : {}),
        content: `持续任务 · ${task.status === 'succeeded' ? task.reportReadset ? '已完成' : '记录已结束' : task.status === 'cancelled' ? '已取消' : '暂时受阻'}\n\n${description}`,
        executionReadset: readset,
        clientId: 'activity_result_' + task.id + (task.reportVersion ? '_resumed_' + task.reportVersion : ''), replyToId: task.sourceMessageId, replyDirective: 'none' });
      task.reportPending = false; this.save(task);
    }
  }
  private reportEvidence(task: Stored, provided?: CompanionExecutionReadset): CompanionExecutionReadset {
    const base = provided ? companionExecutionReadsetSchema.parse(provided) : { schema: 'worldlinebox.companion-execution-readset-v1' as const,
      companionId: task.companionId, conversationId: task.conversationId, complete: true, sources: [], memories: [], contexts: [], topics: [], knowledgeReads: [] };
    if (!base.complete || base.companionId !== task.companionId || base.conversationId !== task.conversationId) throw new Error('行动报告的执行读集归属不完整。');
    const sources = new Map<string, CompanionExecutionReadset['sources'][number]>();
    for (const source of base.sources) {
      const previous = sources.get(source.id);
      if (previous && (previous.checksum !== source.checksum || previous.conversationId !== source.conversationId)) throw new Error('行动报告读集包含同一来源的冲突版本。');
      sources.set(source.id, source);
    }
    for (const source of [...task.evidence ?? [], ...(task.sourceMessageId ? [{ id: task.sourceMessageId, conversationId: task.conversationId, checksum: task.sourceChecksum! }] : [])]) {
      const previous = sources.get(source.id);
      if (previous && (previous.checksum !== source.checksum || previous.conversationId !== source.conversationId)) throw new Error('行动报告所读来源已有冲突版本，未发布。');
      sources.set(source.id, source);
    }
    return companionExecutionReadsetSchema.parse({ ...base, sources: [...sources.values()],
      memories: [...new Map([...base.memories, ...task.memoryVersions ?? []].map(note => [JSON.stringify(note), note])).values()],
      topics: [...new Map([...base.topics, ...(task.topicEvidence ?? []).map(item => ({ conversationId: item.conversationId, topicId: item.topicId,
        checkpointEventIds: [item.eventId], sourceMessageIds: [] }))].map(topic => [JSON.stringify(topic), topic])).values()] });
  }
  private bindExecutionEvidence(task: Stored, value: CompanionExecutionReadset): CompanionExecutionReadset {
    const proof = this.reportEvidence(task, value);
    task.evidence = proof.sources;
    task.memoryVersions = proof.memories;
    task.topicEvidence = [...new Map([...(task.topicEvidence ?? []), ...proof.topics.flatMap(topic => topic.checkpointEventIds.map(eventId => ({
      conversationId: topic.conversationId, topicId: topic.topicId, eventId })))].map(item => [JSON.stringify(item), item])).values()];
    task.executionKnowledgeReads = [...new Map([...(task.executionKnowledgeReads ?? []), ...proof.knowledgeReads].map(read => [JSON.stringify(read), read])).values()];
    if (!this.valid(task)) throw new Error('行动提案的真实来源在提交前已经变化，未执行或发布旧提案。');
    return proof;
  }
  /** Storage-only admission for a tool-less DSH analysis of this exact live
   * activity. A peer/self goal has no invented human message. */
  prepareThought(command: Extract<CompanionStorageCommand, { type: 'activity.thought.create' }>): {
    authorization: CompanionActivityThoughtAuthorization; executionReadset: CompanionExecutionReadset; sourceMessageId?: string;
  } {
    const task = this.leased(command.taskId, command.leaseToken);
    const authorization: CompanionActivityThoughtAuthorization = { taskId: task.id, companionId: task.companionId,
      conversationId: task.conversationId, step: command.expectedStep, effectId: command.effectId,
      leaseToken: command.leaseToken, observationFingerprint: command.observationFingerprint };
    if (!this.thoughtValid(authorization, 'execute')) throw new Error('持续活动的步骤、租约或实际观察已变化，未委托旧思考。');
    const executionReadset = this.bindExecutionEvidence(task, command.executionReadset);
    this.save(task);
    return { authorization, executionReadset, ...(task.sourceMessageId ? { sourceMessageId: task.sourceMessageId } : {}) };
  }
  thoughtValid(authorization: CompanionActivityThoughtAuthorization, mode: 'execute' | 'read', renew = false): boolean {
    const found = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(authorization.taskId) as Row | undefined;
    if (!found) return false;
    const task = JSON.parse(found.data) as Stored;
    if (task.companionId !== authorization.companionId || task.conversationId !== authorization.conversationId || !this.valid(task)) return false;
    // A later step or an ordinary terminal status does not erase an actual
    // historical analysis. Its captured source/readset is verified by Store.
    if (mode === 'read') return true;
    if (task.status !== 'running' || task.step !== authorization.step || task.leaseToken !== authorization.leaseToken
      || (task.leaseUntil ?? 0) < Date.now() || task.observedSocialEvidence?.leaseToken !== authorization.leaseToken) return false;
    const messages = this.peerMessages(task);
    const observed = messages.map(message => ({ id: message.id, checksum: checksum(message) }));
    const fingerprint = JSON.stringify(messages.map(message => [message.id, message.conversationId, message.sequence, checksum(message)]));
    if (authorization.observationFingerprint !== fingerprint || JSON.stringify(task.observedSocialEvidence.messages) !== JSON.stringify(observed)) return false;
    if (task.sourceMessageId && task.observedProgressEvidence?.leaseToken === authorization.leaseToken
      && task.observedProgressEvidence.observationChecksum !== this.social.continuity.progressForGoal({ ...task, sourceMessageId: task.sourceMessageId }).observationChecksum) return false;
    if (renew) { task.leaseUntil = Date.now() + PLANNING_LEASE_MS; task.nextAt = task.leaseUntil; this.save(task); }
    return true;
  }
  private reportObservation(task: Stored): string {
    return createHash('sha256').update(JSON.stringify({ id: task.id, status: task.status, step: task.step, stage: task.stage,
      version: task.reportVersion, readset: task.reportReadset,
      progress: task.sourceMessageId ? this.social.continuity.progressForGoal({ ...task, sourceMessageId: task.sourceMessageId }).observationChecksum : undefined })).digest('hex');
  }
  private claimReport(excluded: string[], id?: string): CompanionStorageResponse {
    return this.db.transaction(() => {
      this.flushReports();
      for (const row of this.db.prepare('SELECT data FROM companion_activity_tasks WHERE report_pending=1 AND next_at<=? ORDER BY next_at,id LIMIT 16').all(Date.now()) as Row[]) {
        const task = JSON.parse(row.data) as Stored;
        if (!terminal(task) || !task.reportReadset || id && task.id !== id || excluded.includes(task.companionId) || (task.reportLeaseUntil ?? 0) > Date.now()) continue;
        if (!this.valid(task)) { task.reportPending = false; delete task.reportLeaseToken; delete task.reportLeaseUntil; this.save(task); continue; }
        if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND json_extract(data,'$.active')=1").get(task.companionId)
          || !this.world.socialAvailable(task.companionId, 'phone', []) || companionPlayerPhoneBusy(this.db, task.companionId) || this.peerBusy(task.companionId)) continue;
        task.reportLeaseToken = randomUUID(); task.reportLeaseUntil = Date.now() + PLANNING_LEASE_MS;
        task.reportObservation = this.reportObservation(task); task.reportAttempts = (task.reportAttempts ?? 0) + 1; this.save(task);
        return { ok: true, activityTask: this.public(task), activityReport: { id: task.id, leaseToken: task.reportLeaseToken, executionReadset: task.reportReadset },
          activityProgressEvidence: this.social.continuity.progressForGoal({ ...task, sourceMessageId: task.sourceMessageId! }),
          activityMessages: this.peerMessages(task).slice(-100) };
      }
      return { ok: true };
    }).immediate();
  }
  private completeReport(input: Extract<CompanionStorageCommand, { type: 'activity.report.complete' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const task = this.get(input.id), clientId = 'activity_result_' + task.id + (task.reportVersion ? '_resumed_' + task.reportVersion : '');
      if (!task.reportPending) {
        const message = this.db.prepare('SELECT id FROM messages WHERE client_id=?').get(clientId) as { id: string } | undefined;
        return { ok: true, ...(message ? { message: this.visible(task, [message.id])[0] } : {}) };
      }
      if (!terminal(task) || !task.reportReadset || task.reportLeaseToken !== input.leaseToken || (task.reportLeaseUntil ?? 0) < Date.now() || !this.valid(task))
        throw new Error('行动报告的来源、终态或租约已经变化。');
      if (this.reportObservation(task) !== task.reportObservation || !this.world.socialAvailable(task.companionId, 'phone', [])
        || companionPlayerPhoneBusy(this.db, task.companionId) || this.peerBusy(task.companionId)) {
        delete task.reportLeaseToken; delete task.reportLeaseUntil; task.nextAt = Date.now() + 1500; this.save(task); return { ok: true, socialPending: true };
      }
      for (const key of ['sources', 'memories', 'contexts', 'topics', 'knowledgeReads'] as const) {
        const actual = new Set(input.executionReadset[key].map(item => JSON.stringify(item)));
        if (task.reportReadset[key].some(item => !actual.has(JSON.stringify(item)))) throw new Error('行动报告不得丢弃此前实际使用的执行依赖。');
      }
      task.reportReadset = this.bindExecutionEvidence(task, input.executionReadset);
      const message = this.append({ conversationId: task.conversationId, authorId: task.companionId,
        ...(task.peerResponsibility && task.sourceMessageId ? { topicId: this.visible(task, [task.sourceMessageId])[0]?.topicId ?? null } : {}),
        content: `持续任务 · ${task.status === 'succeeded' ? '已完成' : task.status === 'cancelled' ? '已取消' : '暂时受阻'}\n\n${task.stage}`,
        executionReadset: task.reportReadset, clientId, replyToId: task.sourceMessageId, replyDirective: 'none' }) as CompanionMessage;
      task.reportPending = false; delete task.reportLeaseToken; delete task.reportLeaseUntil; this.save(task); return { ok: true, message };
    }).immediate();
  }
  private failReport(input: Extract<CompanionStorageCommand, { type: 'activity.report.fail' }>): void {
    this.db.transaction(() => {
      const task = this.get(input.id);
      if (!task.reportPending || task.reportLeaseToken !== input.leaseToken) return;
      task.reportError = input.error;
      delete task.reportLeaseToken; delete task.reportLeaseUntil;
      if (input.terminal || (task.reportAttempts ?? 0) >= 3) { task.reportRejected = true; delete task.reportReadset; task.nextAt = Date.now(); }
      else task.nextAt = Date.now() + 10000 * (task.reportAttempts ?? 1);
      this.save(task); this.flushReports();
    }).immediate();
  }
  start(input: Extract<CompanionStorageCommand, { type: 'activity.start' }>): CompanionActivityTask {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE client_id=?').get(input.clientId) as Row | undefined;
      if (existing) { const task = JSON.parse(existing.data) as Stored; if (task.companionId !== input.companionId || task.conversationId !== input.conversationId || task.goal !== input.goal || task.title !== input.title || task.sourceMessageId !== input.sourceMessageId) throw new Error('行动任务幂等标识冲突。'); return this.public(task); }
      const source = input.sourceMessageId ? this.visible(input, [input.sourceMessageId])[0] : undefined;
      if (input.sourceMessageId && (!source || source.authorId !== 'user')) throw new Error('行动委托来源不可访问。');
      if (source) {
        const visit = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id=? AND json_extract(data,'$.visitTargetId') IS NOT NULL ORDER BY rowid LIMIT 1").get(input.companionId, source.id) as Row | undefined;
        if (visit) return this.public(JSON.parse(visit.data) as Stored);
      }
      if (!input.sourceMessageId && input.conversationId !== 'world_' + input.companionId) throw new Error('自主行动只能属于自己的世界认知会话。');
      if (Number((this.db.prepare("SELECT count(*) AS n FROM companion_activity_tasks WHERE companion_id=? AND status IN('queued','running','waiting')").get(input.companionId) as { n: number }).n) >= 3) throw new Error('已有三份未完成行动任务，请先完成或取消。');
      const world = this.world.snapshot(input);
      const day = companionTimeInZone(Date.parse(world.clock.virtualNow), world.settings.timeZone), worldDay = `${day.year}-${day.month}-${day.day}`;
      if (!input.sourceMessageId) {
        const count = this.db.prepare("SELECT count(*) AS n FROM companion_activity_tasks WHERE companion_id=? AND source_message_id IS NULL AND json_extract(data,'$.worldDay')=?").get(input.companionId, worldDay) as { n: number };
        const last = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id IS NULL ORDER BY rowid DESC LIMIT 1').get(input.companionId) as Row | undefined;
        const previous = last ? JSON.parse(last.data) as Stored : undefined;
        if (count.n >= 2 || previous && (Date.now() - Date.parse(previous.createdAt) < 120_000 || Date.parse(world.clock.virtualNow) - (previous.createdVirtualAt ?? 0) < 6 * 3600_000)) throw new Error('主动行动已达到每日两次或六世界小时/120现实秒冷却上限。');
      }
      const task: Stored = { id: randomUUID(), ...input, status: 'queued', step: 0, attempts: 0, createdAt: iso(), updatedAt: iso(),
        deadline: iso(Date.now() + 3600_000), stage: '等待行动规划', history: [], nextAt: Date.now(), worldDay, createdVirtualAt: Date.parse(world.clock.virtualNow), ...(source ? { sourceChecksum: checksum(source) } : {}) };
      this.db.prepare('INSERT INTO companion_activity_tasks(id,companion_id,conversation_id,source_message_id,status,next_at,client_id,data) VALUES(?,?,?,?,?,?,?,?)').run(task.id, task.companionId, task.conversationId, task.sourceMessageId ?? null, task.status, task.nextAt, task.clientId, JSON.stringify(task));
      return this.public(task);
    }).immediate();
  }
  /** Only social.complete calls this inside its transaction, with the exact
   * running peer job. Its accepted marker is committed with the real reply;
   * public activity.start continues to require the original human source. */
  acceptPeerResponsibility(input: { companionId: string; conversationId: string; sourceMessageId: string; title: string;
    instruction: string; clientId: string; jobId: string; publisherId: string; leaseToken: string }): CompanionActivityTask {
    return this.db.transaction(() => {
      const source = this.visible(input, [input.sourceMessageId])[0];
      if (!source || source.authorId !== input.publisherId || ['user', 'system', input.companionId].includes(source.authorId)
        || source.status !== 'sent' || source.isReplyDraft || source.replyDraft) throw new Error('持续责任缺少当前真实伙伴来信。');
      const prior = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE client_id=?').get(input.clientId) as Row | undefined;
      if (prior) {
        const task = JSON.parse(prior.data) as Stored;
        if (task.companionId !== input.companionId || task.conversationId !== input.conversationId || task.sourceMessageId !== input.sourceMessageId
          || task.title !== input.title || task.goal !== input.instruction || task.peerResponsibility?.jobId !== input.jobId
          || task.peerResponsibility.publisherId !== input.publisherId) throw new Error('伙伴持续责任幂等标识冲突。');
        return this.public(task);
      }
      if (Number((this.db.prepare("SELECT count(*) AS n FROM companion_activity_tasks WHERE companion_id=? AND status IN('queued','running','waiting')")
        .get(input.companionId) as { n: number }).n) >= 3) throw new Error('已有三份未完成行动任务，请先完成或取消。');
      const task: Stored = { id: randomUUID(), companionId: input.companionId, conversationId: input.conversationId,
        sourceMessageId: source.id, sourceChecksum: checksum(source), clientId: input.clientId, title: input.title, goal: input.instruction,
        peerResponsibility: { jobId: input.jobId, publisherId: input.publisherId }, status: 'queued', step: 0, attempts: 0,
        createdAt: iso(), updatedAt: iso(), deadline: iso(Date.now() + 3600_000), nextAt: Date.now(), history: [],
        targetId: input.publisherId, peerConversationId: source.conversationId, peerTopicId: source.topicId ?? null,
        evidence: [{ id: source.id, conversationId: source.conversationId, checksum: checksum(source) }], stage: '已明确接受伙伴持续责任，等待本人下一步行动。' };
      activityTaskSchema.parse(task);
      if (!companionPeerActivitySourceValid(this.db, this.visible, task, { leaseToken: input.leaseToken })) throw new Error('伙伴持续责任的当前读取、任务归属或实际执行租约已经失效。');
      this.db.prepare('INSERT INTO companion_activity_tasks(id,companion_id,conversation_id,source_message_id,status,next_at,client_id,data) VALUES(?,?,?,?,?,?,?,?)')
        .run(task.id, task.companionId, task.conversationId, source.id, task.status, task.nextAt, task.clientId, JSON.stringify(task));
      return activityTaskSchema.parse(task);
    }).immediate();
  }
  private boundPort(task: Stored): { conversationId: string; topicId: string } | undefined {
    if (task.gamePort) return task.gamePort;
    if (!task.peerResponsibility || !task.sourceMessageId) return;
    const source = this.visible(task, [task.sourceMessageId])[0];
    return source?.topicId ? { conversationId: source.conversationId, topicId: source.topicId } : undefined;
  }
  private peerMessages(task: Stored): CompanionMessage[] {
    const port = this.boundPort(task);
    if (!task.targetId && !port) return [];
    const group = task.targetId && task.peerConversationId && this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(task.peerConversationId, task.targetId);
    const conversationId = port?.conversationId ?? (group ? task.peerConversationId! : this.social.ensure(task.companionId, [task.companionId, task.targetId!]).id);
    const topicId = port?.topicId ?? task.peerTopicId;
    const ids = (this.db.prepare(`SELECT id FROM messages WHERE conversation_id=?${topicId === undefined ? '' : topicId === null
      ? ' AND NOT EXISTS(SELECT 1 FROM companion_message_topics WHERE message_id=messages.id)'
      : ' AND EXISTS(SELECT 1 FROM companion_message_topics WHERE message_id=messages.id AND topic_id=?)'} ORDER BY sequence DESC LIMIT 20`)
      .all(conversationId, ...(topicId ? [topicId] : [])) as { id: string }[]).map(row => row.id);
    // A dedicated game/story port may carry that topic's live flow. An ordinary
    // private room is reusable: only this goal's anchored job chains may cross
    // into task cognition, never that room's unrelated earlier conversation.
    const current = (task.sourceMessageId || task.seededSocialClientIds?.length) && !topicId ? []
      : this.visible({ companionId: task.companionId, conversationId }, ids).reverse();
    return [...new Map([...this.goalSocialMessages(task).messages, ...current].map(message => [message.id, message])).values()]
      .sort((a, b) => a.sequence - b.sequence).slice(-100);
  }
  private goalSocialMessages(task: Stored): { messages: CompanionMessage[]; origins: GoalSocialOrigin[] } {
    const messages = new Map<string, CompanionMessage>(), origins = new Map<string, GoalSocialOrigin>();
    for (const clientId of task.seededSocialClientIds ?? []) {
      const value = this.db.prepare("SELECT message_id,data FROM companion_social_outbox WHERE client_id=? AND companion_id=? AND status='sent'").get(clientId, task.companionId) as { message_id: string; data: string } | undefined;
      if (!value) continue;
      const sent = JSON.parse(value.data) as { conversationId: string; authorizationMessageId?: string; agentSource?: { messageId: string; conversationId: string }; topicId?: string | null };
      if (task.sourceMessageId ? !(sent.authorizationMessageId === task.sourceMessageId || sent.agentSource?.messageId === task.sourceMessageId && sent.agentSource.conversationId === task.conversationId
        || task.gamePort?.deliveryClientId === clientId && task.gamePort.topicId === sent.topicId && task.gamePort.conversationId === sent.conversationId && this.gamePortValid(task))
        : !clientId.startsWith(`activity_${task.id}_`)) continue;
      const source = this.visible({ companionId: task.companionId, conversationId: sent.conversationId }, [value.message_id])[0];
      if (!source || source.authorId !== task.companionId || (source.topicId ?? null) !== (sent.topicId ?? null)) continue;
      const chains = (this.db.prepare("SELECT DISTINCT json_extract(data,'$.chainId') AS id FROM companion_social_jobs WHERE conversation_id=? AND json_extract(data,'$.sourceMessageId')=?").all(sent.conversationId, source.id) as Array<{ id: string }>).map(row => row.id);
      if (!chains.length) continue;
      const replies = this.db.prepare(`SELECT json_extract(data,'$.resultMessageId') AS id,json_extract(data,'$.chainId') AS chain_id FROM companion_social_jobs WHERE conversation_id=? AND companion_id!=? AND status='done' AND json_extract(data,'$.chainId') IN(${chains.map(() => '?').join(',')}) AND json_extract(data,'$.resultMessageId') IS NOT NULL ORDER BY created_at,id LIMIT 80`)
        .all(sent.conversationId, task.companionId, ...chains) as Array<{ id: string; chain_id: string }>;
      const visible = this.visible({ companionId: task.companionId, conversationId: sent.conversationId }, replies.map(row => row.id))
        .filter(message => message.status === 'sent' && !message.isReplyDraft && message.authorId !== task.companionId && message.sequence > source.sequence && (message.topicId ?? null) === (sent.topicId ?? null));
      const byAuthor = new Map<string, CompanionMessage[]>();
      for (const reply of visible) { const own = byAuthor.get(reply.authorId) ?? []; own.push(reply); byAuthor.set(reply.authorId, own); }
      for (const own of byAuthor.values()) for (const reply of [own[0]!, own.at(-1)!]) {
        messages.set(reply.id, reply); origins.set(reply.id, { messageId: reply.id, sourceMessageId: source.id, deliveryClientId: clientId,
          conversationId: sent.conversationId, ...(reply.topicId ? { topicId: reply.topicId } : {}), chainId: replies.find(row => row.id === reply.id)!.chain_id });
      }
    }
    return { messages: [...messages.values()], origins: [...origins.values()] };
  }
  private matchingPeerRoom(task: Stored, recipients: string[]): string | undefined {
    if (!task.peerConversationId || !this.db.prepare('SELECT 1 FROM companion_social_conversations s JOIN conversations c ON c.id=s.id WHERE s.id=? AND c.dissolved_at IS NULL').get(task.peerConversationId)) return;
    const members = (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(task.peerConversationId) as Array<{ companion_id: string }>).map(row => row.companion_id);
    return JSON.stringify(members) === JSON.stringify([task.companionId, ...recipients].sort()) ? task.peerConversationId : undefined;
  }
  /** A chat-issued movement is the first step of the original request, not its
   * completion. Persist the effect and its arrival predicate in one transaction
   * so closing/retrying the chat cannot strand it or restart the same route. */
  private ensureMotion(input: Extract<CompanionStorageCommand, { type: 'activity.motion.ensure' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const source = this.visible(input, [input.sourceMessageId])[0];
      if (!source || source.authorId !== 'user') throw new Error('移动后继续处理需要本轮真实玩家消息。');
      const prior = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? AND source_message_id=? ORDER BY rowid LIMIT 1')
        .get(input.companionId, input.conversationId, source.id) as Row | undefined;
      if (prior) {
        const task = JSON.parse(prior.data) as Stored;
        if (!this.valid(task)) throw new Error('原行动来源已更新或撤回。');
        return { ok: true, activityTask: this.public(task), world: this.world.snapshot(task) };
      }
      const created = this.start({ type: 'activity.start', companionId: input.companionId, conversationId: input.conversationId,
        sourceMessageId: source.id, clientId: 'motion_' + createHash('sha256').update(input.companionId + ':' + source.id).digest('hex'),
        title: '虚拟世界行动', goal: source.content });
      const task = this.get(created.id);
      task.status = 'running'; task.leaseToken = randomUUID(); task.leaseUntil = Date.now() + PLANNING_LEASE_MS;
      this.save(task);
      const result = this.commit(task.id, task.leaseToken, { status: 'continue', action: input.arguments,
        wait: { kind: 'arrival' }, summary: '实际到达后继续原请求，重新观察并反馈结果。' }, true);
      return { ok: true, activityTask: result, world: this.world.snapshot(task) };
    }).immediate();
  }
  private noteArrival(task: Stored, present: CompanionWorldSnapshot): void {
    const self = present.actors.find(actor => actor.companionId === task.companionId);
    if (task.visitTargetId && self && !self.travel && !self.route.length && present.scenes.some(scene => scene.id === self.sceneId && scene.ownerId === task.visitTargetId)) task.visitArrivedAt ??= iso();
    if (task.visitArrivedAt && task.visitTargetId && task.peerConversationId && !task.visitInteractionAt) {
      const authors = this.db.prepare("SELECT DISTINCT m.author_id FROM companion_social_messages s JOIN messages m ON m.id=s.message_id WHERE s.conversation_id=? AND s.channel='face_to_face' AND m.created_at>=? AND m.status='sent'").all(task.peerConversationId, task.visitArrivedAt) as { author_id: string }[];
      if ([task.companionId, task.visitTargetId].every(id => authors.some(author => author.author_id === id))) task.visitInteractionAt = iso();
    }
  }
  private ensureVisit(input: Extract<CompanionStorageCommand, { type: 'activity.visit.ensure' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const source = this.visible(input, [input.sourceMessageId])[0];
      const target = this.db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(input.targetId) as Row | undefined;
      if (!source || source.authorId !== 'user' || source.conversationId !== input.conversationId || !target || input.targetId === input.companionId) throw new Error('拜访需要真实原委托和有效的另一位伙伴。');
      const clientId = 'visit_' + createHash('sha256').update(input.companionId + ':' + source.id + ':' + input.targetId).digest('hex');
      const existing = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE client_id=? OR (companion_id=? AND source_message_id=? AND json_extract(data,'$.visitTargetId')=?) ORDER BY rowid LIMIT 1")
        .get(clientId, input.companionId, source.id, input.targetId) as Row | undefined;
      if (existing) return { ok: true, activityTask: this.public(JSON.parse(existing.data) as Stored) };
      const prior = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id=? AND status IN('queued','running','waiting') ORDER BY rowid LIMIT 1").get(input.companionId, source.id) as Row | undefined;
      const created = prior ? JSON.parse(prior.data) as Stored : this.get(this.start({ type: 'activity.start', companionId: input.companionId,
        conversationId: input.conversationId, sourceMessageId: source.id, clientId, title: '拜访' + (JSON.parse(target.data) as { name: string }).name, goal: source.content }).id);
      if (created.visitTargetId && created.visitTargetId !== input.targetId) throw new Error('这次委托已经绑定了另一份拜访目标。');
      created.visitTargetId = input.targetId; created.targetId = input.targetId;
      created.peerConversationId = this.social.ensure(input.companionId, [input.companionId, input.targetId]).id;
      let sent: CompanionStorageResponse = { ok: true };
      if (input.initialMessage && !prior) {
        this.social.continuity.record({ type: 'social.delegation.record', companionId: input.companionId, conversationId: input.conversationId,
          sourceMessageId: source.id, recipientIds: [input.targetId], sharedText: input.initialMessage.text, intent: 'visit' });
        sent = this.social.send({ companionId: input.companionId, conversationId: created.peerConversationId, content: input.initialMessage.text,
          channel: 'phone', urgent: input.initialMessage.urgent, authorizationMessageId: source.id, clientId: input.initialMessage.clientId });
        (created.seededSocialClientIds ??= []).push(input.initialMessage.clientId);
        created.step++; created.history.push({ step: created.step, at: iso(), action: 'message', arguments: { action: 'message', recipientIds: [input.targetId], text: input.initialMessage.text },
          ok: true, result: '必要问候已进入真实手机发件队列，待对方回应后继续拜访；排队不代表已送达、获准或抵达。' });
        created.stage = '已联系对方，持续核对回复、拜访许可与实际到达。';
      }
      this.save(created); return { ...sent, activityTask: this.public(created) };
    }).immediate();
  }
  private ensureSocial(input: Extract<CompanionStorageCommand, { type: 'activity.social.ensure' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const source = this.visible(input, [input.sourceMessageId])[0];
      if (!source || source.authorId !== 'user' || source.conversationId !== input.conversationId || source.isReplyDraft) throw new Error('持续社交需要本次真实、仍然可见的用户目标。');
      const outbox = this.db.prepare('SELECT companion_id,conversation_id,status,message_id,data FROM companion_social_outbox WHERE client_id=?').get(input.deliveryClientId) as {
        companion_id: string; conversation_id: string; status: string; message_id: string | null; data: string;
      } | undefined;
      const sent = outbox ? JSON.parse(outbox.data) as { companionId: string; conversationId: string; content: string;
        authorizationMessageId?: string; agentSource?: { conversationId: string; messageId: string }; topicId?: string | null } : undefined;
      const creator = sent?.agentSource ? this.visible({ companionId: input.companionId, conversationId: sent.agentSource.conversationId }, [sent.agentSource.messageId])[0] : undefined;
      const peerGoal = creator && creator.authorId !== 'user' ? companionSocialGoalOrigin(this.db, this.social, this.visible,
        input.companionId, creator) : undefined;
      const samePeerGoal = peerGoal?.sourceMessageId === source.id && peerGoal.conversationId === source.conversationId;
      if (!outbox || !sent || outbox.companion_id !== input.companionId || sent.companionId !== input.companionId || outbox.conversation_id !== sent.conversationId
        || !['pending', 'sent'].includes(outbox.status) || !(sent.authorizationMessageId === source.id
          || sent.agentSource?.messageId === source.id && sent.agentSource.conversationId === source.conversationId || samePeerGoal)) throw new Error('持续社交只能承接本次真实出站消息，不能伪造回执或借用别人的邀约。');
      const members = (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id').all(sent.conversationId) as Array<{ companion_id: string }>).map(value => value.companion_id);
      const recipients = members.filter(id => id !== input.companionId);
      if (!members.includes(input.companionId) || !recipients.length || input.operation === 'introduce' && recipients.length !== 1
        || input.operation === 'create_group' && recipients.length < 2) throw new Error('实际社交会话与这次行为不相符。');
      const previous = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND source_message_id=? ORDER BY rowid LIMIT 1').get(input.companionId, source.id) as Row | undefined;
      const clientId = 'social_continue_' + createHash('sha256').update(input.companionId + ':' + source.id).digest('hex');
      const task = previous ? JSON.parse(previous.data) as Stored : this.get(this.start({ type: 'activity.start', companionId: input.companionId,
        conversationId: input.conversationId, sourceMessageId: source.id, clientId, title: '继续完成社交活动', goal: source.content }).id);
      // A completed/cancelled original goal never resurrects from a late reply.
      if (terminal(task) || task.seededSocialClientIds?.includes(input.deliveryClientId)) return { ok: true, activityTask: this.public(task) };
      const message = outbox.message_id ? this.visible({ companionId: input.companionId, conversationId: sent.conversationId }, [outbox.message_id])[0] : undefined;
      if (outbox.status === 'sent' && !message) throw new Error('已发送的社交来源已经撤回或不可见，不能承接旧回执。');
      task.goal = source.content; task.peerConversationId = sent.conversationId; task.peerTopicId = sent.topicId ?? null; task.targetId = recipients[0];
      this.bindGamePort(task, input.deliveryClientId, sent.conversationId, sent.topicId, samePeerGoal ? peerGoal?.originId : undefined);
      const result = { ok: true, socialConversation: { id: sent.conversationId, memberIds: members },
        socialPending: outbox.status === 'pending', ...(message ? { socialMessage: { messageId: message.id, authorId: message.authorId,
          sequence: message.sequence, content: message.content, ...(message.topicId ? { topicId: message.topicId } : {}) } } : {}) };
      task.step++; task.history.push({ step: task.step, at: iso(), action: input.operation, ok: true, result: JSON.stringify(result) });
      (task.seededSocialClientIds ??= []).push(input.deliveryClientId);
      task.stage = '初次社交行动已有真实回执；等待实际回复后继续完成原始完整目标，不重复邀请。';
      if (task.status !== 'running') {
        task.status = 'waiting'; task.wait = { kind: 'reply', targetCompanionId: recipients[0]! };
        task.condition = { until: Date.now() + 300_000, afterSequence: message?.sequence ?? Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM messages').get() as { n: number }).n) };
        task.nextAt = Date.now() + 1500; delete task.leaseToken; delete task.leaseUntil;
      }
      this.save(task); return { ok: true, activityTask: this.public(task) };
    }).immediate();
  }
  private wake(task: Stored): boolean {
    if (!task.wait || !task.condition) return true;
    const world = this.world.snapshot(task), actor = world.actors.find(actor => actor.companionId === task.companionId), wait = task.wait, condition = task.condition;
    let ready: boolean, reason: string;
    if (wait.kind === 'arrival') {
      ready = !!actor && !actor.route.length && !actor.travel && actor.sceneId === condition.sceneId && (condition.x === undefined || Math.hypot(actor.position.x - condition.x, actor.position.y - condition.y!) <= .3);
      reason = '实际抵达目标场景或本地目的地，继续依据当前观察行动。';
    } else if (wait.kind === 'reply') {
      const permission = task.visitTargetId === wait.targetCompanionId && !task.visitArrivedAt && world.visits.find(visit =>
        visit.guestId === task.companionId && visit.hostId === wait.targetCompanionId && visit.id === (condition.visitId ?? task.visitRequestId));
      ready = !!permission && permission.status !== 'requested' || this.peerMessages(task).some(message => (task.seededSocialClientIds?.length
        ? message.authorId !== task.companionId && message.authorId !== 'system' : message.authorId === wait.targetCompanionId) && message.sequence > condition.afterSequence);
      reason = permission && permission.status !== 'requested' ? '拜访许可已有实际结果，不再等待重复的手机确认；核对许可与当前位置后继续。' : '收到目标伙伴的真实新回复。';
    }
    else if (wait.kind === 'permission') { ready = world.visits.some(visit => visit.id === (condition.visitId ?? task.visitRequestId) && visit.guestId === task.companionId && visit.hostId === wait.targetCompanionId && visit.status !== 'requested'); reason = '拜访许可已有实际结果，请核对允许、拒绝或过期。'; }
    else { ready = Date.parse(world.clock.virtualNow) >= condition.virtualAt!; reason = '世界时间等待已结束。'; }
    if (!ready) {
      if (wait.kind === 'delay' || Date.now() < condition.until) return false;
      // A sleeping/dormant/busy peer or an unanswered formal request is an
      // external dependency, not a reason to spend another model planning step.
      if ('targetCompanionId' in wait && (!this.world.socialAvailable(wait.targetCompanionId, 'phone', [])
        || world.visits.some(visit => visit.id === (condition.visitId ?? task.visitRequestId) && visit.status === 'requested'))) {
        condition.until = Date.now() + 300000; return false;
      }
    }
    task.stage = ready ? reason : '等待超时，目标尚未实现；重新观察并决定受阻、等待或其它行动。';
    delete task.wait; delete task.condition; return true;
  }
  private peerBusy(owner: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companion_social_communication WHERE companion_id=? AND until_real>? AND json_extract(data,'$.phase')='typing' UNION ALL SELECT 1 FROM companion_social_notifications WHERE companion_id=? AND status='running' AND lease_until>? LIMIT 1").get(owner, iso(), owner, iso());
  }
  private primaryChatBusy(task: Stored): boolean {
    return !!task.sourceMessageId && !!this.db.prepare("SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status IN('queued','running') AND json_extract(data,'$.sourceMessageId')=? AND json_extract(data,'$.conversationId')=? LIMIT 1")
      .get(task.companionId, task.sourceMessageId, task.conversationId);
  }
  claim(excluded: string[]): CompanionActivityTask | undefined {
    return this.db.transaction(() => {
      this.flushReports();
      // Bounded indexed scan; deferred actors rotate by next_at rather than starving others.
      const candidates = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE status IN('queued','waiting','running') AND next_at<=? ORDER BY next_at,id LIMIT 32").all(Date.now()) as Row[];
      for (const row of candidates) {
        const task = JSON.parse(row.data) as Stored;
        if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND json_extract(data,'$.active')=1").get(task.companionId)) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
        if (excluded.includes(task.companionId) || this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND status IN('queued','running') AND rowid<(SELECT rowid FROM companion_activity_tasks WHERE id=?) LIMIT 1").get(task.companionId, task.id)) { task.nextAt = Date.now() + 2000; this.save(task); continue; }
        if (!this.valid(task)) { this.finish(task, 'cancelled', '来源被撤回、伙伴重置或联系人已移除，停止后续行动。'); continue; }
        if (task.status === 'running' && (task.leaseUntil ?? 0) > Date.now()) continue;
        if (task.status === 'running') this.chargePlanning(task);
        if (task.memoryIntentId) { task.nextAt = Date.now() + 1500; this.save(task); continue; }
        if (task.status === 'waiting' && !this.wake(task)) { task.nextAt = Date.now() + 1500; this.save(task); continue; }
        const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId);
        if (world.backlog || this.primaryChatBusy(task) || this.peerBusy(task.companionId) || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || world.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended')) { task.nextAt = Date.now() + 5000; this.save(task); continue; }
        // A milestone bounds resource use without ending a healthy long goal
        // merely because its lifetime reached 32 planning steps.
        if (task.step - (task.planningMilestoneStep ?? 0) >= 32) {
          task.planningMilestoneStep = task.step; task.planningMilestoneMs = 0;
        }
        if ((task.planningMilestoneMs ?? 0) >= PLANNING_BUDGET_MS) {
          this.noteArrival(task, world);
          this.finish(task, 'failed', '这次安排多次尝试后仍未完成，已停止继续尝试。' + (task.visitTargetId
            ? task.visitInteractionAt ? '已经与对方当面交流，后续安排尚未完成。' : task.visitArrivedAt ? '已经抵达，但尚未完成当面交流。' : '尚未抵达对方的小屋。'
            : '目标尚未完成，已发生的行为保留。')); continue;
        }
        if (task.deferredDecision) {
          const deferred = task.deferredDecision;
          const socialEvidence = this.peerMessages(task).map(message => ({ id: message.id, checksum: checksum(message) }));
          const progressChanged = task.sourceMessageId && task.observedProgressEvidence
            && task.observedProgressEvidence.observationChecksum !== this.social.continuity.progressForGoal({ ...task, sourceMessageId: task.sourceMessageId }).observationChecksum;
          if (deferred.step !== task.step || JSON.stringify(deferred.socialEvidence) !== JSON.stringify(socialEvidence) || progressChanged
            || deferred.decision.status !== 'continue') {
            // No effect has run for this proposal. A final report returns to
            // Main for current async context/readset validation; confirmed
            // native/action effects remain in their original journal/history.
            delete task.deferredDecision; task.stage = '未执行的提案须根据当前真实进展重新核验；已确认行为保留，不重发。'; this.save(task);
          }
          else {
            // The planner and Main already authorized this exact atomic step.
            // Admission waits do not discard it or ask the model to invent a
            // replacement. A fresh lease/source check still guards execution.
            task.status = 'running'; task.leaseToken = randomUUID(); task.leaseUntil = Date.now() + PLANNING_LEASE_MS;
            if (task.observedProgressEvidence) task.observedProgressEvidence.leaseToken = task.leaseToken;
            task.nextAt = task.leaseUntil; this.save(task);
            this.commit(task.id, task.leaseToken, deferred.decision, false, undefined, deferred.executionReadset, deferred.topicModeratorTransferApproval);
            continue;
          }
        }
        if (task.attempts >= 3) { this.finish(task, 'failed', ('同一步连续失败三次，已停止自动重试。最后原因：' + task.stage).slice(0, 2000)); continue; }
        task.attempts++; task.status = 'running'; task.leaseToken = randomUUID(); task.planningStartedAt = Date.now();
        task.deadline = iso(Date.now() + Math.max(0, PLANNING_BUDGET_MS - (task.planningMilestoneMs ?? 0)));
        task.leaseUntil = Date.now() + PLANNING_LEASE_MS; task.nextAt = task.leaseUntil;
        this.save(task); return this.public(task);
      }
    }).immediate();
  }
  private leased(id: string, token: string): Stored { const task = this.get(id); if (task.status !== 'running' || task.leaseToken !== token || (task.leaseUntil ?? 0) < Date.now() || !this.valid(task)) throw new Error('行动任务租约或来源已失效。'); return task; }
  private topicStep(task: Stored, input: NonNullable<ActivityDecision['topic']>, moderatorTransferApproval?: CompanionTopicModeratorTransferApproval): CompanionStorageResponse {
    if (!this.topicExecute) throw new Error('当前宿主没有装配话题操作接口，未执行。');
    const operation = input as { action: string; roomId?: string; topicId?: string | null };
    const schema = companionTopicOperationSchema(operation.action);
    if (!schema) throw new Error('话题操作不存在。');
    const parsed = schema.parse(input) as Record<string, unknown>;
    const source = task.sourceMessageId ? this.visible(task, [task.sourceMessageId])[0] : undefined;
    const candidate = this.portCandidate(task);
    const candidatePort = candidate ? { conversationId: candidate.conversationId, topicId: candidate.topicId } : undefined;
    const ports = [task.gamePort ? { conversationId: task.gamePort.conversationId, topicId: task.gamePort.topicId } : undefined,
      candidatePort,
      task.peerConversationId && task.peerTopicId ? { conversationId: task.peerConversationId, topicId: task.peerTopicId } : undefined,
      source?.topicId ? { conversationId: source.conversationId, topicId: source.topicId } : undefined]
      .filter((port): port is { conversationId: string; topicId: string } => !!port);
    const matching = [...new Map(ports.filter(port => (!operation.roomId || operation.roomId === port.conversationId)
      && (operation.topicId == null || operation.topicId === port.topicId)).map(port => [port.topicId, port])).values()];
    if (matching.length !== 1) throw new Error('话题操作必须指定本任务实际已绑定的唯一 roomId/topicId，不能管理其他会话或旧局。');
    const port = matching[0]!;
    if (['create', 'fork'].includes(operation.action)) throw new Error('新活动须由主脑创建并绑定真实新端口；当前持续任务只操作本目标已绑定的话题，不能隐式切换到新局。');
    if (candidate && port.topicId === candidate.topicId && operation.action === 'join') {
      if (task.gamePort && task.gamePort.topicId !== port.topicId) {
        const old = this.topicExecute({ type: 'topic.read', readerId: task.companionId,
          conversationId: task.gamePort.conversationId, topicId: task.gamePort.topicId })?.topic;
        if (!old || old.deletedAt || old.status !== 'closed') throw new Error('旧活动端口尚未明确关闭，不能加入后切换持续目标。');
      }
      const joined = this.topicExecute({ type: 'topic.join', readerId: task.companionId, conversationId: port.conversationId, topicId: port.topicId });
      if (!joined?.ok || !joined.topic?.participantIds.includes(task.companionId)) throw new Error('本人尚未实际加入候选话题，未采纳端口。');
      const adopted = this.adoptCandidate({ type: 'activity.port.adopt_candidate', companionId: task.companionId,
        conversationId: port.conversationId, topicId: port.topicId });
      if (adopted.activityTask?.id !== task.id) throw new Error('实际加入后原目标尚无唯一有效接力，未绑定。');
      // Preserve this lease's newly captured execution dependencies; adopting
      // routing must not replace the live object with an older DB readset.
      task.gamePort = adopted.activityTask.gamePort;
      task.peerConversationId = adopted.activityTask.peerConversationId;
      task.peerTopicId = adopted.activityTask.peerTopicId;
      task.targetId ??= adopted.activityTask.targetId;
      return { ...joined, activityTask: adopted.activityTask };
    }
    const read = this.topicExecute({ type: 'topic.read', conversationId: port.conversationId, topicId: port.topicId, readerId: task.companionId });
    if (candidate && port.topicId === candidate.topicId && operation.action === 'read') return read ?? { ok: false, error: '候选话题不可读取。' };
    if (!read?.ok || read.topic?.deletedAt || read.topic?.id !== port.topicId || !read.topic.participantIds.includes(task.companionId)) throw new Error('本任务话题参与资格已变化，未执行。');
    if (operation.action === 'list') return { ok: true, topics: [read.topic], hasMore: false };
    const { action, roomId: _roomId, ...parameters } = parsed; void _roomId;
    const command = { ...parameters, type: `topic.${action}`, conversationId: port.conversationId,
      readerId: task.companionId, operationId: `activity_${task.id}_${task.step}`,
      ...(operation.action === 'transfer_moderator' ? { moderatorTransferApproval } : {}) } as Extract<CompanionStorageCommand, { type: `topic.${string}` }>;
    const result = this.topicExecute(command);
    if (!result?.ok) throw new Error(result?.error ?? '话题操作没有产生成功回执。');
    if (operation.action === 'transfer_moderator') {
      // These are dependencies actually read by the host consent review, not
      // a claim that the planning author read arbitrary nested message JSON.
      const references = moderatorTransferApproval?.sourceRefs ?? [];
      const sources = this.visible({ companionId: task.companionId, conversationId: port.conversationId }, references.map(ref => ref.id));
      if (sources.length !== references.length || sources.some(source => checksum(source) !== references.find(ref => ref.id === source.id)?.checksum)) throw new Error('主持移交的同意来源已撤回，未保存旧执行回执。');
      for (const source of sources) if (!task.evidence?.some(item => item.id === source.id)) (task.evidence ??= []).push({ id: source.id,
        conversationId: source.conversationId, checksum: checksum(source) });
    }
    this.captureTopicReceipt(task, port, result);
    return operation.action === 'update' ? { ...result, topicDelivery: COMPANION_TOPIC_STATE_WRITE_RECEIPT } : result;
  }
  private captureTopicReceipt(task: Stored, port: { conversationId: string; topicId: string }, result: CompanionStorageResponse): void {
    const checkpoints = [result.topicState?.shared, result.topicState?.workingState].filter(value => !!value);
    const sourceIds = [...new Set(checkpoints.flatMap(checkpoint => checkpoint.sourceMessageIds))];
    const sources = this.visible({ companionId: task.companionId, conversationId: port.conversationId }, sourceIds);
    if (sources.length !== sourceIds.length) throw new Error('话题回执来源已撤回，不能保存旧上下文。');
    for (const source of sources) if (!task.evidence?.some(item => item.id === source.id)) {
      (task.evidence ??= []).push({ id: source.id, conversationId: source.conversationId, checksum: checksum(source) });
    }
    for (const checkpoint of checkpoints) if (!task.topicEvidence?.some(item => item.eventId === checkpoint.sourceEventId)) {
      (task.topicEvidence ??= []).push({ conversationId: port.conversationId, topicId: port.topicId, eventId: checkpoint.sourceEventId });
    }
  }
  private commit(id: string, token: string, decision: ActivityDecision, fromPrimary = false, expectedStep?: number, executionReadset?: CompanionExecutionReadset,
    topicModeratorTransferApproval?: CompanionTopicModeratorTransferApproval): CompanionActivityTask {
    return this.db.transaction(() => {
      const task = this.leased(id, token);
      if (expectedStep !== undefined && task.step !== expectedStep) throw new Error('行动步骤已有真实进展，旧提案未执行；须重新观察。');
      if (executionReadset) this.bindExecutionEvidence(task, executionReadset);
      if (decision.status !== 'continue' && task.sourceMessageId && task.observedProgressEvidence?.leaseToken === token
        && task.observedProgressEvidence.observationChecksum !== this.social.continuity.progressForGoal({ ...task, sourceMessageId: task.sourceMessageId }).observationChecksum)
        throw new Error('行动报告核验后本目标真实发送或步骤已变化，未发布旧报告。');
      this.chargePlanning(task);
      const present = this.world.snapshot(task), self = present.actors.find(actor => actor.companionId === task.companionId);
      if (!fromPrimary && this.primaryChatBusy(task) || decision.status === 'continue' && decision.action && (present.backlog || this.peerBusy(task.companionId) || !self || ['sleeping','eating'].includes(self.routinePhase) || ['working','eating','sleeping','lyingDown','waking'].includes(self.activity) || present.works.some(work => work.companionId === task.companionId && work.kind !== 'chat' && work.status !== 'ended'))) {
        task.deferredDecision = { step: task.step, decision, executionReadset, topicModeratorTransferApproval, socialEvidence: task.deferredDecision?.socialEvidence
          ?? (task.observedSocialEvidence?.leaseToken === token ? task.observedSocialEvidence.messages : []) };
        task.status = 'queued'; task.stage = '这一步已完成授权核验并保存，暂等当前通信或身体动作结束后执行；尚未执行，不需要重新规划。'; task.nextAt = Date.now() + 5000; task.attempts = 0; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      delete task.deferredDecision;
      this.noteArrival(task, present);
      if (decision.status === 'complete' && task.visitTargetId && (!task.visitArrivedAt || !task.visitInteractionAt)) {
        task.stage = !task.visitArrivedAt ? '尚未实际抵达拜访对象的场景，不能完成。请继续核实回复与许可，再 travel 并等待真实到达；若不方便则等待或如实受阻。' : '已到场，但还没有与拜访对象实际当面交流。请依据本地感知寻找并走近对方，用 social 打招呼并等待真实回应；不方便时如实受阻。';
        task.step++; task.history.push({ step: task.step, at: iso(), action: 'complete', result: task.stage, ok: false });
        task.status = 'queued'; task.nextAt = Date.now() + 1500; task.attempts = 0; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      if (decision.status !== 'continue') { if (executionReadset) task.reportReadset = this.reportEvidence(task, executionReadset); else delete task.reportReadset;
        this.finish(task, decision.status === 'complete' ? 'succeeded' : 'failed', decision.summary); return this.public(task); }
      const action = decision.action;
      if (action && 'targetCompanionId' in action) task.targetId = action.targetCompanionId;
      if (action?.action === 'message' || action?.action === 'create_group') task.targetId = action.recipientIds[0];
      if (decision.wait && 'targetCompanionId' in decision.wait) task.targetId = decision.wait.targetCompanionId;
      const peerMessages = this.peerMessages(task);
      const observedMessages = task.observedSocialEvidence?.leaseToken === token ? task.observedSocialEvidence.messages : undefined;
      // A reply can arrive while inference, authorization or admission is in
      // flight. Only the exact observations delivered to this lease are read;
      // newer replies must remain eligible to wake the newly committed wait.
      const afterSequence = observedMessages ? Math.max(0, ...peerMessages.filter(message => observedMessages.some(observed =>
        observed.id === message.id && observed.checksum === checksum(message))).map(message => message.sequence)) : peerMessages.at(-1)?.sequence ?? 0;
      let result = decision.summary, ok = true, topicReceipt: CompanionStorageResponse | undefined;
      // Nested savepoint keeps a rejected world action from leaking partial physics changes.
      if (decision.memory) {
        const intentId = 'intent_' + createHash('sha256').update(task.id + '/' + task.step).digest('hex').slice(0, 48);
        this.db.prepare('INSERT OR IGNORE INTO companion_activity_memory_intents(id,task_id,companion_id,conversation_id,status,data) VALUES(?,?,?,?,?,?)')
          .run(intentId, task.id, task.companionId, task.conversationId, 'pending', JSON.stringify(decision.memory));
        task.memoryIntentId = intentId; task.status = 'waiting'; task.stage = '正在处理自己的 VCP 日记，等待真实回执。';
        task.nextAt = Date.now() + 1500; delete task.leaseToken; delete task.leaseUntil; this.save(task); return this.public(task);
      }
      try {
      if (decision.topic) {
        topicReceipt = this.db.transaction(() => this.topicStep(task, decision.topic!, topicModeratorTransferApproval)).immediate();
        result = JSON.stringify(topicReceipt);
      }
      if (action) {
        this.db.transaction(() => {
          if (action.action === 'message' || action.action === 'social') {
            const recipients = action.action === 'message' ? action.recipientIds : action.recipientIds ?? [action.targetCompanionId!];
            if (action.action === 'message') this.social.requireAcquaintances(task.companionId, recipients);
            const currentRoom = action.action === 'message' && action.roomId ? undefined : this.matchingPeerRoom(task, recipients);
            const roomId = this.social.resolveRoom(task.companionId, [task.companionId, ...recipients], action.action === 'message' ? action.roomId ?? currentRoom : currentRoom).id;
            const sent = this.social.send({ companionId: task.companionId, conversationId: roomId, content: action.text,
              ...(action.action === 'message' && action.topicId !== undefined ? { topicId: action.topicId }
                : currentRoom && task.peerTopicId !== undefined ? { topicId: task.peerTopicId } : {}),
              channel: action.action === 'social' ? 'face_to_face' : 'phone', ...(action.action === 'message' ? { urgent: action.urgent } : {}), clientId: `activity_${task.id}_${task.step}`,
              ...(task.sourceMessageId ? { agentSource: { conversationId: task.conversationId, messageId: task.sourceMessageId },
                ...(!task.peerResponsibility ? { authorizationMessageId: task.sourceMessageId } : {}) } : {}) });
            const queued = this.db.prepare('SELECT data FROM companion_social_outbox WHERE client_id=?').get(`activity_${task.id}_${task.step}`) as Row | undefined;
            task.peerConversationId = roomId;
            task.peerTopicId = sent.socialMessage?.message.topicId ?? (queued ? (JSON.parse(queued.data) as { topicId?: string | null }).topicId : null) ?? null;
            const clientId = `activity_${task.id}_${task.step}`;
            this.bindGamePort(task, clientId, task.peerConversationId, task.peerTopicId);
            if (!(task.seededSocialClientIds ??= []).includes(clientId)) task.seededSocialClientIds.push(clientId);
            result = JSON.stringify({ ...sent, ...(task.gamePort ? { gameStateHandoff: companionGameStateHandoffReceipt(task.gamePort) } : {}) });
          } else if (action.action === 'introduce' || action.action === 'create_group') {
            const sent = this.world.execute({ type: 'world.tool', companionId: task.companionId, conversationId: task.conversationId,
              sourceMessageId: task.sourceMessageId, clientId: `activity_${task.id}_${task.step}`, arguments: action });
            if (!sent?.socialConversation) throw new Error('社交动作没有产生真实会话回执。');
            if (sent.activityPortCandidate) {
              result = JSON.stringify(sent);
              return;
            }
            const queued = this.db.prepare('SELECT data FROM companion_social_outbox WHERE client_id=?').get(`activity_${task.id}_${task.step}`) as Row | undefined;
            task.peerConversationId = sent.socialConversation.id;
            task.peerTopicId = sent.topic?.id ?? sent.socialMessage?.message.topicId ?? (queued ? (JSON.parse(queued.data) as { topicId?: string | null }).topicId : null) ?? null;
            const clientId = `activity_${task.id}_${task.step}`;
            this.bindGamePort(task, clientId, task.peerConversationId, task.peerTopicId);
            if (!(task.seededSocialClientIds ??= []).includes(clientId)) task.seededSocialClientIds.push(clientId);
            result = JSON.stringify({ ok: sent.ok, socialConversation: sent.socialConversation, socialPending: sent.socialPending,
              socialMessage: sent.socialMessage, socialRecipients: sent.socialRecipients, topic: sent.topic, topicState: sent.topicState });
          } else if (action.action === 'query') {
            const queried = this.world.queryKnowledge(task, action);
            result = JSON.stringify({ worldKnowledge: queried.worldKnowledge, memorySources: queried.memorySources });
            for (const source of queried.memorySources ?? []) (task.evidence ??= []).push({ id: source.id, conversationId: source.conversationId, checksum: checksum(source) });
          } else {
            const acted = this.world.tool(task, action, task.sourceMessageId);
            if (action.action === 'visit' && task.sourceMessageId && !task.peerResponsibility) {
              const visit = acted.visits.find(visit => visit.guestId === task.companionId && visit.hostId === action.targetCompanionId
                && ['requested', 'allowed'].includes(visit.status));
              if (visit) task.visitRequestId = visit.id;
              this.social.continuity.record({ type: 'social.delegation.record', companionId: task.companionId, conversationId: task.conversationId,
                sourceMessageId: task.sourceMessageId, recipientIds: [action.targetCompanionId], sharedText: action.reason,
                ...(visit ? { visitId: visit.id } : {}), intent: 'visit' });
            }
          }
          if (['move','travel','leave'].includes(action.action)) this.world.tagTaskMovement(task.companionId, task.id);
        }).immediate();
        if (!['query', 'introduce', 'create_group', 'message', 'social'].includes(action.action)) result = `宿主已接纳 ${action.action} 原子行为；异步行为以实际世界状态为准，尚不代表任务完成。`;
      }
      } catch (error) { ok = false; result = error instanceof Error ? error.message.slice(0, 2000) : '原子行为失败。'; }
      const checkpoints = [topicReceipt?.topicState?.shared, topicReceipt?.topicState?.workingState].filter(value => !!value);
      const receiptSourceIds = [...new Set(checkpoints.flatMap(checkpoint => checkpoint.sourceMessageIds))];
      const boundedResult = result.length <= 16000 ? result : JSON.stringify({ truncated: true, displayPreview: true, originalChars: result.length,
        originalChecksum: createHash('sha256').update(result).digest('hex'),
        ...(topicReceipt?.topic ? { topicReceiptReference: { conversationId: topicReceipt.topic.conversationId, topicId: topicReceipt.topic.id,
          readerId: task.companionId, revision: topicReceipt.topic.revision, checkpointEventIds: checkpoints.map(checkpoint => checkpoint.sourceEventId),
          sourceMessageIds: receiptSourceIds.slice(0, 8), sourceMessageIdCount: receiptSourceIds.length, sourceMessageIdsTruncated: receiptSourceIds.length > 8 },
        reread: { action: 'read', roomId: topicReceipt.topic.conversationId, topicId: topicReceipt.topic.id },
        hint: 'history仅为显示预览，不能当完整原回执。真实话题checkpoint正文保存在话题事件中，上述ID是读取时的不可变引用；activity.observe/gameTopic或显式topic.read可取得当前合法完整状态。当前状态可能已有新版本，须核对event/revision，不将新版本冒充旧回执。' }
          : { hint: '这里只是截取的外部回执；缩小查询范围或结果数量后重新读取，不得把截取内容当作完整记录。' }),
        excerpt: result.slice(0, 12000) });
      const actionName = decision.topic ? `topic.${(decision.topic as { action: string }).action}` : action?.action ?? 'observe';
      task.step++; task.attempts = 0; task.history.push({ step: task.step, at: iso(), action: actionName, ...(action ? { arguments: action } : {}), ...(decision.topic ? { topicArguments: decision.topic } : {}), result: boundedResult, ok });
      if (!ok && task.history.slice(-3).length === 3 && task.history.slice(-3).every(item => !item.ok && item.action === actionName && item.result === result)) {
        const failedStage = '同一原子行为连续失败三次，已停止重试。最后原因：' + result;
        // The failed status and three original history entries already record
        // the stop condition. Prefer the exact cause when the prefix would
        // overflow the display field; never roll back the terminal transition.
        this.finish(task, 'failed', failedStage.length <= 2000 ? failedStage : result); return this.public(task);
      }
      if (!action && !decision.wait && !decision.memory && !decision.topic) { this.finish(task, 'failed', '规划没有提供可执行的动作或等待条件，已停止空循环。'); return this.public(task); }
      // Stage is a small display field, whereas a real topic/message receipt
      // includes checkpoint bodies and provenance. Keep that actual receipt in
      // history; overflowing the label must not roll back a legitimate effect.
      task.stage = decision.memory ? '已处理自己的记忆，继续判断下一步。' : action?.action === 'query' ? '已读取有来源的世界资料，继续判断下一步。'
        : result.length <= 2000 ? result : `本步骤 ${actionName} 已形成实际回执，请依据对应 history 中的内容及当前状态判断下一步。显示阶段不复制长回执，不表示消息已送达或完整目标完成。`;
      delete task.leaseToken; delete task.leaseUntil; task.status = 'queued'; task.nextAt = Date.now() + 1500;
      const wait = decision.wait ?? (action && ['travel','move','leave'].includes(action.action) ? { kind: 'arrival' as const } : undefined);
      if (ok && wait) {
        const world = this.world.snapshot(task), self = world.actors.find(actor => actor.companionId === task.companionId), point = self?.travel ? { sceneId: self.travel.targetSceneId, x: undefined, y: undefined } : self?.route.at(-1) ?? (self ? { ...self.position, sceneId: self.sceneId } : undefined);
        task.stage = wait.kind === 'permission' ? '等待房主处理拜访许可' : wait.kind === 'reply' ? '等待对方的真实回复' : wait.kind === 'arrival' ? '正在前往目的地，等待实际抵达' : '等待世界时间经过';
        task.wait = wait; task.status = 'waiting'; task.condition = { until: Date.now() + 300_000, afterSequence,
          ...(wait.kind === 'permission' || wait.kind === 'reply' && task.visitTargetId === wait.targetCompanionId ? { visitId: task.visitRequestId ?? world.visits.find(visit => visit.guestId === task.companionId && visit.hostId === wait.targetCompanionId && ['requested', 'allowed'].includes(visit.status))?.id } : {}),
          ...(wait.kind === 'arrival' && point ? { sceneId: point.sceneId, x: point.x, y: point.y } : {}),
          ...(wait.kind === 'delay' ? { virtualAt: Date.parse(world.clock.virtualNow) + wait.seconds * 1000 } : {}) };
      }
      this.save(task); return this.public(task);
    }).immediate();
  }
  private claimMemory(): CompanionStorageResponse {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE companion_activity_memory_intents SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(Date.now());
      const candidates = this.db.prepare("SELECT * FROM companion_activity_memory_intents WHERE status='pending' ORDER BY rowid LIMIT 32").all() as Array<{ id: string; task_id: string; companion_id: string; conversation_id: string; data: string }>;
      for (const entry of candidates) {
        const task = this.get(entry.task_id);
        if (terminal(task) || !this.valid(task) || task.memoryIntentId !== entry.id) {
          this.db.prepare("UPDATE companion_activity_memory_intents SET status='done',data='{}' WHERE id=?").run(entry.id); continue;
        }
        const token = randomUUID();
        this.db.prepare("UPDATE companion_activity_memory_intents SET status='running',lease_token=?,lease_until=? WHERE id=?").run(token, Date.now() + 120000, entry.id);
        return { ok: true, activityMemoryIntent: { id: entry.id, taskId: task.id, companionId: task.companionId,
          conversationId: task.conversationId, operation: activityMemorySchema.parse(JSON.parse(entry.data)), leaseToken: token } };
      }
      return { ok: true };
    }).immediate();
  }
  private completeMemory(command: Extract<CompanionStorageCommand, { type: 'activity.memory.complete' | 'activity.memory.fail' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const entry = this.db.prepare("SELECT task_id,data FROM companion_activity_memory_intents WHERE id=? AND status='running' AND lease_token=? AND lease_until>?")
        .get(command.id, command.leaseToken, Date.now()) as { task_id: string; data: string } | undefined;
      if (!entry) throw new Error('记忆操作租约已失效。');
      const task = this.get(entry.task_id);
      const operation = JSON.parse(entry.data) as ActivityMemoryOperation;
      // A successful own revise/organize is the one allowed transition from the
      // version that admitted this intent. External edits still invalidate it.
      const versions = new Map((task.memoryVersions ?? []).map(note => [note.id, note.version]));
      if (command.type === 'activity.memory.complete' && ['revise', 'organize'].includes(operation.operation)) {
        const mutableIds = operation.operation === 'revise' ? [operation.id] : operation.operation === 'organize' ? operation.ids : [];
        for (const note of command.noteVersions ?? []) if (mutableIds.includes(note.id) && versions.get(note.id) === note.version - 1) versions.set(note.id, note.version);
      }
      task.memoryVersions = [...versions].map(([id, version]) => ({ id, version }));
      if (terminal(task) || !this.valid(task) || task.memoryIntentId !== command.id) throw new Error('行动或其来源已改变，不能提交旧记忆回执。');
      if (command.type === 'activity.memory.complete') {
        const sources = this.visible(task, command.sourceMessageIds ?? []);
        if (sources.length !== (command.sourceMessageIds ?? []).length) throw new Error('记忆操作的来源已撤回。');
        for (const note of command.noteVersions ?? []) {
          const current = this.db.prepare("SELECT data FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.status') IN('queued','indexed')")
            .get(note.id, task.companionId, note.version) as Row | undefined;
          if (!current) throw new Error('记忆操作的日记已修订或撤回。');
          const references = (JSON.parse(current.data) as { sources: Array<{ messageId: string; checksum: string }> }).sources;
          for (const reference of references) { const source = this.visible(task, [reference.messageId])[0];
            if (!source || checksum(source) !== reference.checksum) throw new Error('记忆操作来源已改变。'); sources.push(source); }
          versions.set(note.id, note.version);
        }
        task.memoryVersions = [...versions].map(([id, version]) => ({ id, version }));
        for (const source of sources) if (!task.evidence?.some(item => item.id === source.id)) (task.evidence ??= []).push({ id: source.id, conversationId: source.conversationId, checksum: checksum(source) });
      }
      task.step++; task.attempts = 0; task.history.push({ step: task.step, at: iso(), action: 'memory.' + operation.operation,
        result: command.type === 'activity.memory.complete' ? command.result : command.error, ok: command.type === 'activity.memory.complete' });
      delete task.memoryIntentId; task.status = 'queued'; task.nextAt = Date.now() + 1500; task.stage = '记忆操作已有真实回执，继续判断下一步。'; this.save(task);
      this.db.prepare("UPDATE companion_activity_memory_intents SET status='done',data='{}',lease_token=NULL,lease_until=NULL WHERE id=?").run(command.id);
      return { ok: true, activityTask: this.public(task) };
    }).immediate();
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'activity.handoff': return this.handoff(command);
      case 'activity.social.bind_peer_port': return this.bindPeerPort(command);
      case 'activity.port.adopt_candidate': return this.adoptCandidate(command);
      case 'activity.memory.claim': return this.claimMemory();
      case 'activity.memory.complete': case 'activity.memory.fail': return this.completeMemory(command);
      case 'activity.motion.ensure': return this.ensureMotion(command);
      case 'activity.get': { const task = this.get(command.id); if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('行动任务范围不可访问。'); return { ok: true, activityTask: this.public(task) }; }
      case 'activity.progress': {
        const task = this.get(command.id);
        if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('行动任务范围不可访问。');
        const valid = this.valid(task), evidence = valid ? this.goalSocialMessages(task) : { messages: [], origins: [] };
        const progress = valid && task.sourceMessageId ? this.social.continuity.progressForGoal({ ...task, sourceMessageId: task.sourceMessageId }) : undefined;
        return { ok: true, activityTask: this.public(task), activityMessages: evidence.messages.slice(-100), activityMessageOrigins: evidence.origins.slice(-100),
          ...(progress ? { activityProgressEvidence: progress } : {}) };
      }
      case 'activity.history': {
        const task = this.get(command.id);
        if (task.companionId !== command.companionId || task.conversationId !== command.conversationId || !this.valid(task)) throw new Error('行动来源或历史范围不可访问。');
        const remaining = task.history.filter(item => item.step < (command.beforeStep ?? Number.MAX_SAFE_INTEGER));
        const items = remaining.slice(-(command.limit ?? 32));
        return { ok: true, activityHistory: { items, total: task.history.length, hasMore: remaining.length > items.length,
          ...(remaining.length > items.length ? { beforeStep: items[0]!.step } : {}) } };
      }
      case 'activity.recover': {
        this.db.prepare("UPDATE companion_activity_memory_intents SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running'").run();
        const rows = this.db.prepare("SELECT data FROM companion_activity_tasks WHERE status='running' OR (status='failed' AND json_extract(data,'$.stage') IN (?,?) AND json_extract(data,'$.step')<32 AND json_extract(data,'$.createdAt')>=?)").all(LEGACY_WAIT_TIMEOUT, LEGACY_CONTACT_REJECTION, iso(Date.now() - 86400000)) as Row[];
        for (const row of rows) {
          const task = JSON.parse(row.data) as Stored;
          if (task.status === 'failed') {
            // Repair only the old wall-clock/reclassification bugs on a current, unsuperseded
            // player visit. Completed/cancelled goals and real failures stay final.
            if (!task.sourceMessageId || !task.visitTargetId || !this.valid(task) || this.db.prepare("SELECT 1 FROM companion_activity_tasks WHERE companion_id=? AND rowid>(SELECT rowid FROM companion_activity_tasks WHERE id=?) AND json_extract(data,'$.visitTargetId')=? AND status<>'cancelled' LIMIT 1").get(task.companionId, task.id, task.visitTargetId)) continue;
            task.reportPending = false; delete task.reportReadset; task.reportVersion = (task.reportVersion ?? 0) + 1; task.attempts = 0;
            task.stage = '此前拜访因等待或重复范围判断中断，已恢复原任务；重新核对有效邀请与实际位置、交流结果。';
          }
          this.chargePlanning(task); task.status = 'queued'; task.nextAt = Date.now();
          delete task.leaseToken; delete task.leaseUntil; this.save(task);
        }
        return { ok: true };
      }
      case 'activity.start': return { ok: true, activityTask: this.start(command) };
      case 'activity.visit.ensure': return this.ensureVisit(command);
      case 'activity.list': return { ok: true, activityTasks: (this.db.prepare('SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT ?').all(command.companionId, command.conversationId, command.limit) as Row[]).map(row => this.public(JSON.parse(row.data) as Stored)) };
      case 'activity.cancel': return this.db.transaction(() => { const task = this.get(command.id); if (task.companionId !== command.companionId || task.conversationId !== command.conversationId) throw new Error('不能控制其他伙伴的任务。'); if (!terminal(task)) this.finish(task, 'cancelled', '已取消行动，停止后续计划；实际位置和已发送消息保留。'); return { ok: true, activityTask: this.public(task) }; }).immediate();
      case 'activity.claim': return { ok: true, activityTask: this.claim(command.excludedIds ?? []) };
      case 'activity.report.claim': return this.claimReport(command.excludedIds ?? [], command.id);
      case 'activity.report.complete': return this.completeReport(command);
      case 'activity.report.fail': this.failReport(command); return { ok: true };
      case 'activity.observe': {
        const task = this.leased(command.id, command.leaseToken), messages = this.peerMessages(task);
        task.observedSocialEvidence = { leaseToken: command.leaseToken, messages: messages.map(message => ({ id: message.id, checksum: checksum(message) })) };
        const evidence = new Map((task.evidence ?? []).map(item => [item.id, item]));
        for (const message of messages) evidence.set(message.id, { id: message.id, conversationId: message.conversationId, checksum: checksum(message) });
        task.evidence = [...evidence.values()]; const world = this.world.snapshot(task); this.noteArrival(task, world);
        // noteArrival can append an actual history fact. The observation CAS
        // must describe those saved bytes, not the row before that update.
        this.save(task);
        const progress = task.sourceMessageId ? this.social.continuity.progressForGoal({ ...task, sourceMessageId: task.sourceMessageId }) : undefined;
        task.observedProgressEvidence = progress ? { leaseToken: command.leaseToken, observationChecksum: progress.observationChecksum } : undefined;
        const port = this.boundPort(task);
        const game = port ? this.topicExecute?.({ type: 'topic.read', conversationId: port.conversationId, topicId: port.topicId, readerId: task.companionId }) : undefined;
        if (port && game?.ok) this.captureTopicReceipt(task, port, game);
        this.save(task);
        const shown = new Set(messages.map(message => message.id));
        const candidate = this.portCandidate(task);
        return { ok: true, activityTask: this.public(task), world, activityMessages: messages, ...(progress ? { activityProgressEvidence: progress } : {}),
          ...(candidate && candidate.topicId !== task.gamePort?.topicId ? { activityPortCandidate: publicCompanionActivityPortCandidate(candidate) } : {}),
          ...(task.wholeGoalPlan ? { activityPlanningState: task.wholeGoalPlan } : {}),
          ...(port && game?.ok && game.topic?.kind === 'game' ? { activityGameRoom: { conversationId: port.conversationId,
            memberIds: (this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY companion_id')
              .all(port.conversationId) as Array<{ companion_id: string }>).map(member => member.companion_id) } } : {}),
          ...(game?.ok ? { topic: game.topic, topicState: game.topicState } : {}),
          activityMessageOrigins: this.goalSocialMessages(task).origins.filter(origin => shown.has(origin.messageId)) };
      }
      case 'activity.plan.save': return this.db.transaction(() => {
        const task = this.leased(command.id, command.leaseToken);
        const sourceDigest = task.sourceChecksum ?? createHash('sha256').update(task.goal).digest('hex');
        if (task.step !== command.expectedStep || command.sourceDigest !== sourceDigest) throw new Error('完整目标来源或步骤已变化，旧计划未保存。');
        const invocationId = `${task.id}_${task.step}`;
        const runId = createHash('sha256').update(JSON.stringify([task.companionId, task.conversationId, invocationId])).digest('hex');
        const run = this.agentRunExecute?.({ type: 'agent.run.get', companionId: task.companionId, id: runId })?.agentRun;
        if (!run || run.status !== 'done' || run.companionId !== task.companionId || run.conversationId !== task.conversationId || run.invocationId !== invocationId) throw new Error('没有本任务本步骤已完成且来源有效的推理，未保存计划。');
        const decision = activityDecisionSchema.parse(JSON.parse(companionFinalProposalJsonText(run.turns.at(-1)!)));
        const evidence = new Map((task.evidence ?? []).map(item => [item.id, item]));
        for (const item of run.sources) evidence.set(item.id, item);
        task.evidence = [...evidence.values()];
        const memories = new Map((task.memoryVersions ?? []).map(item => [`${item.id}:${item.version}`, item]));
        for (const item of run.memories) memories.set(`${item.id}:${item.version}`, item);
        task.memoryVersions = [...memories.values()];
        const knowledge = new Map([...(task.wholeGoalPlan?.knowledgeReads ?? []), ...(run.knowledgeReads ?? [])].map(item => [JSON.stringify(item), item]));
        task.wholeGoalPlan = { taskId: task.id, companionId: task.companionId, conversationId: task.conversationId,
          sourceDigest, throughStep: task.step, revision: (task.wholeGoalPlan?.revision ?? 0) + 1, savedAt: iso(),
          trust: 'model_plan_not_execution_fact_or_authority', plan: decision.planningState ?? task.wholeGoalPlan?.plan ?? { summary: decision.summary, nextSteps: [], constraints: [] },
          knowledgeReads: [...knowledge.values()] };
        if (!this.valid(task)) throw new Error('计划引用的来源或记忆已撤回，未保存。');
        this.save(task); return { ok: true, activityPlanningState: task.wholeGoalPlan };
      }).immediate();
      case 'activity.commit': return { ok: true, activityTask: this.commit(command.id, command.leaseToken, command.decision, false, command.expectedStep, command.executionReadset, command.topicModeratorTransferApproval) };
      case 'activity.social.ensure': return this.ensureSocial(command);
      case 'activity.reject': {
        const task = this.leased(command.id, command.leaseToken); this.chargePlanning(task);
        if (command.expectedStep !== undefined && task.step !== command.expectedStep) throw new Error('行动步骤已有真实进展，旧拒绝未写入；须重新观察。');
        task.step++; task.history.push({ step: task.step, at: iso(), action: command.action.action, arguments: command.action, result: command.reason, ok: false });
        task.stage = command.reason; task.attempts = 0; task.status = 'queued'; task.nextAt = Date.now() + 1500;
        delete task.leaseToken; delete task.leaseUntil;
        if (task.history.slice(-3).length === 3 && task.history.slice(-3).every(item => !item.ok && item.result === command.reason)) this.finish(task, 'failed', '连续三次未能形成符合本次联系范围的发言，已停止自动尝试；未发送这些内容。');
        else this.save(task);
        return { ok: true, activityTask: this.public(task) };
      }
      case 'activity.fail': { const task = this.leased(command.id, command.leaseToken); this.chargePlanning(task);
        if (command.terminal) { this.finish(task, 'failed', command.error); return { ok: true }; }
        task.stage = command.error; task.status = 'queued'; task.nextAt = Date.now() + Math.min(30_000, 2000 * 2 ** task.attempts); delete task.leaseToken; delete task.leaseUntil; this.save(task); return { ok: true }; }
    }
  }
}
