import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { companionLearningGoalPlanSchema, type CompanionLearningGoal, type CompanionLearningGoalJob, type CompanionLearningGoalRead,
  type CompanionLearningGoalRound, type CompanionLearningGoalWorkspaceCommand } from '../../shared/companion-learning-goals';

export type GoalInferenceStage = 'plan' | 'learn' | 'consolidate' | 'questions' | 'answer' | 'assess';
export interface CompanionLearningGoalServiceOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  infer(input: { stage: GoalInferenceStage; goal: CompanionLearningGoal; round: CompanionLearningGoalRound; data: unknown; signal: AbortSignal }): Promise<unknown>;
  read(job: CompanionLearningGoalJob, signal: AbortSignal): Promise<{ reads: CompanionLearningGoalRead[]; issues: string[] }>;
  integrate(job: CompanionLearningGoalJob, signal: AbortSignal): Promise<{ memoryIds: string[]; integration?: CompanionLearningGoalRound['integration'] }>;
  recall(job: CompanionLearningGoalJob, questions: string[], signal: AbortSignal): Promise<{ text: string; candidateMemoryIds: string[] }>;
  ready?(goal: CompanionLearningGoal, signal: AbortSignal): Promise<{ ready: boolean; reason?: string; retryAfterMs?: number }>;
  blocked?(owner: string): boolean;
  changed(): void; report(error: unknown): void;
}
const evidence = z.object({ sourceId: z.string(), quote: z.string().min(1).max(1000) });
const learning = z.object({ summary: z.string().min(1).max(6000), claims: z.array(z.object({ text: z.string().min(1).max(2000), evidence: z.array(evidence).min(1).max(4) })).min(1).max(12) });
const questionsSchema = z.object({ questions: z.array(z.string().min(1).max(1500)).min(1).max(3) });
const answerSchema = z.object({ answers: z.array(z.string().max(3000)).max(5) });
const assessmentSchema = z.object({ evaluations: z.array(z.object({ evaluation: z.enum(['supported', 'partial', 'unsupported', 'unassessed']), rationale: z.string().max(2000), evidence: z.array(evidence).max(4) })).max(5),
  gaps: z.array(z.string().max(1500)).max(10), nextPlan: z.array(z.string().max(1500)).min(1).max(10),
  stateReflection: z.object({ focus: z.string().trim().min(1).max(300), reason: z.string().trim().min(1).max(1000), evidence: z.array(evidence).min(1).max(6) }).optional() });
class WaitForLearning extends Error { constructor(message: string, readonly retryAfterMs = 30000) { super(message); } }

