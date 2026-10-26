import { z } from 'zod';
import { createHash } from 'node:crypto';
import { companionModelAdmissionRetryAfter } from './model';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { companionLearningGoalPlanSchema, companionLearningAssessmentSchema, type CompanionLearningGoal, type CompanionLearningGoalJob, type CompanionLearningGoalRead,
  type CompanionLearningGoalRound, type CompanionLearningGoalWorkspaceCommand } from '../../shared/companion-learning-goals';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';
import { learningTestBasis, learningTestInput, learningSelfTestResult, type CompanionLearningTestStep } from '../../companions/learning-goal-test-protocol';

export type GoalInferenceStage = 'plan' | 'learn' | 'consolidate' | 'questions' | 'answer' | 'assess';
export interface CompanionLearningGoalServiceOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  infer(input: { stage: GoalInferenceStage; goal: CompanionLearningGoal; round: CompanionLearningGoalRound; data: unknown; signal: AbortSignal }): Promise<unknown>;
  read(job: CompanionLearningGoalJob, signal: AbortSignal): Promise<{ reads: CompanionLearningGoalRead[]; issues: string[] }>;
  integrate(job: CompanionLearningGoalJob, signal: AbortSignal): Promise<{ memoryIds: string[]; integration?: CompanionLearningGoalRound['integration'] }>;
  recall(job: CompanionLearningGoalJob, questions: string[], signal: AbortSignal): Promise<{ text: string; candidateMemoryIds: string[]; executionReadset: CompanionExecutionReadset }>;
  validateRecall(job: CompanionLearningGoalJob, recall: NonNullable<NonNullable<CompanionLearningGoalRound['selfTestProgress']>['recall']>['value'], signal: AbortSignal): Promise<boolean>;
  ready?(goal: CompanionLearningGoal, signal: AbortSignal): Promise<{ ready: boolean; reason?: string; retryAfterMs?: number }>;
  blocked?(owner: string): boolean;
  changed(): void; report(error: unknown): void;
}
const evidence = z.object({ sourceId: z.string(), quote: z.string().min(1).max(1000) });
const learning = z.object({ summary: z.string().min(1).max(6000), claims: z.array(z.object({ text: z.string().min(1).max(2000), evidence: z.array(evidence).min(1).max(4) })).min(1).max(12) });
const questionsSchema = z.object({ questions: z.array(z.string().min(1).max(1500)).min(1).max(3) });
const answerSchema = z.object({ answers: z.array(z.string().max(3000)).max(5) });
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
      if (round.reads.some(read => !read.sourceMessageId || !read.excerpt)) throw new Error('本轮原始资料已经撤回，不能恢复旧模型阶段。');
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
        const ids = round.reads.map(read => read.sourceMessageId).filter((id): id is string => !!id);
        const actual = (await this.request({ type: 'memory.sources.filter', companionId: job.goal.companionId, conversationId: 'world_' + job.goal.companionId, ids })).memorySources ?? [];
        if (actual.length !== ids.length) throw new Error('自测真实资料来源已经撤回。');
        const sourceChecksums = round.selfTestProgress?.sourceChecksums ?? Object.fromEntries(actual.map(source => [source.id, createHash('sha256').update(source.content).digest('hex')]));
        const basis = learningTestBasis(job.goal, round, sourceChecksums);
        const saveStep = async (step: CompanionLearningTestStep) => {
          signal.throwIfAborted();
          const saved = (await this.request({ type: 'learning.goals.test.checkpoint', id: job.goal.id, leaseToken: job.leaseToken, sourceChecksums, step })).learningGoal?.lastRound;
          if (!saved || saved.id !== round.id || saved.status !== 'running' || !saved.selfTestProgress) throw new Error('本轮自测成功阶段没有形成可恢复回执。');
          round = saved; this.options.changed();
        };
        if (!round.selfTestProgress?.questions) await saveStep({ stage: 'questions', inputHash: learningTestInput(basis, round, 'questions'),
          value: questionsSchema.parse(await infer('questions', { reads: round.reads, claims: round.claims })) });
        const questions = round.selfTestProgress!.questions!.value.questions;
        if (!round.selfTestProgress!.recall) {
          const recalled = await this.options.recall(current(), questions, signal); signal.throwIfAborted();
          if (!await this.options.validateRecall(current(), recalled, signal)) throw new Error('自测实际回忆来源或文件已经变化。');
          await saveStep({ stage: 'recall', inputHash: learningTestInput(basis, round, 'recall'), value: recalled });
        }
        const recalled = round.selfTestProgress!.recall!.value;
        const validateRecall = async () => {
          signal.throwIfAborted(); await checkpoint('testing');
          if (!await this.options.validateRecall(current(), recalled, signal)) throw new Error('自测固定回忆的来源或实际文件已经撤回。');
        };
        await validateRecall();
        // Answers consume only actual fixed recall, never the read rubric.
        if (!round.selfTestProgress!.answer) await saveStep({ stage: 'answer', inputHash: learningTestInput(basis, round, 'answer'),
          value: answerSchema.parse(await infer('answer', { questions, recalled: recalled.text })) });
        await validateRecall();
        const answers = round.selfTestProgress!.answer!.value.answers;
        if (!round.selfTestProgress!.assess) {
          const currentState = (await this.request({ type: 'state.get', companionId: job.goal.companionId, conversationId: 'world_' + job.goal.companionId })).runtimeState;
          const state = { expectedStateRevision: currentState?.revision, currentFocus: currentState?.focus };
          const review = companionLearningAssessmentSchema.parse(await infer('assess', { questions, answers, reads: round.reads,
            currentFocus: state.currentFocus, nextPlanPurpose: '可选择提出基于真实资料及不足的下一关注点，不把自评分数当成掌握，也不产生关系或固定情绪奖励。' }));
          await validateRecall();
          await saveStep({ stage: 'assess', inputHash: learningTestInput(basis, round, 'assess', state), value: { review, ...state } });
        }
        round.selfTest = learningSelfTestResult(round);
        const { review, expectedStateRevision } = round.selfTestProgress!.assess!.value;
        round.gaps = review.gaps; round.nextPlan = review.nextPlan;
        if (review.stateReflection && expectedStateRevision) {
          const citations = verified(review.stateReflection.evidence);
          if (citations.length === review.stateReflection.evidence.length) round.stateReflection = { ...review.stateReflection, evidence: citations, expectedRevision: expectedStateRevision };
        }
      }
      await checkpoint('reflecting');
      round = { ...round, status: 'completed', updatedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
      await this.request({ type: 'learning.goals.finish', id: job.goal.id, leaseToken: job.leaseToken, round });
    } catch (error) {
      const admissionRetry = companionModelAdmissionRetryAfter(error);
      round = { ...round, status: signal.aborted || error instanceof WaitForLearning || admissionRetry !== undefined ? 'deferred' : 'failed', phase: 'waiting', updatedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        error: signal.aborted ? '本轮已停止，已完成的读取与正式记忆保留，未提交结果不再生效。' : error instanceof Error ? error.message.slice(0, 2000) : '本轮学习尚未完成。' };
      await this.request({ type: 'learning.goals.finish', id: job.goal.id, leaseToken: job.leaseToken, round,
        retryAfterMs: admissionRetry ?? (error instanceof WaitForLearning ? error.retryAfterMs : 60000) }).catch(() => undefined);
      if (!signal.aborted && !(error instanceof WaitForLearning) && admissionRetry === undefined) this.options.report(error);
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
