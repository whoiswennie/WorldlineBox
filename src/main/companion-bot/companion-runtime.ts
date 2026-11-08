import { createHash } from 'node:crypto';
import type { BotStore } from './store';
import type { BotEvent, BotTask } from './types';
import type { BotTaskFollowupReceipt } from '../../shared/companion-bot';
import { isBotParticipantRequest } from './participant-request';

type Row = Record<string, unknown>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const ended = new Set(['succeeded', 'failed', 'cancelled']);
const policyVersion = 'companion-work-v1';
const eventBinding = (event: BotEvent) => [event.companionId, event.conversationId, event.laneId, event.securityDomainId,
  event.audienceScopeId, event.aclRevision, event.source, event.senderType, event.senderId, event.correlationId, event.causationId,
  event.sourceMessageRecordId, event.sourceMessageId, event.sourceInstanceId, event.sourceMessageSequence, event.content, event.payload];
const attachments = (task: BotTask) => [...new Set(Array.isArray(task.extra.attachmentIds) ? task.extra.attachmentIds.filter((id): id is string => typeof id === 'string') : [])].sort();
export interface BotMandate {
  id: string; taskId: string; companionId: string; sourceEventId: string; authorizingEventId: string;
  conversationId: string; securityDomainId: string; aclRevision: number; policyVersion: string;
  basis: 'explicit' | 'inherited' | 'legacy'; goal: string; attachmentIds?: string[]; state: 'active' | 'withdrawn' | 'revoked';
}
export interface BotAgentView {
  id: string; companionId: string; sequence: number; continuity: 'durable-event-driven';
  context: 'audience-filtered'; coordination: 'owner-conversations' | 'current-conversation';
  pendingEvents: number; tasks: Array<{ id: string; conversationId: string; title: string; status: string; updatedAt: string; cancelRequested?: true }>;
  recentEvents: Array<{ sequence: number; eventId: string; conversationId: string; source: string; state: string }>;
}

/** A companion is one durable actor. Rooms remain authorization views, not
 * independent identities. The journal stores routing facts; it never copies
 * another audience's transcript, model summary or VCP evidence into a turn. */
