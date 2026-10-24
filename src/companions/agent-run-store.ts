import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionAgentRunSchema, companionFinalValidationFailures, type CompanionAgentRun } from '../shared/companion-agent-run';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionActivityTask, activityPlanningStateSchema } from '../shared/companion-activity-task';
import type { z } from 'zod';

/** Domain job IDs are durable inference ports, including synthetic learning
 * rooms. These records never create a chat message or enlarge source access. */
export class CompanionAgentRunStore {
  constructor(private readonly db: CompanionConnection,
    private readonly visible: (scope: { companionId: string; conversationId: string }, ids: string[]) => CompanionMessage[],
    private readonly memoryValid: (owner: string, id: string, version: number) => boolean,
    private readonly topicExecute?: (command: CompanionStorageCommand) => CompanionStorageResponse | undefined) {}
  private assertValid(run: CompanionAgentRun): void {
    for (const rejected of run.rejectedFinals ?? []) if (createHash('sha256').update(run.turns[rejected.step]!.rawText).digest('hex') !== rejected.proposalChecksum)
      throw new Error('被拒最终提案的不可变原文校验不匹配。');
    if (!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status<>'completed')").get(run.companionId, run.companionId)) throw new Error('伙伴推理主体已不可用。');
    const room = this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(run.conversationId);
    if (room && !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(run.conversationId, run.companionId)) throw new Error('伙伴已不属于本次推理会话。');
    if (run.topicId && !this.db.prepare("SELECT 1 FROM companion_topics WHERE id=? AND conversation_id=? AND json_extract(data,'$.deletedAt') IS NULL").get(run.topicId, run.conversationId)) throw new Error('推理话题已删除或不属于本会话。');
    for (const source of run.sources) {
      const current = this.visible({ companionId: run.companionId, conversationId: source.conversationId }, [source.id])[0];
      if (!current || createHash('sha256').update(current.content).digest('hex') !== source.checksum) throw new Error('推理来源已撤回或更新，旧步骤不能恢复。');
    }
    for (const memory of run.memories) if (!this.memoryValid(run.companionId, memory.id, memory.version)) throw new Error('推理引用的记忆已失效，旧步骤不能恢复。');
    for (const topic of run.topics ?? []) {
      const checked = this.topicExecute?.({ type: 'topic.sources.valid', readerId: run.companionId, ...topic });
      if (!checked?.ok || !checked.topicSourcesValid) throw new Error('推理引用的游戏或话题检查点已撤回或失效，旧步骤不能恢复。');
    }
    for (const read of run.knowledgeReads ?? []) if (read.sourceType === 'learning' && !this.db.prepare("SELECT 1 FROM companion_learning_grants WHERE id=? AND companion_id=? AND enabled=1 AND revision=?")
      .get(read.grantId, run.companionId, read.grantRevision)) throw new Error('推理引用的资料授权已撤回或变化。');
  }
  private load(owner: string, id: string): CompanionAgentRun | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(`agent-run/${owner}/${id}`) as { value: string } | undefined;
    if (!row) return;
    const run = companionAgentRunSchema.parse(JSON.parse(row.value));
    if (run.companionId !== owner || run.id !== id) throw new Error('推理存档归属不一致。');
    this.assertValid(run); return run;
  }
  private reviseFinal(command: Extract<CompanionStorageCommand, { type: 'agent.run.revise_final' }>): CompanionStorageResponse {
    return this.db.transaction(() => {
      const run = this.load(command.companionId, command.id), turn = run?.turns[command.turnStep];
      if (!run || run.revision !== command.expectedRevision || command.turnStep !== run.turns.length - 1 || !turn || turn.calls.length
        || createHash('sha256').update(turn.rawText).digest('hex') !== command.proposalChecksum
        || run.rejectedFinals?.some(item => item.step === command.turnStep) || companionFinalValidationFailures(run) >= 3
        || command.hostObservation && (turn.hostProgressKey !== command.hostObservation.previousKey
          || command.hostObservation.previousKey === command.hostObservation.currentKey))
        throw new Error('最终提案或修订版本不匹配，未重开推理。');
      const row = this.db.prepare('SELECT data FROM companion_activity_tasks WHERE id=?').get(command.activityTaskId) as { data: string } | undefined;
      const task = row ? JSON.parse(row.data) as CompanionActivityTask & { leaseUntil?: number; sourceChecksum?: string; clientId: string;
        evidence?: Array<{ id: string; conversationId: string; checksum: string }>; memoryVersions?: Array<{ id: string; version: number }>;
        topicEvidence?: Array<{ conversationId: string; topicId: string; eventId: string }>; wholeGoalPlan?: z.infer<typeof activityPlanningStateSchema>;
        observedSocialEvidence?: { leaseToken: string } } : undefined;
      if (!task || task.companionId !== command.companionId || task.conversationId !== run.conversationId || task.status !== 'running'
        || task.leaseToken !== command.leaseToken || (task.leaseUntil ?? 0) <= Date.now() || task.step !== command.expectedStep
        || run.invocationId !== `${task.id}_${task.step}` || !this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1").get(task.companionId))
        throw new Error('原活动任务、步骤或实际执行lease已变化，不能重开旧最终提案。');
      if (command.hostObservation && task.observedSocialEvidence?.leaseToken !== command.leaseToken)
        throw new Error('观察变化必须绑定本次实际活动观察及执行lease。');
      const checkedSource = (room: string, id: string, checksum: string | undefined, domain: 'plain' | 'social' = 'plain') => {
        const source = this.visible({ companionId: task.companionId, conversationId: room }, [id]).find(item => item.id === id && item.conversationId === room);
        // Activity/readset checksums cover raw body bytes; actual social outbox
        // receipts also bind the complete original message identity envelope.
        const actual = source ? createHash('sha256').update(domain === 'plain' ? source.content : JSON.stringify([
          source.id, source.conversationId, source.topicId, source.authorId, source.content, source.status, source.replyToId])).digest('hex') : undefined;
        if (!source || source.status !== 'sent' || source.isReplyDraft || source.replyDraft || !checksum || actual !== checksum)
          throw new Error('原活动来源已经撤回或更新，不能重开旧最终提案。');
        return source;
      };
      if (task.sourceMessageId && checkedSource(task.conversationId, task.sourceMessageId, task.sourceChecksum).authorId !== 'user') throw new Error('原活动真人来源归属不一致。');
      if (task.targetId && !this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(task.targetId)) throw new Error('原活动联系人已经不可访问。');
      for (const source of task.evidence ?? []) checkedSource(source.conversationId, source.id, source.checksum);
      for (const memory of task.memoryVersions ?? []) if (!this.memoryValid(task.companionId, memory.id, memory.version)) throw new Error('活动引用的记忆已经失效。');
      for (const reference of task.topicEvidence ?? []) if (!this.topicExecute?.({ type: 'topic.sources.valid', readerId: task.companionId,
        conversationId: reference.conversationId, topicId: reference.topicId, sourceMessageIds: [], checkpointEventIds: [reference.eventId] })?.topicSourcesValid) throw new Error('活动引用的话题来源已经失效。');
      for (const read of task.wholeGoalPlan?.knowledgeReads ?? []) if (read.sourceType === 'learning'
        && !this.db.prepare('SELECT 1 FROM companion_learning_grants WHERE id=? AND companion_id=? AND enabled=1 AND revision=?')
          .get(read.grantId, task.companionId, read.grantRevision)) throw new Error('活动引用的资料授权已经变化。');
      if (task.clientId.startsWith('schedule_activity_')) {
        const schedule = this.db.prepare("SELECT s.data FROM companion_schedule_occurrences o JOIN companion_schedules s ON s.id=o.schedule_id WHERE o.id=? AND s.status='active' AND o.status<>'cancelled'")
          .get(task.clientId.slice('schedule_activity_'.length)) as { data: string } | undefined;
        if (!schedule || JSON.parse(schedule.data).prompt !== task.goal) throw new Error('原活动日程来源已经失效。');
      }
      if (task.gamePort) {
        const current = this.topicExecute?.({ type: 'topic.read', readerId: task.companionId, conversationId: task.gamePort.conversationId, topicId: task.gamePort.topicId });
        if (!current?.topic || current.topic.deletedAt || current.topic.kind !== 'game' || !current.topic.participantIds.includes(task.companionId)) throw new Error('原活动游戏端口已失效。');
        const delivery = this.db.prepare('SELECT companion_id,conversation_id,status,data FROM companion_social_outbox WHERE client_id=?')
          .get(task.gamePort.deliveryClientId) as { companion_id: string; conversation_id: string; status: string; data: string } | undefined;
        const sent = delivery ? JSON.parse(delivery.data) as { companionId: string; conversationId: string; topicId?: string;
          authorizationMessageId?: string; authorizationChecksum?: string; sourceMessageId?: string; sourceChecksum?: string;
          agentSource?: { conversationId: string; messageId: string }; agentChecksum?: string } : undefined;
        if (!delivery || !sent || !['pending', 'sent'].includes(delivery.status) || delivery.companion_id !== task.companionId
          || sent.companionId !== task.companionId || delivery.conversation_id !== task.gamePort.conversationId
          || sent.conversationId !== task.gamePort.conversationId || sent.topicId !== task.gamePort.topicId) throw new Error('原游戏端口的实际通信回执已失效。');
        if (sent.authorizationMessageId) {
          const author = checkedSource(task.conversationId, sent.authorizationMessageId, sent.authorizationChecksum, 'social');
          if (author.authorId !== 'user' || author.kind !== 'text' || author.id !== task.sourceMessageId) throw new Error('原游戏真人通信来源不匹配。');
        }
        if (sent.sourceMessageId) {
          const author = checkedSource(sent.conversationId, sent.sourceMessageId, sent.sourceChecksum, 'social');
          if (author.kind !== 'text' || ['user', 'system', task.companionId].includes(author.authorId)) throw new Error('原游戏伙伴通信来源不匹配。');
        }
        if (sent.agentSource && checkedSource(sent.agentSource.conversationId, sent.agentSource.messageId, sent.agentChecksum, 'social').kind !== 'text')
          throw new Error('原游戏入口来源不是实际文本消息。');
      }
      const next: CompanionAgentRun = { ...run, revision: run.revision + 1, status: 'running', rejectedFinals: [...(run.rejectedFinals ?? []), {
        step: command.turnStep, proposalChecksum: command.proposalChecksum, reason: command.reason, rejectedAt: new Date().toISOString(),
        activityTaskId: task.id, activityStep: task.step, leaseTokenChecksum: createHash('sha256').update(command.leaseToken).digest('hex'),
        ...(command.hostObservation ? { hostObservation: command.hostObservation } : {}) }] };
      this.assertValid(next);
      this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(companionAgentRunSchema.parse(next)), `agent-run/${run.companionId}/${run.id}`);
      return { ok: true, agentRun: next };
    }).immediate();
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'agent.run.get') return { ok: true, agentRun: this.load(command.companionId, command.id) };
    if (command.type === 'agent.run.revise_final') return this.reviseFinal(command);
    if (command.type !== 'agent.run.save') return;
    return this.db.transaction(() => {
      const run = companionAgentRunSchema.parse(command.run), previous = this.load(run.companionId, run.id);
      if ((previous?.revision ?? 0) !== command.expectedRevision || run.revision !== command.expectedRevision + 1) throw new Error('推理检查点已被另一个执行器更新。');
      if (previous && (previous.requestDigest !== run.requestDigest || previous.invocationId !== run.invocationId
        || previous.conversationId !== run.conversationId || previous.topicId !== run.topicId
        || previous.turns.length > run.turns.length || previous.status === 'done' && run.status !== 'done')) throw new Error('推理检查点不能更换任务或丢失已提交步骤。');
      if (previous) for (let index = 0; index < previous.turns.length; index++) {
        const before = previous.turns[index]!, next = run.turns[index]!;
        if (JSON.stringify({ ...before, results: undefined }) !== JSON.stringify({ ...next, results: undefined })
          || before.results && JSON.stringify(before.results) !== JSON.stringify(next.results)) throw new Error('已提交的推理决策或能力回执不可改写。');
      }
      if (previous && (previous.sources.some(source => !run.sources.some(next => JSON.stringify(next) === JSON.stringify(source)))
        || previous.memories.some(memory => !run.memories.some(next => next.id === memory.id && next.version === memory.version))
        || previous.effects.some(effect => !run.effects.some(next => next.step === effect.step && next.callId === effect.callId
          && (effect.state === 'dispatched' || next.state === 'confirmed' && next.result === effect.result))))) throw new Error('推理不能丢弃已经读取的来源或已确认作用凭证。');
      if (previous?.knowledgeReads?.some(read => !run.knowledgeReads?.some(next => JSON.stringify(next) === JSON.stringify(read)))) throw new Error('推理不能丢弃已经使用的冷资料版本读集。');
      if (previous?.topics?.some(read => !run.topics?.some(next => JSON.stringify(next) === JSON.stringify(read)))) throw new Error('推理不能丢弃已经使用的话题检查点读集。');
      if (JSON.stringify(previous?.rejectedFinals ?? []) !== JSON.stringify(run.rejectedFinals ?? [])) throw new Error('最终提案拒绝凭证只能经原活动实际lease核验追加，不能改写或借普通存档伪造。');
      this.assertValid(run);
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`agent-run/${run.companionId}/${run.id}`, JSON.stringify(run));
      return { ok: true, agentRun: run };
    }).immediate();
  }
}
