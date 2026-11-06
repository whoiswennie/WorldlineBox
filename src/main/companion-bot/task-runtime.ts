import { createHash } from 'node:crypto';
import { z } from 'zod';
import { botTaskAnswerSchema, botTaskQuestionSchema, botEffectResolutionSchema, type BotAnsweredQuestion, type BotTaskAnswer,
  type BotTaskAttention, type BotTaskPendingEffect, type BotWorkerEffectDecision, type BotWorkerEffectInspection,
  type BotWorkerEffectStart, type BotWorkerQuestionResult } from '../../shared/companion-bot-task';
import type { BotTask as BotTaskCard, BotTaskSummary } from '../../shared/companion-bot';
import type { BotStore, BotTaskSql } from './store';
import type { BotSource, BotTask } from './types';
import { BotDshBrain } from './dsh-brain';
import type { BotStoredWorkerReport } from './task-report';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const id = z.string().min(1).max(300);
const redactDiagnostic = (value: string): string => value
  .replace(/\bsk-[A-Za-z0-9_-]+/giu, '[redacted-key]')
  .replace(/\bBearer\s+[^\s"',;\]}]+/giu, 'Bearer [redacted]')
  .replace(/(["']?(?:api[-_ ]?key|access[-_ ]?token|authorization)["']?\s*[:=]\s*["']?)[^\s"',;\]}]+/giu, '$1[redacted]')
  .slice(0, 1000);
const nativeFields = { nativeSessionId: z.string().min(1).max(200).optional(), nativeCallId: id.optional() };
type NativeRef = { nativeSessionId?: string; nativeCallId?: string };
const questionRequest = z.strictObject({ questionId: z.string().min(1).max(160), callId: id, questions: z.array(botTaskQuestionSchema).min(1), ...nativeFields });
const effectStart = z.strictObject({ callId: id, toolName: z.string().min(1).max(500), argsHash: z.string().regex(/^[a-f0-9]{64}$/), argumentsPreview: z.string().max(4000), ...nativeFields });
const effectCommit = effectStart.omit({ argumentsPreview: true }).extend({ isError: z.boolean() });
export interface BotTaskControlInput { requestId: string; text?: string; questionId?: string; answers?: BotTaskAnswer[];
  effectResolutions?: z.infer<typeof botEffectResolutionSchema>[]; caller: 'user' | 'brain'; source?: BotSource;
  /** Host-bound triggering inbox event, never a model-supplied identifier. */
  sourceEventId?: string }

/** Task facts survive native Session restore. Only durable native results or
 * explicit, individually recorded user decisions can resolve an unknown effect. */
export class BotTaskRuntime {
  constructor(private readonly store: BotStore, private readonly options: { followupAvailable?(task: BotTask): boolean } = {}) {}
  private nativeRef(taskId: string, callId: string, input: NativeRef): Required<NativeRef> {
    const root = BotDshBrain.sessionId(`worker-${taskId}`), nativeSessionId = input.nativeSessionId ?? root, nativeCallId = input.nativeCallId ?? callId;
    const expected = nativeSessionId === root ? nativeCallId : 'child-' + digest(`${nativeSessionId}:${nativeCallId}`).slice(0, 48);
    if (expected !== callId) throw new Error('执行器原生会话与调用标识不匹配。');
    return { nativeSessionId, nativeCallId };
  }
  private savedNativeRef(taskId: string, value: Row): Required<NativeRef> {
    return this.nativeRef(taskId, String(value.call_id), { nativeSessionId: value.native_session_id ? String(value.native_session_id) : undefined, nativeCallId: value.native_call_id ? String(value.native_call_id) : undefined });
  }
  assertAdmittedHostTool(taskId: string, callId: string, name: string, input: NativeRef): void {
    const native = this.nativeRef(taskId, callId, input);
    this.store.taskTransaction(sql => {
      const previous = sql.prepare('SELECT * FROM bot_task_effects WHERE task_id=? AND call_id=?').get(taskId, callId);
      if (!previous || row(previous).state !== 'pending' || row(previous).tool_name !== name
        || JSON.stringify(this.savedNativeRef(taskId, row(previous))) !== JSON.stringify(native)) throw new Error('宿主工具没有匹配的原生执行前回执。');
    });
  }
  visibleTasks(conversationId?: string): BotTask[] {
    return this.store.listTaskCatalog({ conversationId, view: 'context', order: 'activity', limit: 100 });
  }
  summary(conversationId: string): BotTaskSummary | undefined {
    const room = this.store.getConversation(conversationId);
    if (!room || room.dissolvedAt || !room.memberIds.includes('user')) return;
    return this.store.taskTransaction(sql => {
      const counts = row(sql.prepare(`SELECT COUNT(*) AS active,COALESCE(SUM(status='queued'
        AND COALESCE(json_extract(extra_json,'$.cancelRequested'),0)<>1 AND COALESCE(json_extract(extra_json,'$.pauseRequested'),0)<>1),0) AS queued FROM bot_tasks
        WHERE conversation_id=? AND status IN ('queued','running','waiting','paused','unknown') AND json_extract(extra_json,'$.removedAt') IS NULL`).get(conversationId));
      return { activeCount: Number(counts.active), queuedCount: Number(counts.queued),
        items: this.store.listTaskCatalog({ conversationId, view: 'directory', order: 'summary', limit: 5 }).map(task => this.card(task, false)) };
    });
  }
  card(task: BotTask, details = true): BotTaskCard {
    const priorReport = task.extra.workerReport as BotStoredWorkerReport | undefined;
    const report = priorReport?.callId === task.extra.reportBaseline ? undefined : priorReport;
    const turn = task.extra.turnOutcome as { status: string; receivedAt: string } | undefined;
    const recoveryMessage = typeof task.extra.lastRecoveryError === 'string' ? redactDiagnostic(task.extra.lastRecoveryError) : undefined;
    const recoveryStage = typeof task.extra.lastRecoveryStage === 'string' ? redactDiagnostic(task.extra.lastRecoveryStage).slice(0, 100) : undefined;
    const attempts = Number(task.extra.cancelRequested === true ? task.extra.cancelRecoveryAttempts ?? 0 : task.extra.pauseRequested === true ? task.extra.pauseRecoveryAttempts ?? 0 : task.extra.retryAttempts ?? 0);
    const companionName = task.companionName ?? this.store.taskTransaction(sql => (sql.prepare('SELECT name FROM bot_companions WHERE id=?').get(task.companionId) as { name: string } | undefined)?.name);
    return { id: task.id, conversationId: task.conversationId, companionId: task.companionId, companionName, goal: details ? task.goal : task.goal.slice(0, 200), status: task.status,
      title: typeof task.extra.title === 'string' ? task.extra.title.slice(0, 120) : undefined,
      createdAt: task.createdAt, startedAt: typeof task.extra.presenceStartedAt === 'string' ? task.extra.presenceStartedAt : undefined,
      updatedAt: task.updatedAt, sessionId: task.sessionId, cancelRequested: task.extra.cancelRequested === true,
      humanStopped: task.extra.humanStopped === true, followupAvailable: this.options.followupAvailable?.(task),
      stopRequestedAt: typeof task.extra.cancelRequestedAt === 'string' ? task.extra.cancelRequestedAt : undefined,
      pauseRequested: task.extra.pauseRequested === true, pauseRequestedAt: typeof task.extra.pauseRequestedAt === 'string' ? task.extra.pauseRequestedAt : undefined,
      pausedAt: typeof task.extra.pausedAt === 'string' ? task.extra.pausedAt : undefined,
      pauseOrigin: task.extra.pauseOrigin === 'router' ? 'router' : task.extra.pauseOrigin === 'user' ? 'user' : undefined,
      elapsedMs: typeof task.extra.elapsedMs === 'number' && Number.isFinite(task.extra.elapsedMs) ? task.extra.elapsedMs : undefined,
      timerStartedAt: typeof task.extra.timerStartedAt === 'string' ? task.extra.timerStartedAt : undefined,
      continuationAvailable: task.status === 'waiting' && task.extra.cancelRequested !== true && Number.isSafeInteger(task.extra.outputCheckpoint),
      report: details && report ? { state: report.state, summary: report.summary, verification: report.verification, receivedAt: report.receivedAt } : undefined,
      executionTurn: details && turn ? { status: turn.status, receivedAt: turn.receivedAt } : undefined,
      diagnostic: details && (recoveryMessage || recoveryStage || attempts > 0) ? { attempts: Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0, stage: recoveryStage, message: recoveryMessage ?? '此前没有保留更详细的连接错误。' } : undefined,
      activity: details && Array.isArray(task.extra.activity) ? task.extra.activity as BotTaskCard['activity'] : undefined,
      progress: task.extra.progress && typeof task.extra.progress === 'object' ? task.extra.progress as BotTaskCard['progress'] : undefined,
      summary: details ? task.summary : undefined, summaryIsPreview: details ? task.summaryIsPreview : undefined, error: task.error, attention: details ? this.attention(task.id) : undefined,
      pendingEffects: details ? this.pendingEffects(task.id) : undefined, outputs: details ? this.store.publicationsForTask(task.id) : undefined };
  }
  page(input: { conversationId: string; companionId?: string; filter: 'all' | 'active' | 'done' | 'issues'; query?: string; page: number; limit: number }) {
    if (!this.store.getConversation(input.conversationId)) throw new Error('聊天不存在。');
    return this.store.taskTransaction(sql => {
      const predicates = ['conversation_id=?', "json_extract(extra_json,'$.removedAt') IS NULL"], args: Array<string | number> = [input.conversationId];
      if (input.companionId) { predicates.push('companion_id=?'); args.push(input.companionId); }
      if (input.filter === 'active') predicates.push("status IN ('queued','running','waiting','paused','unknown')");
      if (input.filter === 'done') predicates.push("status IN ('succeeded','failed','cancelled')");
      if (input.filter === 'issues') predicates.push("status IN ('waiting','unknown','failed')");
      if (input.query?.trim()) { predicates.push("instr(lower(goal||' '||COALESCE(json_extract(extra_json,'$.title'),'')),lower(?))>0"); args.push(input.query.trim()); }
      const where = predicates.join(' AND '), total = Number(row(sql.prepare(`SELECT COUNT(*) AS n FROM bot_tasks WHERE ${where}`).get(...args)).n);
      const page = Math.min(input.page, Math.max(0, Math.ceil(total / input.limit) - 1));
      const items = this.store.listTaskCatalog({ ...input, view: 'directory', order: 'created', offset: page * input.limit }).map(task => this.card(task, false));
      const scope = `conversation_id=?${input.companionId ? ' AND companion_id=?' : ''}`, scopeArgs = [input.conversationId, ...(input.companionId ? [input.companionId] : [])];
      const counts = row(sql.prepare(`SELECT COUNT(*) AS active,COALESCE(SUM(status='queued'),0) AS queued FROM bot_tasks WHERE ${scope} AND status IN ('queued','running','waiting','paused','unknown') AND json_extract(extra_json,'$.removedAt') IS NULL`).get(...scopeArgs));
      const finished = row(sql.prepare(`SELECT COUNT(*) AS count FROM bot_tasks WHERE ${scope} AND status IN ('succeeded','failed','cancelled') AND json_extract(extra_json,'$.removedAt') IS NULL`).get(...scopeArgs));
      return { items, total, page, limit: input.limit, activeCount: Number(counts.active), queuedCount: Number(counts.queued), finishedCount: Number(finished.count) };
    });
  }
  attention(taskId: string): BotTaskAttention | undefined {
    return this.store.taskTransaction(sql => {
      const value = sql.prepare("SELECT * FROM bot_task_questions WHERE task_id=? AND state<>'closed' ORDER BY created_at,question_id LIMIT 1").get(taskId);
      return value ? this.questionRow(row(value)) : undefined;
    });
  }
  private questionRow(value: Row): BotTaskAttention {
    return { id: String(value.question_id), callId: String(value.call_id), state: String(value.state) as BotTaskAttention['state'],
      questions: JSON.parse(String(value.questions_json)), answers: value.answers_json ? JSON.parse(String(value.answers_json)) : undefined };
  }
  answeredQuestions(taskId: string): BotAnsweredQuestion[] {
    return this.store.taskTransaction(sql => sql.prepare(`SELECT q.* FROM bot_task_questions q WHERE q.task_id=? AND q.answers_json IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM bot_task_answer_receipts r WHERE r.task_id=q.task_id AND r.question_id=q.question_id) ORDER BY q.created_at,q.question_id`).all(taskId)
      .map(value => { const entry = this.questionRow(row(value)); return { questionId: entry.id, callId: entry.callId, questions: entry.questions, answers: entry.answers!, ...this.savedNativeRef(taskId, row(value)) }; }));
  }
  answerCursor(taskId: string, nativeSessionId = BotDshBrain.sessionId(`worker-${taskId}`)): number {
    return Number(this.store.getMetadata(`task-answer-cursor:${taskId}:${digest(nativeSessionId)}`)
      ?? (nativeSessionId === BotDshBrain.sessionId(`worker-${taskId}`) ? this.store.getMetadata(`task-answer-cursor:${taskId}`) : undefined) ?? 0);
  }
  recordAnswerProofs(taskId: string, expected: BotAnsweredQuestion[], proof: Array<{ questionId: string; state: 'committed' | 'unknown'; observedThrough?: number; nativeSessionId?: string }>): void {
    this.store.taskTransaction(sql => {
      if (proof.length !== expected.length || new Set(proof.map(item => item.questionId)).size !== expected.length
        || expected.some(item => !proof.some(entry => entry.questionId === item.questionId))) throw new Error('原生问题回答证明不完整。');
      for (const entry of proof) if (entry.state === 'committed') {
        const question = expected.find(item => item.questionId === entry.questionId)!;
        const native = this.nativeRef(taskId, question.callId, question);
        if ((entry.nativeSessionId ?? BotDshBrain.sessionId(`worker-${taskId}`)) !== native.nativeSessionId) throw new Error('原生回答证明来自其他会话。');
        const saved = sql.prepare('SELECT answers_json FROM bot_task_questions WHERE task_id=? AND question_id=?').get(taskId, entry.questionId);
        if (!saved || String(row(saved).answers_json) !== JSON.stringify(question.answers)) throw new Error('原生回答证明不属于已保存答案。');
        sql.prepare('INSERT OR IGNORE INTO bot_task_answer_receipts VALUES(?,?,?)').run(taskId, entry.questionId, digest(JSON.stringify(question.answers)));
        sql.prepare("UPDATE bot_task_questions SET state='closed' WHERE task_id=? AND question_id=?").run(taskId, entry.questionId);
      }
      const sessions = new Set(expected.map(question => this.nativeRef(taskId, question.callId, question).nativeSessionId));
      for (const sessionId of sessions) {
        const entries = proof.filter(item => (item.nativeSessionId ?? BotDshBrain.sessionId(`worker-${taskId}`)) === sessionId);
        const count = expected.filter(question => this.nativeRef(taskId, question.callId, question).nativeSessionId === sessionId).length;
        const through = entries.map(item => item.observedThrough);
        if (entries.length === count && through.every(value => Number.isSafeInteger(value) && Number(value) >= this.answerCursor(taskId, sessionId))) {
          this.store.setMetadata(`task-answer-cursor:${taskId}:${digest(sessionId)}`, String(through.reduce<number>((minimum, value) => Math.min(minimum, value!), Number.MAX_SAFE_INTEGER)));
        }
      }
    });
  }
  hasReadyAnswer(taskId: string): boolean {
    return this.store.taskTransaction(sql => Boolean(sql.prepare("SELECT 1 FROM bot_task_questions WHERE task_id=? AND state='answered' LIMIT 1").get(taskId)));
  }
  question(task: BotTask, input: unknown): BotWorkerQuestionResult {
    const parsed = questionRequest.parse(input), value = { ...parsed, ...this.nativeRef(task.id, parsed.callId, parsed) }, fingerprint = JSON.stringify(value.questions);
    const expected = 'question-' + digest(`work-${task.id}:${value.callId}`).slice(0, 48);
    if (value.questionId !== expected || new Set(value.questions.map(item => item.id)).size !== value.questions.length) throw new Error('执行器问题标识不匹配。');
    return this.store.taskTransaction(sql => {
      const previous = sql.prepare('SELECT * FROM bot_task_questions WHERE task_id=? AND question_id=?').get(task.id, value.questionId);
      if (previous) {
        if (row(previous).call_id !== value.callId || row(previous).questions_json !== fingerprint || JSON.stringify(this.savedNativeRef(task.id, row(previous))) !== JSON.stringify(this.nativeRef(task.id, value.callId, value))) throw new Error('同一执行器问题标识对应其他内容。');
        return { state: 'queued', questionId: value.questionId };
      }
      sql.prepare('INSERT INTO bot_task_questions(task_id,question_id,call_id,questions_json,answers_json,state,created_at,native_session_id,native_call_id) VALUES(?,?,?,?,?,?,?,?,?)').run(task.id, value.questionId, value.callId, fingerprint, null, 'queued', new Date().toISOString(), value.nativeSessionId, value.nativeCallId);
      this.store.updateTask(task.id, { status: 'waiting', error: '' });
      this.notice(task, `question:${value.questionId}`, `任务 ${task.id} 等待回答：\n${value.questions.map(item => item.question).join('\n').slice(0, 8000)}`);
      return { state: 'queued', questionId: value.questionId };
    });
  }
  questionResult(task: BotTask, questionId: string, callId: string, hasRunningSlot: boolean): BotWorkerQuestionResult {
    return this.store.taskTransaction(sql => {
      const saved = sql.prepare('SELECT * FROM bot_task_questions WHERE task_id=? AND question_id=?').get(task.id, questionId);
      if (!saved || row(saved).call_id !== callId) throw new Error('问题不属于本执行器调用。');
      const current = this.store.getTask(task.id)!;
      if (current.status === 'paused') return { state: 'queued', questionId };
      if (current.extra.cancelRequested || ['cancelled', 'failed', 'succeeded', 'unknown'].includes(current.status)) return { state: 'closed', questionId, reason: '任务已停止或等待核实。' };
      const value = this.questionRow(row(saved));
      if (!value.answers || !hasRunningSlot) return { state: 'queued', questionId };
      sql.prepare("UPDATE bot_task_questions SET state='closed' WHERE task_id=? AND question_id=?").run(task.id, questionId);
      const unanswered = sql.prepare("SELECT 1 FROM bot_task_questions WHERE task_id=? AND state='queued' LIMIT 1").get(task.id);
      this.store.updateTask(task.id, { status: unanswered ? 'waiting' : 'running' });
      return { state: 'answered', questionId, answers: value.answers };
    });
  }
  answer(task: BotTask, input: BotTaskControlInput, attached: boolean): unknown {
    if (input.caller !== 'user' && input.source !== 'user') {
      const event = input.sourceEventId ? this.store.getEvent(input.sourceEventId) : undefined;
      if (input.source !== 'task' || !event || event.source !== 'task' || event.kind !== 'task_progress'
        || event.companionId !== task.companionId || event.conversationId !== task.conversationId
        || event.payload.taskId !== task.id || event.payload.attention !== `question:${input.questionId}`
        || event.status === 'cancelled' || this.store.taskSourcesWithdrawn(task.id)
        || this.store.withdrawnIn(event.companionId, event.securityDomainId, this.store.eventSourceIds(event.id)).size)
        throw new Error('只有用户来源或当前任务的已绑定问题回执能回答执行器的问题。');
    }
    return this.store.taskTransaction(sql => this.control(sql, task, 'answer', input, () => {
      const answers = z.array(botTaskAnswerSchema).min(1).parse(input.answers);
      const saved = sql.prepare('SELECT * FROM bot_task_questions WHERE task_id=? AND question_id=?').get(task.id, input.questionId ?? '');
      if (!saved || row(saved).state !== 'queued' || task.extra.cancelRequested || ['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.status)) throw new Error('这个问题已回答、已关闭或不属于当前任务。');
      const question = this.questionRow(row(saved));
      if (answers.length !== question.questions.length || new Set(answers.map(item => item.id)).size !== answers.length) throw new Error('回答必须逐项对应原始问题。');
      for (const answer of answers) {
        const original = question.questions.find(item => item.id === answer.id);
        if (!original || new Set(answer.selected).size !== answer.selected.length || !original.multiSelect && answer.selected.length > 1
          || answer.selected.some(label => !original.options?.some(option => option.label === label)) || !answer.selected.length && !answer.custom?.trim()) throw new Error('回答包含无效问题或选项。');
      }
      sql.prepare("UPDATE bot_task_questions SET answers_json=?,state='answered' WHERE task_id=? AND question_id=?").run(JSON.stringify(answers), task.id, input.questionId);
      if (!attached) this.store.updateTask(task.id, { status: 'queued', extra: { ...task.extra, retryAt: 0 } });
      return { taskId: task.id, accepted: true, questionId: input.questionId };
    }));
  }
  pendingEffects(taskId: string): BotTaskPendingEffect[] {
    return this.store.taskTransaction(sql => sql.prepare("SELECT * FROM bot_task_effects WHERE task_id=? AND state IN ('pending','unknown') ORDER BY created_at,call_id").all(taskId)
      .map(value => ({ callId: String(row(value).call_id), toolName: String(row(value).tool_name), argsHash: String(row(value).args_hash),
        argumentsPreview: String(row(value).preview), state: String(row(value).state) as 'pending' | 'unknown', ...this.savedNativeRef(taskId, row(value)) })));
  }
  startEffect(task: BotTask, input: unknown): BotWorkerEffectDecision {
    const parsed = effectStart.parse(input), value = { ...parsed, ...this.nativeRef(task.id, parsed.callId, parsed) };
    return this.store.taskTransaction(sql => {
      const prior = sql.prepare('SELECT * FROM bot_task_effects WHERE task_id=? AND call_id=?').get(task.id, value.callId);
      if (prior && (row(prior).tool_name !== value.toolName || row(prior).args_hash !== value.argsHash
        || JSON.stringify(this.savedNativeRef(task.id, row(prior))) !== JSON.stringify(this.nativeRef(task.id, value.callId, value)))) throw new Error('原生工具调用标识对应其他参数。');
      if (prior && ['committed', 'failed', 'user_applied'].includes(String(row(prior).state))) return { state: 'already_committed', callId: value.callId,
        provenance: row(prior).state === 'user_applied' ? 'user_verified_applied' : 'native_committed' };
      const applied = sql.prepare("SELECT 1 FROM bot_task_effects WHERE task_id=? AND tool_name=? AND args_hash=? AND state='user_applied' LIMIT 1").get(task.id, value.toolName, value.argsHash);
      if (applied) { this.effectRow(sql, task.id, value, 'user_applied', 'user_verified_applied'); return { state: 'already_committed', callId: value.callId, provenance: 'user_verified_applied' }; }
      const blocking = sql.prepare("SELECT 1 FROM bot_task_effects WHERE task_id=? AND tool_name=? AND args_hash=? AND state IN ('pending','unknown') LIMIT 1").get(task.id, value.toolName, value.argsHash);
      if (blocking || this.pendingEffects(task.id).length >= 64) {
        this.markUnknown(task); return { state: 'blocked', callId: value.callId, reason: '先前外部操作的结果未确认，需要用户逐项核实。' };
      }
      const retry = sql.prepare("SELECT call_id FROM bot_task_effects WHERE task_id=? AND tool_name=? AND args_hash=? AND state='retry_allowed' AND retry_budget=1 LIMIT 1").get(task.id, value.toolName, value.argsHash);
      if (retry) sql.prepare("UPDATE bot_task_effects SET state='superseded',retry_budget=0 WHERE task_id=? AND call_id=?").run(task.id, row(retry).call_id);
      this.effectRow(sql, task.id, value, 'pending', retry ? 'authorized_retry' : 'native_pending');
      return { state: 'admitted', callId: value.callId, provenance: retry ? 'authorized_retry' : undefined };
    });
  }
  private effectRow(sql: BotTaskSql, taskId: string, value: BotWorkerEffectStart, state: string, provenance: string): void {
    const now = new Date().toISOString(), native = this.nativeRef(taskId, value.callId, value);
    sql.prepare(`INSERT INTO bot_task_effects(task_id,call_id,tool_name,args_hash,preview,state,provenance,created_at,updated_at,native_session_id,native_call_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id,call_id) DO UPDATE SET state=excluded.state,provenance=excluded.provenance,retry_budget=0,updated_at=excluded.updated_at`)
      .run(taskId, value.callId, value.toolName, value.argsHash, value.argumentsPreview, state, provenance, now, now, native.nativeSessionId, native.nativeCallId);
  }
  commitEffect(task: BotTask, input: unknown): unknown {
    const parsed = effectCommit.parse(input), value = { ...parsed, ...this.nativeRef(task.id, parsed.callId, parsed) };
    return this.store.taskTransaction(sql => {
      const previous = sql.prepare('SELECT * FROM bot_task_effects WHERE task_id=? AND call_id=?').get(task.id, value.callId);
      if (!previous || row(previous).tool_name !== value.toolName || row(previous).args_hash !== value.argsHash
        || JSON.stringify(this.savedNativeRef(task.id, row(previous))) !== JSON.stringify(this.nativeRef(task.id, value.callId, value))) throw new Error('工具结果没有匹配的执行前回执。');
      if (['committed', 'failed'].includes(String(row(previous).state)) && Boolean(row(previous).is_error) !== value.isError) throw new Error('同一工具调用的耐久结果已确定，不能改写。');
      if (!['user_applied', 'superseded'].includes(String(row(previous).state))) sql.prepare('UPDATE bot_task_effects SET state=?,provenance=?,is_error=?,updated_at=? WHERE task_id=? AND call_id=?')
        .run(value.isError ? 'failed' : 'committed', 'native_committed', value.isError ? 1 : 0, new Date().toISOString(), task.id, value.callId);
      return { recorded: true, callId: value.callId };
    });
  }
  reconcileEffects(task: BotTask, proof: BotWorkerEffectInspection[]): boolean {
    return this.store.taskTransaction(sql => {
      for (const pending of this.pendingEffects(task.id)) {
        const found = proof.find(item => item.callId === pending.callId);
        if (found && ['committed', 'failed'].includes(found.state) && found.toolName === pending.toolName && found.argsHash === pending.argsHash
          && JSON.stringify(this.nativeRef(task.id, found.callId, found)) === JSON.stringify(this.nativeRef(task.id, pending.callId, pending))) {
          sql.prepare('UPDATE bot_task_effects SET state=?,provenance=?,is_error=? WHERE task_id=? AND call_id=?')
            .run(found.state, 'native_committed', found.state === 'failed' ? 1 : 0, task.id, pending.callId);
        } else sql.prepare("UPDATE bot_task_effects SET state='unknown' WHERE task_id=? AND call_id=?").run(task.id, pending.callId);
      }
      if (this.pendingEffects(task.id).length) { this.markUnknown(task); return false; }
      return true;
    });
  }
  markUnknown(task: BotTask): void {
    this.store.taskTransaction(() => {
      const current = this.store.getTask(task.id)!; if (['paused', 'succeeded', 'failed', 'cancelled'].includes(current.status)) return;
      this.store.updateTask(task.id, { status: 'unknown', error: '外部操作结果未确认，请逐项核实后再继续。', extra: { ...current.extra, retryAt: Date.now() + 30000 } });
      this.notice(task, 'unknown:' + digest(JSON.stringify(this.pendingEffects(task.id).map(item => item.callId))), `任务 ${task.id} 的外部操作结果未确认，已暂停；需要用户核实，未重新执行。`);
    });
  }
  resume(task: BotTask, input: BotTaskControlInput): unknown {
    if (input.caller !== 'user') throw new Error('只有用户界面可以核实外部操作并恢复。');
    return this.store.taskTransaction(sql => this.control(sql, task, 'resume', input, () => {
      if (task.status !== 'unknown' || task.extra.cancelRequested || !input.text?.trim()) throw new Error('恢复需要待核实任务及用户核实说明。');
      const pending = this.pendingEffects(task.id), resolutions = z.array(botEffectResolutionSchema).min(1).max(64).parse(input.effectResolutions);
      if (!pending.length || resolutions.length !== pending.length || new Set(resolutions.map(item => item.callId)).size !== pending.length
        || pending.some(item => !resolutions.some(entry => entry.callId === item.callId))) throw new Error('必须逐项核实全部未确认操作。');
      for (const resolution of resolutions) sql.prepare('UPDATE bot_task_effects SET state=?,provenance=?,retry_budget=? WHERE task_id=? AND call_id=?')
        .run(resolution.decision === 'already_applied' ? 'user_applied' : 'retry_allowed', resolution.decision === 'already_applied' ? 'user_verified_applied' : 'authorized_retry',
          resolution.decision === 'retry' ? 1 : 0, task.id, resolution.callId);
      this.store.updateTask(task.id, { status: 'queued', error: '', extra: { ...task.extra, retryAt: 0 } });
      return { taskId: task.id, accepted: true, verifiedBy: 'user' };
    }));
  }
  private control(sql: BotTaskSql, task: BotTask, kind: string, input: BotTaskControlInput, execute: () => unknown): unknown {
    const fingerprint = digest(JSON.stringify({ kind, text: input.text, questionId: input.questionId, answers: input.answers, effectResolutions: input.effectResolutions }));
    const previous = sql.prepare('SELECT * FROM bot_task_controls WHERE task_id=? AND request_id=?').get(task.id, input.requestId);
    if (previous) { if (row(previous).fingerprint !== fingerprint) throw new Error('任务控制标识对应其他内容。'); return JSON.parse(String(row(previous).result_json)); }
    const result = execute(); sql.prepare('INSERT INTO bot_task_controls VALUES(?,?,?,?,?)').run(task.id, input.requestId, kind, fingerprint, JSON.stringify(result)); return result;
  }
  private notice(task: BotTask, key: string, content: string): void {
    const source = this.store.getEvent(task.sourceEventId); if (!source) throw new Error('任务来源事件不存在。');
    if (this.store.withdrawnIn(task.companionId, source.securityDomainId, [source.id]).has(source.id)) return;
    this.store.enqueueTaskNotice({ conversationId: task.conversationId, senderId: 'task-service', source: 'task', senderName: '任务回执', recipientIds: [task.companionId],
      sourceMessageId: `task-attention:${task.id}:${key}`, kind: 'task_progress', content, correlationId: source.correlationId, causationId: source.id,
      payload: { taskId: task.id, attention: key, hop: (source.source === 'user' ? 0 : Number(source.payload.hop ?? 0)) + 1 } });
  }
}
