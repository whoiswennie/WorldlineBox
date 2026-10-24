import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionAction, CompanionMessage } from '../shared/companions';
import type { CompanionLoopCheckpoint } from '../shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionCollaborationGrantSchema, type CompanionCollaborationGrant, type CompanionCollaborationParticipant } from '../shared/companion-collaboration';
import { verifyCompanionActionSlots } from './goal-action-proof';

type Row = Record<string, string | number | null>;
type Scope = { companionId: string; conversationId: string };
type Command = Extract<CompanionStorageCommand, { type: `collaboration.${string}` }>;
const row = (value: unknown) => value as Row;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const checksum = (content: string) => createHash('sha256').update(content).digest('hex');
const terminal = new Set<CompanionCollaborationParticipant['status']>(['declined', 'succeeded', 'failed', 'cancelled']);

/** Explicit human delegation is a durable grant, never authority inferred from peer speech. */
export class CompanionCollaborationStore {
  constructor(private readonly db: CompanionConnection, private readonly visible: (scope: Scope, ids: string[]) => CompanionMessage[]) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_collaborations(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,client_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_collaboration_owner ON companion_collaborations(owner_id,status,ordinal);
      CREATE INDEX IF NOT EXISTS companion_collaboration_source ON companion_collaborations(source_message_id);`);
  }
  private active(companionId: string): void {
    const found = this.db.prepare('SELECT data FROM companions WHERE id=? AND deleted_at IS NULL').get(companionId);
    if (!found || decode<{ active?: boolean }>(row(found).data).active === false) throw new Error('协作参与者必须是真实已激活的伙伴。');
    if (this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(companionId)) throw new Error('伙伴正在重置，协作授权不可用。');
  }
  private member(companionId: string, conversationId: string): void {
    if (!this.db.prepare('SELECT 1 FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.companion_id=? AND m.conversation_id=? AND c.dissolved_at IS NULL').get(companionId, conversationId)) throw new Error('协作消息入口不属于这个伙伴。');
  }
  private load(id: string): CompanionCollaborationGrant {
    const found = this.db.prepare('SELECT data FROM companion_collaborations WHERE id=?').get(id);
    if (!found) throw new Error('协作授权不存在。');
    return companionCollaborationGrantSchema.parse(decode(row(found).data));
  }
  private save(grant: CompanionCollaborationGrant): void {
    if (grant.status !== 'cancelled' && grant.participants.every(participant => terminal.has(participant.status))) grant.status = 'completed';
    grant.revision++; grant.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE companion_collaborations SET status=?,data=? WHERE id=?').run(grant.status, JSON.stringify(grant), grant.id);
  }
  private current(grant: CompanionCollaborationGrant): void {
    this.active(grant.ownerId); this.member(grant.ownerId, grant.conversationId);
    const source = this.visible({ companionId: grant.ownerId, conversationId: grant.conversationId }, [grant.sourceMessageId])[0];
    if (!source || source.authorId !== 'user' || source.status !== 'sent' || source.isReplyDraft || source.replyDraft
      || source.conversationId !== grant.conversationId || checksum(source.content) !== grant.sourceChecksum
      || !grant.evidence.every(quote => source.content.includes(quote))) throw new Error('协作原始用户授权已撤回、变化或不可访问。');
    if (grant.status === 'cancelled') throw new Error('协作已取消，不再授予执行权限。');
  }
  private allowed(grant: CompanionCollaborationGrant, companionId: string): void {
    if (grant.ownerId !== companionId && !grant.participants.some(participant => participant.companionId === companionId && !participant.accessRevokedAt)) throw new Error('当前伙伴不属于这份协作授权，或原参与权限已撤回。');
    this.active(companionId); this.current(grant);
  }
  private participant(grant: CompanionCollaborationGrant, companionId: string) {
    const participant = grant.participants.find(participant => participant.companionId === companionId);
    if (!participant) throw new Error('只有受邀者本人可以接受或推进自己的协作任务。');
    return participant;
  }
  assertInvocation(input: { authorizationGrantId?: string; companionId: string; conversationId: string; sourceMessageId: string; invocationId?: string }): CompanionCollaborationGrant {
    if (!input.authorizationGrantId) throw new Error('跨入口的执行必须携带真实协作授权。');
    const grant = this.load(input.authorizationGrantId); this.allowed(grant, input.companionId);
    const participant = this.participant(grant, input.companionId);
    if (participant.status !== 'running' || participant.conversationId !== input.conversationId || grant.sourceMessageId !== input.sourceMessageId
      || input.invocationId && participant.invocationId !== input.invocationId) throw new Error('协作授权、受邀者、独立目标或消息入口不匹配。');
    this.member(input.companionId, input.conversationId);
    return grant;
  }
  assertAction(action: Pick<CompanionAction, 'authorizationGrantId' | 'companionId' | 'conversationId' | 'sourceMessageId'>): void {
    if (!action.sourceMessageId) throw new Error('协作执行必须保留真实授权来源。');
    this.assertInvocation({ ...action, sourceMessageId: action.sourceMessageId });
  }
  cancelFor(companionId: string): void {
    const found = this.db.prepare("SELECT data FROM companion_collaborations WHERE owner_id=? OR EXISTS(SELECT 1 FROM json_each(data,'$.participants') p WHERE json_extract(p.value,'$.companionId')=?)").all(companionId, companionId);
    for (const value of found) {
      const grant = companionCollaborationGrantSchema.parse(decode(row(value).data));
      if (grant.ownerId === companionId) grant.status = 'cancelled';
      for (const participant of grant.participants) if (participant.companionId === companionId) participant.accessRevokedAt = new Date().toISOString();
      for (const participant of grant.participants) if (!terminal.has(participant.status) && (grant.ownerId === companionId || participant.companionId === companionId)) {
        participant.status = 'cancelled'; participant.reason = '参与者已重置，原协作停止，不从历史自动恢复。';
      }
      this.save(grant);
    }
  }
  private complete(grant: CompanionCollaborationGrant, participant: CompanionCollaborationParticipant, command: Extract<Command, { type: 'collaboration.complete' }>): void {
    if (participant.status === 'succeeded') {
      if (participant.invocationId !== command.invocationId || participant.result !== command.result) throw new Error('协作完成重试与原始验收不一致。');
      return;
    }
    this.assertInvocation({ authorizationGrantId: grant.id, companionId: participant.companionId, conversationId: participant.conversationId!, sourceMessageId: grant.sourceMessageId, invocationId: command.invocationId });
    const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(`loop/${grant.sourceMessageId}/${participant.companionId}/invocation/${command.goalSlot}`);
    const loop = saved ? decode<CompanionLoopCheckpoint>(row(saved).value) : undefined;
    const invocation = loop?.context ? (JSON.parse(loop.context.user) as { invocation?: { id: string; kind: string; companionId: string; conversationId: string; goal: string; parentInvocationId?: string; authorization?: { externalActions?: boolean; grantId?: string; sourceMessageIds?: string[] } } }).invocation : undefined;
    if (!loop || loop.status !== 'done' || loop.companionId !== participant.companionId || loop.conversationId !== participant.conversationId
      || loop.sourceMessageId !== grant.sourceMessageId || loop.authorizationGrantId !== grant.id || !loop.messageId
      || invocation?.id !== command.invocationId || invocation.kind !== 'collaboration' || invocation.goal !== participant.goal
      || invocation.companionId !== participant.companionId || invocation.conversationId !== participant.conversationId
      || invocation.parentInvocationId !== grant.parentInvocationId || invocation.authorization?.grantId !== grant.id
      || !invocation.authorization.externalActions || !invocation.authorization.sourceMessageIds?.includes(grant.sourceMessageId)
      || loop.turns.at(-1)?.calls.length || loop.turns.at(-1)?.text !== command.result) throw new Error('协作需要受邀者本人的完整主脑验收及相同目标来源。');
    verifyCompanionActionSlots(this.db, { companionId: participant.companionId, conversationId: participant.conversationId!,
      sourceMessageId: grant.sourceMessageId, parentMessageId: loop.messageId, turns: loop.turns,
      actionIds: command.actionIds, authorizationGrantId: grant.id });
    participant.status = 'succeeded'; participant.goalSlot = command.goalSlot; participant.result = command.result;
    participant.actionIds = [...new Set(command.actionIds)]; participant.finishedAt = new Date().toISOString();
  }
  execute(input: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!input.type.startsWith('collaboration.')) return;
    return this.db.transaction(() => this.dispatch(input as Command)).immediate();
  }
  private dispatch(command: Command): CompanionStorageResponse {
    if (command.type === 'collaboration.create') {
      this.active(command.companionId); this.member(command.companionId, command.conversationId);
      const source = this.visible(command, [command.sourceMessageId])[0];
      if (!source || source.authorId !== 'user' || source.status !== 'sent' || source.isReplyDraft || source.replyDraft || source.conversationId !== command.conversationId
        || !command.evidence.every(quote => source.content.includes(quote))) throw new Error('协作只能依据当前可见的真实用户消息与逐字证据。');
      if (source.content.length > 65536) throw new Error('协作授权来源超过单条用户消息范围。');
      const ids = command.participants.map(participant => participant.companionId);
      if (new Set(ids).size !== ids.length || ids.includes(command.companionId)) throw new Error('受邀伙伴必须彼此不同，也不能是发起者本人。');
      ids.forEach(id => this.active(id));
      const prior = this.db.prepare('SELECT data FROM companion_collaborations WHERE client_id=?').get(command.clientId);
      if (prior) {
        const grant = companionCollaborationGrantSchema.parse(decode(row(prior).data)); this.allowed(grant, command.companionId);
        if (grant.ownerId !== command.companionId || grant.conversationId !== command.conversationId || grant.sourceMessageId !== command.sourceMessageId
          || grant.goal !== command.goal || grant.title !== command.title || grant.parentInvocationId !== command.parentInvocationId
          || JSON.stringify(grant.participants.map(({ companionId, goal }) => ({ companionId, goal }))) !== JSON.stringify(command.participants)) throw new Error('协作重试标识已属于另一份目标。');
        return { ok: true, collaboration: grant };
      }
      const at = new Date().toISOString();
      const grant: CompanionCollaborationGrant = { id: randomUUID(), ownerId: command.companionId, conversationId: command.conversationId,
        sourceMessageId: source.id, sourceContent: source.content, sourceChecksum: checksum(source.content), evidence: command.evidence,
        title: command.title, goal: command.goal, parentInvocationId: command.parentInvocationId,
        participants: command.participants.map(participant => ({ ...participant, status: 'offered', actionIds: [] })),
        status: 'running', revision: 1, createdAt: at, updatedAt: at };
      this.db.prepare('INSERT INTO companion_collaborations(id,owner_id,conversation_id,source_message_id,client_id,status,data) VALUES(?,?,?,?,?,?,?)')
        .run(grant.id, grant.ownerId, grant.conversationId, grant.sourceMessageId, command.clientId, grant.status, JSON.stringify(grant));
      return { ok: true, collaboration: grant };
    }
    if (command.type === 'collaboration.list') {
      this.active(command.companionId);
      const found = this.db.prepare("SELECT data FROM companion_collaborations WHERE (? IS NULL OR conversation_id=?) AND (owner_id=? OR EXISTS(SELECT 1 FROM json_each(data,'$.participants') p WHERE json_extract(p.value,'$.companionId')=?)) ORDER BY ordinal DESC LIMIT ?")
        .all(command.conversationId ?? null, command.conversationId ?? null, command.companionId, command.companionId, command.limit ?? 40);
      const collaborations: CompanionCollaborationGrant[] = [];
      for (const value of found) { const grant = companionCollaborationGrantSchema.parse(decode(row(value).data)); try { this.allowed(grant, command.companionId); collaborations.push(grant); } catch { /* Revoked scopes are never replayed. */ } }
      return { ok: true, collaborations };
    }
    const grant = this.load(command.id); this.allowed(grant, command.companionId);
    if (command.type === 'collaboration.read') return { ok: true, collaboration: grant };
    if (command.type === 'collaboration.cancel') {
      if (grant.ownerId !== command.companionId) throw new Error('只有发起者能取消整个协作。');
      grant.status = 'cancelled'; grant.participants.forEach(participant => { if (!terminal.has(participant.status)) { participant.status = 'cancelled'; participant.reason = command.reason; } });
    } else {
      const participant = this.participant(grant, command.companionId);
      if (command.type === 'collaboration.respond') {
        const status = command.decision === 'accept' ? 'accepted' : 'declined';
        if (participant.status !== 'offered' && participant.status !== status) throw new Error('协作邀请已被本人处理，不能替换既有决定。');
        participant.status = status; participant.reason = command.reason;
        if (status === 'accepted') participant.acceptedAt ??= new Date().toISOString();
      } else if (command.type === 'collaboration.start') {
        if (participant.status !== 'accepted' && participant.status !== 'running') throw new Error('受邀者必须先亲自接受，再开始独立执行。');
        this.member(command.companionId, command.conversationId);
        if (participant.invocationId && (participant.invocationId !== command.invocationId || participant.conversationId !== command.conversationId)) throw new Error('同一协作子任务不能切换执行身份或消息入口。');
        participant.status = 'running'; participant.invocationId = command.invocationId; participant.conversationId = command.conversationId;
      } else if (command.type === 'collaboration.complete') this.complete(grant, participant, command);
      else if (command.type === 'collaboration.fail') {
        if (terminal.has(participant.status)) throw new Error('已结束的协作子任务不能被迟到失败覆盖。');
        participant.status = command.cancelled ? 'cancelled' : 'failed'; participant.reason = command.error; participant.finishedAt = new Date().toISOString();
      }
    }
    this.save(grant); return { ok: true, collaboration: grant };
  }
}
