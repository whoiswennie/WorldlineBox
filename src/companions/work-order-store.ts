import { createHash, randomUUID } from 'node:crypto';
import { companionTaskCanClaim } from './task-concurrency-store';
import type { CompanionConnection } from './store';
import type { CompanionAction, CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionWorkOrderSchema, type CompanionWorkOrder } from '../shared/companion-work-order';
import { verifyCompanionGoalProof } from './goal-proof';
import type { CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import { executionMessageReadsetKey } from './execution-source-access';

type Row = Record<string, string | number | null>;
type Scope = { companionId: string; conversationId: string };
const row = (value: unknown) => value as Row;
const parse = <T>(value: unknown) => JSON.parse(String(value)) as T;
const iso = () => new Date().toISOString();
const terminal = new Set(['completed', 'failed', 'cancelled']);

/** Durable assignments share the same source, action and SQLite authorities. */
export class CompanionWorkOrderStore {
  private readsetValid?: (scope: Scope, proof: CompanionExecutionReadset) => boolean;
  connectReadsetValidation(validate: NonNullable<CompanionWorkOrderStore['readsetValid']>): void { this.readsetValid = validate; }
  constructor(private readonly db: CompanionConnection,
    private readonly visible: (scope: Scope, ids: string[]) => CompanionMessage[],
    private readonly human: (scope: Scope, content: string, clientId?: string) => CompanionMessage,
    private readonly append: (scope: Scope, content: string, clientId: string, replyToId: string) => CompanionMessage,
    private readonly changed: () => void) {}

  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_work_orders(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,status TEXT NOT NULL,action_id TEXT UNIQUE,lease_token TEXT,lease_until TEXT,client_id TEXT UNIQUE,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_orders_owner ON companion_work_orders(companion_id,status,ordinal);
      CREATE INDEX IF NOT EXISTS companion_orders_status ON companion_work_orders(status,ordinal);
      CREATE INDEX IF NOT EXISTS companion_orders_conversation ON companion_work_orders(conversation_id,ordinal);
      CREATE TABLE IF NOT EXISTS companion_work_order_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL REFERENCES companion_work_orders(id) ON DELETE CASCADE,revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS companion_order_revisions ON companion_work_order_audit(order_id,revision);`);
  }
  private scope(scope: Scope): Row {
    const found = this.db.prepare('SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id JOIN companions p ON p.id=m.companion_id WHERE c.id=? AND m.companion_id=? AND c.dissolved_at IS NULL AND p.deleted_at IS NULL').get(scope.conversationId, scope.companionId);
    if (!found) throw new Error('工作单不属于当前伙伴或聊天。');
    return row(found);
  }
  private source(scope: Scope, sourceMessageId: string | undefined, title: string, instruction: string, clientId?: string): CompanionMessage {
    this.scope(scope);
    const source = sourceMessageId ? this.visible(scope, [sourceMessageId])[0]
      : this.human(scope, `发布给伙伴的工作单\n标题：${title}\n完整要求：${instruction}`, clientId ? 'order_source_' + createHash('sha256').update(clientId).digest('hex') : undefined);
    if (!source || source.conversationId !== scope.conversationId || source.authorId === 'system' || source.isReplyDraft || source.replyDraft) throw new Error('工作单需要当前聊天中真实已发送的发布者来源。');
    return source;
  }
  private load(id: string): CompanionWorkOrder {
    const found = this.db.prepare('SELECT data FROM companion_work_orders WHERE id=?').get(id);
    if (!found) throw new Error('工作单不存在。');
    return companionWorkOrderSchema.parse(parse(row(found).data));
  }
  private allowed(scope: Scope, id: string): CompanionWorkOrder {
    const conversation = this.scope(scope), order = this.load(id);
    if (order.companionId !== scope.companionId || conversation.kind !== 'private' && order.conversationId !== scope.conversationId) throw new Error('工作单属于另一个伙伴或聊天。');
    return this.reconcile(order);
  }
  private save(order: CompanionWorkOrder, authored = true): void {
    if (authored) { order.revision++; order.updatedAt = iso(); }
    this.db.prepare('UPDATE companion_work_orders SET status=?,action_id=?,data=? WHERE id=?').run(order.status, order.actionId ?? null, JSON.stringify(order), order.id);
    if (authored) this.db.prepare('INSERT INTO companion_work_order_audit(order_id,revision,data) VALUES(?,?,?)').run(order.id, order.revision, JSON.stringify(order));
    this.changed();
  }
  private reconcile(order: CompanionWorkOrder): CompanionWorkOrder {
    if (!terminal.has(order.status) && this.visible({ companionId: order.companionId, conversationId: order.conversationId }, order.authorizationSourceMessageIds).length !== order.authorizationSourceMessageIds.length) {
      order.status = 'cancelled'; order.error = '发布来源已撤回或不可访问，停止后续工作。'; this.save(order);
    }
    return order;
  }
  private projection(order: CompanionWorkOrder): CompanionWorkOrder {
    const visible = this.visible({ companionId: order.companionId, conversationId: order.conversationId }, order.authorizationSourceMessageIds);
    if (visible.length !== order.authorizationSourceMessageIds.length) return { ...order, title: '来源已撤回的工作单', instruction: '原始要求已撤回。', result: undefined, completionMessageId: undefined };
    return order;
  }
  focus(companionId: string): CompanionWorkOrder | undefined {
    for (const found of this.db.prepare("SELECT id FROM companion_work_orders WHERE companion_id=? AND status IN('accepted','running') ORDER BY ordinal LIMIT 100").all(companionId)) {
      const order = this.reconcile(this.load(String(row(found).id)));
      if (['accepted', 'running'].includes(order.status)) return order;
    }
    return undefined;
  }
  rehomeConversation(from: string, to: string): void {
    this.db.prepare("UPDATE companion_work_orders SET conversation_id=?,data=json_set(data,'$.conversationId',?) WHERE conversation_id=?").run(to, to, from); this.changed();
  }
  create(scope: Scope, title: string, instruction: string, sourceMessageId?: string, clientId?: string): CompanionWorkOrder {
    return this.db.transaction(() => {
      if (clientId) {
        const old = this.db.prepare('SELECT id FROM companion_work_orders WHERE client_id=?').get(clientId);
        if (old) { const existing = this.allowed(scope, String(row(old).id)); if (existing.title !== title || existing.instruction !== instruction || sourceMessageId && existing.sourceMessageId !== sourceMessageId) throw new Error('工作单重试标识已被其它内容使用。'); return existing; }
      }
      const source = this.source(scope, sourceMessageId, title, instruction, clientId), at = iso();
      const order: CompanionWorkOrder = { id: randomUUID(), companionId: scope.companionId, publisherId: source.authorId, conversationId: scope.conversationId, sourceMessageId: source.id, authorizationSourceMessageIds: [source.id], title, instruction,
        execution: source.authorId === 'user' ? 'external' : 'internal', status: source.authorId === 'user' ? 'accepted' : 'offered', revision: 1, createdAt: at, worldCreatedAt: source.worldCreatedAt ?? source.createdAt, updatedAt: at };
      this.db.prepare('INSERT INTO companion_work_orders(id,companion_id,conversation_id,status,client_id,data) VALUES(?,?,?,?,?,?)').run(order.id, order.companionId, order.conversationId, order.status, clientId ?? null, JSON.stringify(order));
      this.db.prepare('INSERT INTO companion_work_order_audit(order_id,revision,data) VALUES(?,?,?)').run(order.id, 1, JSON.stringify(order)); this.changed(); return order;
    }).immediate();
  }
  /** Bind each attempt to its parent authority. Attempts do not complete it. */
  bindAction(action: CompanionAction, instruction?: string): CompanionAction | undefined {
    void instruction;
    if (!action.workOrderId) return undefined;
    const order = this.allowed(action, action.workOrderId);
    if (order.execution !== 'external') throw new Error('伙伴发布的工作不能获得现实执行权限，必须由用户明确授权。');
    if (order.conversationId !== action.conversationId || order.sourceMessageId !== action.sourceMessageId) throw new Error('行动与工作单的当前授权来源不一致。');
    if (['offered', 'paused', 'cancelled', 'completed', 'failed'].includes(order.status)) throw new Error('工作单尚未受理、已暂停或已结束。');
    action.workOrderId = order.id; return undefined;
  }
  assertActionResume(action: CompanionAction): void {
    if (!action.workOrderId) return;
    const order = this.reconcile(this.load(action.workOrderId));
    if (order.companionId !== action.companionId || order.conversationId !== action.conversationId || order.execution !== 'external'
      || order.sourceMessageId !== action.sourceMessageId || !['accepted', 'running'].includes(order.status)) throw new Error('工作单未处于可执行状态，请从工作台恢复或新建工作。');
  }
  actionChanged(action: CompanionAction): void {
    if (!action.workOrderId) return;
    const order = this.load(action.workOrderId);
    if (order.sourceMessageId !== action.sourceMessageId) return;
    const before = JSON.stringify(order);
    if (order.companionId !== action.companionId || order.conversationId !== action.conversationId) throw new Error('行动不属于这张工作单。');
    if (!order.actionIds?.includes(action.id)) order.actionId = action.id;
    order.actionIds = [...new Set([...(order.actionIds ?? []), action.id])];
    if (JSON.stringify(order) !== before) this.save(order);
  }
  private claim(companionId?: string, leaseMs = 120000): CompanionStorageResponse {
    return this.db.transaction(() => {
      const at = iso(), args: unknown[] = [at]; if (companionId) args.push(companionId);
      const candidates = this.db.prepare(`SELECT id FROM companion_work_orders o WHERE (status='accepted' OR status='running' AND lease_until<=?) ${companionId ? 'AND companion_id=?' : ''}
        AND NOT EXISTS(SELECT 1 FROM companion_focus_interruptions i WHERE i.companion_id=o.companion_id AND i.status='active'
          AND NOT EXISTS(SELECT 1 FROM json_each(o.data,'$.authorizationSourceMessageIds') s WHERE s.value=json_extract(i.data,'$.sourceMessageId')))
        AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=o.companion_id AND r.status!='completed')
        AND EXISTS(SELECT 1 FROM companions p WHERE p.id=o.companion_id AND p.deleted_at IS NULL AND json_extract(p.data,'$.active')=1)
        ORDER BY ordinal LIMIT 100`).all(...args);
      for (const found of candidates) {
        const order = this.reconcile(this.load(String(row(found).id))); if (order.status === 'cancelled') continue;
        if (!companionTaskCanClaim(this.db, order.companionId, { kind: 'work-order', id: order.id })) continue;
        const leaseToken = randomUUID(), leaseUntil = new Date(Date.now() + leaseMs).toISOString(); order.status = 'running'; this.save(order);
        this.db.prepare('UPDATE companion_work_orders SET lease_token=?,lease_until=? WHERE id=?').run(leaseToken, leaseUntil, order.id);
        return { ok: true, workOrderClaim: { order, leaseToken, leaseUntil } };
      }
      return { ok: true };
    }).immediate();
  }
  private leased(id: string, token: string): CompanionWorkOrder {
    const found = this.db.prepare('SELECT lease_token FROM companion_work_orders WHERE id=?').get(id), order = this.reconcile(this.load(id));
    if (!found || row(found).lease_token !== token || order.status !== 'running') throw new Error('工作单已暂停、撤回或租约失效。');
    return order;
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!command.type.startsWith('work-order.')) return undefined;
    return this.db.transaction(() => {
      switch (command.type) {
        case 'work-order.create': return { ok: true, workOrder: this.create(command, command.title, command.instruction, command.sourceMessageId, command.clientId) };
        case 'work-order.list': {
          const conversation = this.scope(command), args: unknown[] = [command.companionId, command.before ?? Number.MAX_SAFE_INTEGER];
          if (conversation.kind !== 'private') args.push(command.conversationId);
          const found = this.db.prepare(`SELECT id,ordinal FROM companion_work_orders WHERE companion_id=? AND ordinal<? ${conversation.kind !== 'private' ? 'AND conversation_id=?' : ''} ${command.includeHistory ? '' : "AND status IN('offered','accepted','running','paused')"} ORDER BY ordinal DESC LIMIT ?`).all(...args, (command.limit ?? 40) + 1);
          const page = found.slice(0, command.limit ?? 40), hasMore = found.length > (command.limit ?? 40);
          return { ok: true, workOrderPage: { items: page.map(found => this.projection(this.reconcile(this.load(String(row(found).id))))), hasMore, ...(hasMore && page.length ? { nextBefore: Number(row(page.at(-1)).ordinal) } : {}) } };
        }
        case 'work-order.update': case 'work-order.accept': case 'work-order.pause': case 'work-order.cancel': {
          const order = this.allowed(command, command.id);
          if (order.revision !== command.expectedRevision) throw new Error('工作单已更新，请刷新后重试。');
          if (terminal.has(order.status)) throw new Error('工作单已经结束。');
          if (command.type === 'work-order.update') {
            if (order.execution === 'internal') throw new Error('伙伴发布的内部工作不能由玩家表单改写，请在自己的聊天中新建授权工作。');
            if (order.conversationId !== command.conversationId) throw new Error('请在工作单的原始聊天中修改要求，不能跨聊天拼接授权。');
            if (!['offered', 'paused'].includes(order.status)) throw new Error('请先暂停工作再修改要求。');
            const title = command.patch.title ?? order.title, instruction = command.patch.instruction ?? order.instruction;
            const source = this.source(command, command.sourceMessageId, title, instruction);
            if (order.authorizationSourceMessageIds.length >= 100) throw new Error('这张工作单修订较多，请新建工作单。');
            order.title = title; order.instruction = instruction; order.publisherId = source.authorId; order.sourceMessageId = source.id;
            order.authorizationSourceMessageIds = [...new Set([...order.authorizationSourceMessageIds, source.id])]; order.execution = source.authorId === 'user' ? 'external' : 'internal'; delete order.actionId; delete order.actionIds;
          } else if (command.type === 'work-order.accept') order.status = 'accepted';
          else {
            if (command.type === 'work-order.pause' && !command.paused) {
              const action = this.db.prepare("SELECT 1 FROM actions WHERE json_extract(data,'$.workOrderId')=? AND status IN('queued','running') LIMIT 1").get(order.id);
              if (action) throw new Error('旧执行尚未停止，请等待停止完成再恢复。');
            }
            order.status = command.type === 'work-order.cancel' ? 'cancelled' : command.paused ? 'paused' : 'accepted';
          }
          this.save(order); this.db.prepare('UPDATE companion_work_orders SET lease_token=NULL,lease_until=NULL WHERE id=?').run(order.id);
          return { ok: true, workOrder: this.projection(order) };
        }
        case 'work-order.claim': return this.claim(command.companionId, command.leaseMs);
        case 'work-order.heartbeat': {
          const order = this.reconcile(this.load(command.id));
          const lease = this.db.prepare('SELECT lease_token FROM companion_work_orders WHERE id=?').get(command.id);
          if (['completed', 'failed'].includes(order.status) && lease && row(lease).lease_token === command.leaseToken
            && this.visible({ companionId: order.companionId, conversationId: order.conversationId }, order.authorizationSourceMessageIds).length === order.authorizationSourceMessageIds.length) {
            return { ok: true, workOrder: this.projection(order) };
          }
          this.leased(command.id, command.leaseToken); this.db.prepare('UPDATE companion_work_orders SET lease_until=? WHERE id=?').run(new Date(Date.now() + (command.leaseMs ?? 120000)).toISOString(), command.id); return { ok: true };
        }
        case 'work-order.complete': {
          const replay = this.db.prepare('SELECT data,lease_token FROM companion_work_orders WHERE id=?').get(command.id);
          if (replay && row(replay).lease_token === command.leaseToken && parse<CompanionWorkOrder>(row(replay).data).status === 'completed') return { ok: true, workOrder: this.projection(this.load(command.id)) };
          const order = this.leased(command.id, command.leaseToken);
          if (command.executionReadset && (command.executionReadset.companionId !== order.companionId
            || command.executionReadset.conversationId !== order.conversationId || !this.readsetValid?.(order, command.executionReadset)))
            throw new Error('内部工作实际使用的来源已撤回或不可访问。');
          if (order.execution === 'external') {
            verifyCompanionGoalProof(this.db, { kind: 'work', ...order, goalInvocationId: command.goalInvocationId,
              goalSlot: command.goalSlot, result: command.result, actionIds: command.actionIds });
            order.actionIds = [...new Set(command.actionIds ?? [])];
          }
          if (!command.result) throw new Error('工作需要实际完成的结果正文。');
          const message = this.append(order, command.result, 'order_result_' + order.id, order.sourceMessageId);
          if (command.executionReadset) this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)')
            .run(executionMessageReadsetKey(message.id), JSON.stringify(command.executionReadset));
          order.status = 'completed'; order.result = message.content; order.completionMessageId = message.id; this.save(order);
          this.db.prepare('UPDATE companion_work_orders SET lease_until=NULL WHERE id=?').run(order.id);
          return { ok: true, workOrder: order, message };
        }
        case 'work-order.fail': { const order = this.leased(command.id, command.leaseToken); order.status = 'failed'; order.error = command.error; this.save(order); this.db.prepare('UPDATE companion_work_orders SET lease_token=NULL,lease_until=NULL WHERE id=?').run(order.id); return { ok: true, workOrder: order }; }
        case 'work-order.interrupt-pending': {
          for (const found of this.db.prepare("SELECT id FROM companion_work_orders WHERE status='running'").all()) { const order = this.load(String(row(found).id)); order.status = 'accepted'; this.save(order); }
          this.db.prepare('UPDATE companion_work_orders SET lease_token=NULL,lease_until=NULL').run(); return { ok: true };
        }
      }
      return undefined;
    }).immediate();
  }
}