export class BotCompanionRuntime {
  constructor(private readonly store: BotStore, private readonly options: { taskAuthority?(task: BotTask): BotEvent | undefined; authorityGuard?(event: BotEvent): boolean } = {}) {
    store.taskTransaction(sql => {
      for (const statement of [
        `CREATE TABLE IF NOT EXISTS bot_brains(companion_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bot_brain_events(event_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,sequence INTEGER NOT NULL,conversation_id TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(companion_id,sequence))`,
        `CREATE INDEX IF NOT EXISTS bot_brain_events_owner ON bot_brain_events(companion_id,sequence DESC)`,
        `CREATE INDEX IF NOT EXISTS bot_inbox_actor_claim ON bot_inbox(companion_id,status,sequence)`,
        `CREATE TABLE IF NOT EXISTS bot_task_mandates(task_id TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS bot_task_subscriptions(task_id TEXT NOT NULL,conversation_id TEXT NOT NULL,companion_id TEXT NOT NULL,source_event_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(task_id,conversation_id))`,
        `CREATE INDEX IF NOT EXISTS bot_task_subscriptions_room ON bot_task_subscriptions(conversation_id,companion_id,state)`,
        `CREATE TABLE IF NOT EXISTS bot_task_followups(task_id TEXT NOT NULL,event_id TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL,PRIMARY KEY(task_id,event_id))`,
        `CREATE TABLE IF NOT EXISTS bot_agent_decisions(event_id TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(event_id,operation_id))`,
      ]) sql.prepare(statement).run();
    });
  }
  static brainId(companionId: string): string { return 'companion-' + digest(companionId).slice(0, 40); }
  identity(companionId: string): { id: string; sequence: number; continuity: 'durable-event-driven' } {
    const brain = this.store.taskTransaction(sql => sql.prepare('SELECT sequence FROM bot_brains WHERE companion_id=?').get(companionId)) as Row | undefined;
    return { id: BotCompanionRuntime.brainId(companionId), sequence: Number(brain?.sequence ?? 0), continuity: 'durable-event-driven' };
  }
  admit(event: BotEvent): number {
    this.assertEvent(event);
    return this.store.taskTransaction(sql => {
      const prior = sql.prepare('SELECT * FROM bot_brain_events WHERE event_id=?').get(event.id) as Row | undefined;
      if (prior) {
        if (prior.companion_id !== event.companionId || prior.conversation_id !== event.conversationId) throw new Error('主脑事件身份发生变化。');
        return Number(prior.sequence);
      }
      sql.prepare('INSERT OR IGNORE INTO bot_brains VALUES(?,0,?)').run(event.companionId, stamp());
      sql.prepare('UPDATE bot_brains SET sequence=sequence+1,updated_at=? WHERE companion_id=?').run(stamp(), event.companionId);
      const sequence = Number((sql.prepare('SELECT sequence FROM bot_brains WHERE companion_id=?').get(event.companionId) as Row).sequence);
      sql.prepare('INSERT INTO bot_brain_events VALUES(?,?,?,?,?,?,?)').run(event.id, event.companionId, sequence, event.conversationId, event.source, 'admitted', stamp());
      return sequence;
    });
  }
  settle(eventId: string): void {
    const event = this.store.getEvent(eventId); if (!event) return;
    this.store.taskTransaction(sql => sql.prepare('UPDATE bot_brain_events SET state=?,updated_at=? WHERE event_id=?')
      .run(event.status, stamp(), eventId));
  }
  private assertEvent(event: BotEvent): BotEvent {
    const current = this.store.getEvent(event.id), room = this.store.getConversation(event.conversationId);
    if (!current || digest(eventBinding(current)) !== digest(eventBinding(event))
      || !room || room.dissolvedAt || room.revision !== event.aclRevision || !room.memberIds.includes(event.companionId)
      || room.securityDomainId !== current.securityDomainId || room.audienceScopeId !== current.audienceScopeId
      || this.store.withdrawnIn(event.companionId, event.securityDomainId, this.store.eventSourceIds(event.id)).size) throw new Error('主脑事件来源或受众授权已经失效。');
    return current;
  }
  private authority(event: BotEvent): BotEvent | undefined {
    const current = this.assertEvent(event), room = this.store.getConversation(current.conversationId)!;
    if (this.options.authorityGuard?.(current) === false) return;
    if (!isBotParticipantRequest(current, room)) return;
    if (current.source === 'user') return current;
    // A real peer request has the same privileges as a real user request.
    // Preserve a committed contact's original lineage rather than treating its
    // destination as a permission tier. Notifications/world observations cannot
    // create another task. A contact's
    // destination selects its reply route, not whether the user's request may
    // be executed. Both routes require the same committed delivery proof.
    if (!current.causationId) return current;
    const parent = this.store.getEvent(current.causationId);
    if (!parent || parent.correlationId !== current.correlationId || parent.companionId !== current.senderId) return;
    try { this.assertEvent(parent); } catch { return; }
    const prefix = `peer-contact:${parent.id}:`;
    if (!current.sourceMessageId.startsWith(prefix)) return current.payload.userRequestedContact === true ? undefined : current;
    if (room.kind !== 'peer' || !isBotParticipantRequest(parent, this.store.getConversation(parent.conversationId)!)) return;
    const saved = this.store.getMetadata(`peer-contact-receipt:${parent.id}:${current.sourceMessageId.slice(prefix.length)}`);
    if (!saved) return;
    const receipt = JSON.parse(saved) as Row;
    if (!['peer', 'user'].includes(String(receipt.destination)) || receipt.recipientId !== current.companionId || receipt.conversationId !== room.id
      || receipt.messageId !== current.sourceMessageRecordId || receipt.fingerprint !== digest([current.companionId, receipt.destination, this.store.getMessage(current.sourceMessageRecordId)?.content ?? current.content])
      || JSON.stringify([...room.memberIds].sort()) !== JSON.stringify([parent.companionId, current.companionId].sort())) return;
    return parent;
  }
  /** Read-only host verification; a causal link by itself is never a grant. */
  workAuthority(event: BotEvent): BotEvent | undefined { return this.authority(event); }
  /** Verified participant requests can start work. System callbacks cannot
   * create new scope merely by claiming a participant asked for something. */
  authorize(event: BotEvent, operationId: string): { allowed: true; authorizingEventId: string; basis: 'explicit' | 'inherited' } | { allowed: false; observed: true; reason: string } {
    this.assertEvent(event);
    const authority = this.authority(event);
    if (!authority) {
      const result = { allowed: false as const, observed: true as const, reason: '当前事件没有有效的用户或伙伴任务授权，或者原任务已经停止/撤回；不创建执行任务。' };
      this.decide(event, operationId, 'observe', result); return result;
    }
    return { allowed: true, authorizingEventId: authority.id, basis: authority.id === event.id ? 'explicit' : 'inherited' };
  }
  bindTask(task: BotTask, legacy = false): BotMandate {
    const actual = this.store.getTask(task.id);
    if (!actual || actual.companionId !== task.companionId || actual.conversationId !== task.conversationId
      || actual.sourceEventId !== task.sourceEventId || actual.goal !== task.goal || digest(attachments(actual)) !== digest(attachments(task))) throw new Error('任务身份或输入范围与持久记录不匹配。');
    if (actual.extra.removedAt) throw new Error('任务记录已经移除，不能重新授权或恢复。');
    const source = this.store.getEvent(task.sourceEventId); if (!source) throw new Error('任务缺少原始授权来源。');
    this.assertEvent(source);
    if (source.companionId !== task.companionId || source.conversationId !== task.conversationId) throw new Error('任务来源与伙伴受众不匹配。');
    const existing = this.mandate(task.id);
    if (existing) {
      if (existing.sourceEventId !== task.sourceEventId || existing.goal !== task.goal || existing.companionId !== task.companionId
        || existing.conversationId !== task.conversationId || digest(existing.attachmentIds ?? []) !== digest(attachments(task))) throw new Error('任务不能变更已有授权范围。');
      return existing;
    }
    const workflowAuthority = this.options.taskAuthority?.(task);
    const authorization = workflowAuthority ? { allowed: true as const, authorizingEventId: workflowAuthority.id, basis: 'inherited' as const }
      : this.authorize(source, `accept:${task.id}`);
    if (!authorization.allowed) throw new Error(authorization.reason);
    const mandate: BotMandate = { id: 'mandate-' + digest([task.id, source.id]).slice(0, 40), taskId: task.id,
      companionId: task.companionId, sourceEventId: source.id,
      authorizingEventId: authorization.authorizingEventId,
      conversationId: source.conversationId, securityDomainId: source.securityDomainId, aclRevision: source.aclRevision,
      policyVersion, basis: legacy ? 'legacy' : authorization.basis, goal: task.goal, attachmentIds: attachments(task), state: 'active' };
    return this.store.taskTransaction(sql => {
      const raw = JSON.stringify(mandate);
      sql.prepare('INSERT OR IGNORE INTO bot_task_mandates VALUES(?,?,?,?,?,?)').run(task.id, mandate.id, raw, digest(raw), 'active', stamp());
      sql.prepare('INSERT OR IGNORE INTO bot_task_subscriptions VALUES(?,?,?,?,?)').run(task.id, source.conversationId, task.companionId, source.id, 'active');
      this.decide(source, `accept:${task.id}`, 'accept', { taskId: task.id, mandateId: mandate.id });
      return this.mandate(task.id)!;
    });
  }
  mandate(taskId: string): BotMandate | undefined {
    return this.store.taskTransaction(sql => {
      const saved = sql.prepare('SELECT record_json,fingerprint,state FROM bot_task_mandates WHERE task_id=?').get(taskId) as Row | undefined;
      if (!saved) return;
      const removed = sql.prepare("SELECT 1 FROM bot_tasks WHERE id=? AND json_extract(extra_json,'$.removedAt') IS NOT NULL").get(taskId);
      const record = JSON.parse(String(saved.record_json)) as BotMandate & { removed?: boolean };
      if (removed && saved.state === 'withdrawn' && record.removed === true && record.taskId === taskId) return;
      if (saved.fingerprint !== digest(String(saved.record_json))) throw new Error('任务授权记录校验失败。');
      if (record.taskId !== taskId || record.policyVersion !== policyVersion || !['active', 'withdrawn', 'revoked'].includes(String(saved.state))) throw new Error('任务授权记录版本或身份无效。');
      return { ...record, state: saved.state as BotMandate['state'] };
    });
  }
  validateTask(task: BotTask): BotMandate {
    const mandate = this.mandate(task.id) ?? this.bindTask(task, true);
    const source = this.store.getEvent(mandate.sourceEventId), authorizer = this.store.getEvent(mandate.authorizingEventId);
    if (mandate.state !== 'active') throw new Error('任务授权已经撤回或失效。');
    try {
      const actual = this.store.getTask(task.id);
      if (!actual || !source || !authorizer || source.aclRevision !== mandate.aclRevision || task.goal !== mandate.goal || actual.goal !== mandate.goal
        || task.sourceEventId !== mandate.sourceEventId || actual.sourceEventId !== mandate.sourceEventId
        || task.companionId !== mandate.companionId || actual.companionId !== mandate.companionId
        || task.conversationId !== mandate.conversationId || actual.conversationId !== mandate.conversationId
        || source.companionId !== mandate.companionId || source.conversationId !== mandate.conversationId || source.securityDomainId !== mandate.securityDomainId
        || digest(attachments(task)) !== digest(mandate.attachmentIds ?? []) || digest(attachments(actual)) !== digest(mandate.attachmentIds ?? [])) throw new Error('授权来源或任务范围已变化。');
      this.assertEvent(source); this.assertEvent(authorizer);
      if ((this.options.taskAuthority?.(actual) ?? this.authority(source))?.id !== authorizer.id) throw new Error('原始工作授权已经失效。');
      if (actual.extra.removedAt || actual.extra.humanStopped) throw new Error('任务记录已经移除或被用户停止。');
      if (task.extra.cancelRequested || task.status === 'cancelled' || actual.extra.cancelRequested || actual.status === 'cancelled') { this.withdraw(task.id); throw new Error('用户已停止任务。'); }
    } catch (error) {
      this.store.taskTransaction(sql => {
        sql.prepare("UPDATE bot_task_mandates SET state='revoked' WHERE task_id=? AND state='active'").run(task.id);
        sql.prepare("UPDATE bot_task_subscriptions SET state='stopped' WHERE task_id=?").run(task.id);
      });
      throw error;
    }
    return mandate;
  }
  withdraw(taskId: string): void {
    this.store.taskTransaction(sql => {
      sql.prepare("UPDATE bot_task_mandates SET state='withdrawn' WHERE task_id=? AND state='active'").run(taskId);
      sql.prepare("UPDATE bot_task_subscriptions SET state='stopped' WHERE task_id=?").run(taskId);
    });
  }
  /** Resolve a host-bound task reference, never infer a worker destination
   * from topic similarity. A normal chat remains a normal chat. */
  boundFollowup(event: BotEvent): BotTask | undefined {
    this.assertEvent(event);
    const binding = event.payload.taskFollowup;
    if (!binding || typeof binding !== 'object' || typeof (binding as Row).taskId !== 'string') return;
    const task = this.store.getTask(String((binding as Row).taskId));
    if (!task || event.source !== 'user' || task.conversationId !== event.conversationId || task.companionId !== event.companionId) throw new Error('跟进不属于当前任务及受众。');
    this.validateTask(task);
    if (task.status === 'cancelled' || task.status === 'unknown' || task.extra.humanStopped || task.extra.cancelRequested) throw new Error('任务已停止或待核实，不能由跟进重新启动。');
    this.store.taskTransaction(sql => {
      const subscription = sql.prepare("SELECT 1 FROM bot_task_subscriptions WHERE task_id=? AND conversation_id=? AND state='active'").get(task.id, event.conversationId);
      if (!subscription) throw new Error('任务未订阅当前跟进。');
      sql.prepare('INSERT OR IGNORE INTO bot_task_followups VALUES(?,?,?,?,?)').run(task.id, event.id, 'queued', null, stamp());
    });
    return task;
  }
  /** Read-only UI capability. It does not grant work, reopen a task, or import
   * legacy mandates merely because a directory card was rendered. */
  followupAvailable(task: BotTask): boolean {
    if (task.extra.removedAt || task.extra.humanStopped || task.extra.cancelRequested || ['cancelled', 'unknown'].includes(task.status)) return false;
    try {
      const source = this.store.getEvent(task.sourceEventId); if (!source) return false;
      this.assertEvent(source);
      const original = this.authority(source); if (!original) return false;
      const mandate = this.mandate(task.id);
      return !mandate || mandate.state === 'active' && mandate.authorizingEventId === original.id;
    } catch { return false; }
  }
  deliveredFollowup(event: BotEvent, taskId: string): void {
    this.assertEvent(event);
    this.validateTask(this.taskInView(event, taskId));
    this.store.taskTransaction(sql => {
      const followup = sql.prepare('SELECT 1 FROM bot_task_followups WHERE task_id=? AND event_id=?').get(taskId, event.id);
      if (!followup) throw new Error('跟进缺少已授权的订阅路由。');
      sql.prepare("UPDATE bot_task_followups SET state='delivered' WHERE task_id=? AND event_id=?").run(taskId, event.id);
      this.decide(event, `followup:${taskId}`, 'attach', { taskId });
    });
  }
  /** Project real routing receipts on the original user message. No synthetic
   * companion answer, token stream or model claim is treated as delivery. */
  followupReceipts(conversationId: string, messageIds: readonly string[]): Map<string, BotTaskFollowupReceipt> {
    const ids = [...new Set(messageIds)].slice(0, 80);
    if (!ids.length) return new Map();
    const rows = this.store.taskTransaction(sql => sql.prepare(`SELECT m.id,e.status,f.state,
      json_extract(e.payload_json,'$.taskFollowup.taskId') AS task_id,
      CASE WHEN json_extract(t.extra_json,'$.removedAt') IS NULL THEN substr(json_extract(t.extra_json,'$.title'),1,120) END AS title
      FROM bot_messages m JOIN bot_inbox e ON e.source_record_id=m.id AND e.conversation_id=m.conversation_id
      LEFT JOIN bot_task_followups f ON f.event_id=e.id AND f.task_id=json_extract(e.payload_json,'$.taskFollowup.taskId')
      LEFT JOIN bot_tasks t ON t.id=json_extract(e.payload_json,'$.taskFollowup.taskId') AND t.conversation_id=e.conversation_id AND t.companion_id=e.companion_id
      WHERE m.conversation_id=? AND m.sender_id='user' AND e.source='user' AND e.sender_id='user'
      AND json_type(e.payload_json,'$.taskFollowup.taskId')='text' AND m.id IN (${ids.map(() => '?').join(',')})`)
      .all(conversationId, ...ids)) as Row[];
    return new Map(rows.map(row => [String(row.id), { taskId: String(row.task_id), ...(row.title ? { title: String(row.title) } : {}),
      state: row.state === 'delivered' ? 'delivered' : row.status === 'failed' ? 'failed' : row.status === 'cancelled' ? 'cancelled'
        : row.status === 'done' ? 'needs-attention' : 'queued' }]));
  }
  decide(event: BotEvent, operationId: string, kind: string, details: unknown): void {
    this.assertEvent(event);
    this.store.taskTransaction(sql => {
      const raw = JSON.stringify(details), prior = sql.prepare('SELECT kind,details_json FROM bot_agent_decisions WHERE event_id=? AND operation_id=?').get(event.id, operationId) as Row | undefined;
      if (prior && (prior.kind !== kind || prior.details_json !== raw)) throw new Error('同一路由操作已经有确定决策。');
      if (!prior) sql.prepare('INSERT INTO bot_agent_decisions VALUES(?,?,?,?,?)').run(event.id, operationId, kind, raw, stamp());
    });
  }
  private ownerView(event: BotEvent): boolean {
    const room = this.store.getConversation(event.conversationId);
    return room?.kind === 'direct' && room.memberIds.includes('user') && room.memberIds.includes(event.companionId);
  }
  private visibleSql(event: BotEvent): { predicate: string; args: string[] } {
    return this.ownerView(event)
      ? { predicate: `EXISTS(SELECT 1 FROM bot_conversations c JOIN bot_members m ON m.conversation_id=c.id AND m.member_id='user'
          JOIN bot_members self ON self.conversation_id=c.id AND self.member_id=? WHERE c.id=t.conversation_id AND c.kind IN ('direct','group'))
          AND NOT EXISTS(SELECT 1 FROM bot_metadata d WHERE d.key='conversation-dissolved:'||t.conversation_id AND d.value<>'')`, args: [event.companionId] }
      : { predicate: 't.conversation_id=?', args: [event.conversationId] };
  }
  private taskVisible(taskId: string): boolean {
    if (this.store.taskSourcesWithdrawn(taskId)) return false;
    const record = this.store.taskTransaction(sql => sql.prepare('SELECT source_event_id FROM bot_tasks WHERE id=?').get(taskId)) as Row | undefined;
    const source = record && this.store.getEvent(String(record.source_event_id));
    if (!source) return false;
    try { this.assertEvent(source); } catch { return false; }
    try { const mandate = this.mandate(taskId); return !mandate || mandate.state === 'active'; }
    catch { return false; }
  }
  view(event: BotEvent, options: { includeEnded?: boolean } = {}): BotAgentView {
    this.assertEvent(event);
    const visible = this.visibleSql(event);
    return this.store.taskTransaction(sql => {
      const brain = sql.prepare('SELECT sequence FROM bot_brains WHERE companion_id=?').get(event.companionId) as Row | undefined;
      const tasks = sql.prepare(`SELECT t.id,t.conversation_id,substr(COALESCE(json_extract(t.extra_json,'$.title'),'任务'),1,120) AS title,t.status,t.updated_at,
        json_extract(t.extra_json,'$.cancelRequested') AS cancel_requested
        FROM bot_tasks t WHERE t.companion_id=? AND json_extract(t.extra_json,'$.removedAt') IS NULL
        ${options.includeEnded ? '' : "AND t.status IN ('queued','running','waiting','unknown')"}
        AND ${visible.predicate} ORDER BY CASE WHEN t.status IN ('queued','running','waiting','paused','unknown') THEN 0 ELSE 1 END,t.updated_at DESC,t.id LIMIT 16`)
        .all(event.companionId, ...visible.args) as Row[];
      const events = sql.prepare(`SELECT t.sequence,t.event_id,t.conversation_id,t.source,t.state FROM bot_brain_events t
        WHERE t.companion_id=? AND ${visible.predicate} ORDER BY t.sequence DESC LIMIT 8`).all(event.companionId, ...visible.args) as Row[];
      const pending = sql.prepare(`SELECT COUNT(*) AS n FROM bot_inbox t WHERE t.companion_id=? AND t.status IN ('queued','running') AND ${visible.predicate}`)
        .get(event.companionId, ...visible.args) as Row;
      return { id: BotCompanionRuntime.brainId(event.companionId), companionId: event.companionId, sequence: Number(brain?.sequence ?? 0),
        continuity: 'durable-event-driven', context: 'audience-filtered', coordination: this.ownerView(event) ? 'owner-conversations' : 'current-conversation',
        pendingEvents: Number(pending.n), tasks: tasks.flatMap(task => {
          const full = this.taskVisible(String(task.id)), stopping = !!task.cancel_requested && !ended.has(String(task.status));
          return !full && !stopping ? [] : [{ id: String(task.id), conversationId: String(task.conversation_id), title: full ? String(task.title) : '停止请求尚待执行器确认',
            status: String(task.status), updatedAt: String(task.updated_at), ...(stopping ? { cancelRequested: true as const } : {}) }];
        }),
        recentEvents: events.filter(item => {
          const source = this.store.getEvent(String(item.event_id));
          return source && !this.store.withdrawnIn(source.companionId, source.securityDomainId, this.store.eventSourceIds(source.id)).size;
        }).map(item => ({ sequence: Number(item.sequence), eventId: String(item.event_id), conversationId: String(item.conversation_id), source: String(item.source), state: String(item.state) })) };
    });
  }
  taskInView(event: BotEvent, taskId: string, options: { stopping?: 'status' | 'cancel' } = {}): BotTask {
    this.assertEvent(event); const task = this.store.getTask(taskId), visible = this.visibleSql(event);
    const exists = task && this.store.taskTransaction(sql => sql.prepare(`SELECT 1 FROM bot_tasks t WHERE t.id=? AND t.companion_id=? AND ${visible.predicate}`).get(taskId, event.companionId, ...visible.args));
    const stopControl = !!task && !!options.stopping && (task.extra.cancelRequested === true && !ended.has(task.status)
      || task.status === 'cancelled' || task.extra.humanStopped === true && ended.has(task.status))
      && (options.stopping === 'status' || isBotParticipantRequest(event, this.store.getConversation(event.conversationId)));
    if (!task || !exists || task.extra.removedAt || !this.taskVisible(task.id) && !stopControl) throw new Error('任务不属于当前主脑获准的协调视图。');
    return task;
  }
}