/** Two bounded background rounds may coexist with chat; no whole-companion work lease. */
export class CompanionLearningGoalService {
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private readonly jobs = new Map<string, { owner: string; controller: AbortController; promise: Promise<void> }>();
  constructor(private readonly options: CompanionLearningGoalServiceOptions) {}
  start(): void {
    if (this.closed || this.timer) return;
    const next = () => { this.timer = undefined; void this.tick().catch(this.options.report).finally(() => { if (!this.closed) { this.timer = setTimeout(next, 5000); this.timer.unref(); } }); };
    this.timer = setTimeout(next, 500); this.timer.unref();
  }
  private async request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const result = await this.options.request(command); if (!result.ok) throw new Error(result.error ?? '学习目标存储不可用。'); return result;
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve(); if (this.pumping) return this.pumping;
    const task = this.pump(); this.pumping = task; void task.finally(() => { if (this.pumping === task) this.pumping = undefined; }).catch(() => undefined); return task;
  }
  private async pump(): Promise<void> {
    while (!this.closed && this.jobs.size < 2) {
      const job = (await this.request({ type: 'learning.goals.claim', excludedOwners: [], leaseMs: 120000 })).learningGoalJob;
      if (!job || this.closed) break;
      const controller = new AbortController();
      const promise = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.process(job, controller.signal))
        .catch(this.options.report).finally(() => { this.jobs.delete(job.goal.id); this.options.changed(); });
      this.jobs.set(job.goal.id, { owner: job.goal.companionId, controller, promise }); this.options.changed();
    }
  }
  private async process(job: CompanionLearningGoalJob, inputSignal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(10 * 60000), signal = AbortSignal.any([inputSignal, timeout]);
    let round = structuredClone(job.round), heartbeatBusy = false;
    const heartbeat = setInterval(() => { if (heartbeatBusy || signal.aborted) return; heartbeatBusy = true;
      void this.request({ type: 'learning.goals.heartbeat', id: job.goal.id, leaseToken: job.leaseToken, phase: round.phase, leaseMs: 120000 })
        .catch(() => { this.jobs.get(job.goal.id)?.controller.abort(new Error('学习目标租约或授权已经改变。')); }).finally(() => { heartbeatBusy = false; }); }, 20000); heartbeat.unref();
    const current = () => ({ ...job, round });
    const checkpoint = async (phase: CompanionLearningGoalRound['phase']) => {
      signal.throwIfAborted();
      if (this.options.blocked?.(job.goal.companionId)) throw new WaitForLearning('伙伴未激活或正在重置，学习将在恢复后继续。');
      const availability = await this.options.ready?.(job.goal, signal);
      if (availability && !availability.ready) throw new WaitForLearning(availability.reason ?? '等待下一个可学习时间。', availability.retryAfterMs);
      round = { ...round, phase, updatedAt: new Date().toISOString() };
      await this.request({ type: 'learning.goals.checkpoint', id: job.goal.id, leaseToken: job.leaseToken, round }); this.options.changed();
    };
    const infer = (stage: GoalInferenceStage, data: unknown) => this.options.infer({ stage, data, goal: job.goal, round, signal });
    const verified = (items: Array<{ sourceId: string; quote: string }>) => items.filter(item => round.reads.some(read => read.id === item.sourceId && read.excerpt.includes(item.quote)));
    try {
      if (!job.goal.materials.length && !job.goal.allowWeb) throw new WaitForLearning('请添加学习材料，或允许探索公开网页；本轮尚未调用模型或读取资料。', 5 * 60000);
      await checkpoint('planning');
      if (!round.plan) round.plan = companionLearningGoalPlanSchema.parse(await infer('plan', { lastRound: job.previousRound }));
      await checkpoint('reading');
      if (!round.reads.length) {
        const reading = await this.options.read(current(), signal); signal.throwIfAborted();
        const reads = reading.reads; round.readingIssues = reading.issues;
        if (!reads.length) throw new WaitForLearning('本轮没有读取到获准的有效资料，请提供材料或启用公开网页探索。', 5 * 60000);
        for (const read of reads.slice(0, 6)) {
          const response = await this.request({ type: 'learning.goals.source', id: job.goal.id, leaseToken: job.leaseToken, read });
          const receipt = response.learningGoal?.lastRound?.reads.find(item => item.id === read.id);
          if (!receipt?.sourceMessageId) throw new Error('真实阅读尚未登记为记忆来源。'); round.reads.push(receipt);
        }
      }
      await checkpoint('integrating');
      if (!round.summary) {
        const result = learning.parse(await infer('learn', { reads: round.reads }));
        round.claims = result.claims.map(claim => ({ ...claim, evidence: verified(claim.evidence) })).filter(claim => claim.evidence.length);
        if (!round.claims.length) throw new Error('本轮学习没有可核验的逐字资料引用，未写入无依据的结论。'); round.summary = result.summary;
      }
      await checkpoint('integrating');
      if (!round.memoryIds.length) { const integrated = await this.options.integrate(current(), signal); round.memoryIds = integrated.memoryIds; round.integration = integrated.integration; if (!round.memoryIds.length) throw new Error('学习结论尚未进入正式 VCP 记忆账本。'); }
      await checkpoint('testing');
      if (!round.selfTest) {
        const questions = questionsSchema.parse(await infer('questions', { reads: round.reads, claims: round.claims })).questions;
        const recalled = await this.options.recall(current(), questions, signal); signal.throwIfAborted();
        // Answers receive only the exact original goal, the questions and actual VCP recall.
        // No current round source text, summary, claims or rubric is supplied to this call.
        const answers = answerSchema.parse(await infer('answer', { questions, recalled: recalled.text })).answers;
        const currentState = (await this.request({ type: 'state.get', companionId: job.goal.companionId, conversationId: 'world_' + job.goal.companionId })).runtimeState;
        const review = assessmentSchema.parse(await infer('assess', { questions, answers, reads: round.reads,
          currentFocus: currentState?.focus, nextPlanPurpose: '可选择提出基于真实资料及不足的下一关注点，不把自评分数当成掌握，也不产生关系或固定情绪奖励。' }));
        const assessed = questions.map((question, index) => {
          const item = review.evaluations[index], citations = verified(item?.evidence ?? []), answer = answers[index] ?? '';
          const notAnswered = !answer.trim() || /^(?:我)?(?:不(?:知道|清楚|了解|确定)|无法(?:回答|确定|确认)|没有(?:足够|可用|实际|获得)|未(?:获取|获|得到|读))/u.test(answer.trim());
          return { question, answer, evaluation: !notAnswered && item && citations.length ? item.evaluation : 'unassessed' as const,
            rationale: notAnswered ? '本题未作答或明确表示未知，不能把材料中存在答案当作已经答对。' : item?.rationale ?? '模型没有提供本题评估。', evidence: citations };
        });
        round.selfTest = { kind: 'self_test', questions: assessed, supportedAnswers: assessed.filter(item => item.evaluation === 'supported').length,
          assessedQuestions: assessed.filter(item => item.evaluation !== 'unassessed').length,
          recall: { query: questions.join('\n').slice(0, 16000), contextHash: createHash('sha256').update(recalled.text).digest('hex'), contextCharacters: recalled.text.length, candidateMemoryIds: recalled.candidateMemoryIds.slice(0, 20) },
          disclaimer: '模型自测与自评，仅核验引用来自本轮实际读取材料，不代表客观考试正确率或已经掌握。' };
        round.gaps = review.gaps; round.nextPlan = review.nextPlan;
        if (review.stateReflection && currentState) {
          const citations = verified(review.stateReflection.evidence);
          if (citations.length === review.stateReflection.evidence.length) round.stateReflection = { ...review.stateReflection, evidence: citations, expectedRevision: currentState.revision };
        }
      }
      await checkpoint('reflecting');
      round = { ...round, status: 'completed', updatedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
      await this.request({ type: 'learning.goals.finish', id: job.goal.id, leaseToken: job.leaseToken, round });
    } catch (error) {
      round = { ...round, status: signal.aborted || error instanceof WaitForLearning ? 'deferred' : 'failed', phase: 'waiting', updatedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        error: signal.aborted ? '本轮已停止，已完成的读取与正式记忆保留，未提交结果不再生效。' : error instanceof Error ? error.message.slice(0, 2000) : '本轮学习尚未完成。' };
      await this.request({ type: 'learning.goals.finish', id: job.goal.id, leaseToken: job.leaseToken, round,
        retryAfterMs: error instanceof WaitForLearning ? error.retryAfterMs : 60000 }).catch(() => undefined);
      if (!signal.aborted && !(error instanceof WaitForLearning)) this.options.report(error);
    } finally { clearInterval(heartbeat); }
  }
  async handle(command: CompanionLearningGoalWorkspaceCommand): Promise<CompanionWorkspaceResponse> {
    if (this.closed) return { ok: false, error: '学习目标服务已关闭。' };
    const result = await this.request({ ...command, type: command.type.replace('memory.', '') } as CompanionStorageCommand);
    if (command.type === 'memory.learning.goals.update') this.jobs.get(command.id)?.controller.abort();
    if (!['memory.learning.goals.list', 'memory.learning.goals.rounds'].includes(command.type)) { this.options.changed(); void this.tick().catch(this.options.report); }
    return { ok: true, learningGoal: result.learningGoal, learningGoals: result.learningGoals, learningRounds: result.learningRounds };
  }
  cancel(owner: string): void { for (const job of this.jobs.values()) if (job.owner === owner) job.controller.abort(); }
  async drain(owner: string): Promise<void> { await this.pumping; this.cancel(owner); await Promise.allSettled([...this.jobs.values()].filter(job => job.owner === owner).map(job => job.promise)); }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); for (const job of this.jobs.values()) job.controller.abort(); await this.pumping; await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}
