import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { createHash } from 'node:crypto';
import { companionAgentNoProgress, companionAgentRepeatsObservation, CompanionAgentNoProgressError, type CompanionAgentNoProgressProof } from './agent-progress';
import type { CompanionRejectedFinal } from '../../shared/companion-agent-run';
import { companionFinalProposalBytes, companionFinalProposalReceiptStatus, companionFinalProposalReceiptSchema, isCompanionFinalTurn } from '../../shared/companion-final-proposal';
export { CompanionAgentNoProgressError } from './agent-progress';

/** The durable decision/effect boundary shared by all character inference ports.
 * A domain supplies inference, authority checks and delivery validation. The
 * kernel owns ordering and resumption, never the domain's tools or identity. */
export interface CompanionAgentState {
  status: 'running' | 'done';
  turns: CompanionLoopTurn[];
  rejectedFinals?: CompanionRejectedFinal[];
}
export class CompanionAgentFinalValidationError extends Error {}
export interface CompanionAgentKernelOptions<T> {
  state: CompanionAgentState;
  signal?: AbortSignal;
  save(): Promise<unknown>;
  beforeStep?(step: number): Promise<void>;
  /** Real message/evidence/task versions only; clocks are not progress. */
  progressFingerprint?(): string | Promise<string>;
  /** Undefined means the host snapshot changed; rebuild this same step. */
  infer(step: number): Promise<CompanionLoopTurn | undefined>;
  execute(turn: CompanionLoopTurn, step: number): Promise<NonNullable<CompanionLoopTurn['results']>>;
  /** Validate first; failed delivery is not a completed invocation. */
  finish(turn: CompanionLoopTurn, step: number): Promise<T>;
  decisionCommitted?(turn: CompanionLoopTurn, step: number): void;
  resultsCommitted?(turn: CompanionLoopTurn, step: number): void;
  completed?(output: T, turn: CompanionLoopTurn): Promise<void>;
  /** End a finite host-read gate after its durable step. Failed steps discard
   * admission state; successful steps must finish their fresh source fence. */
  afterStep?(succeeded: boolean): Promise<void>;
  /** A bounded domain repair may request a different decision without replaying reads. */
  recoverNoProgress?(proof: CompanionAgentNoProgressProof): Promise<boolean>;
  /** Host may reject an uncommitted final while retaining its original bytes. */
  recoverFinal?(turn: CompanionLoopTurn, step: number, error: unknown): Promise<boolean>;
  /** A host-validated cached final can be retained as rejected audit history. */
  finalWasRejected?(turn: CompanionLoopTurn, step: number): boolean;
}

export async function runCompanionAgentKernel<T>(options: CompanionAgentKernelOptions<T>): Promise<T> {
  const { state, signal } = options;
  let progressFrom = 0;
  let progressEpoch: string | undefined;
  // Resume the final native turn: it can contain a planned call whose effect
  // has already committed in the domain's idempotent effect ledger.
  for (let step = Math.max(0, state.turns.length - 1); ; step++) {
    let failed = false;
    try {
    // Rejected final proposals also yield, rather than bypassing the quantum below.
    if (step && step % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    signal?.throwIfAborted();
    await options.beforeStep?.(step);
    const rawEpoch = await options.progressFingerprint?.();
    const epoch = rawEpoch === undefined ? undefined : createHash('sha256').update(rawEpoch).digest('hex');
    if (epoch !== progressEpoch) {
      // Old legacy turns lack a host epoch. Changed real input can proceed;
      // unchanged keyed history remains eligible for immediate suspension.
      const latest = state.turns.findLast(turn => !!turn.results);
      if (latest?.hostProgressKey !== epoch) progressFrom = state.turns.length;
      progressEpoch = epoch;
    }
    const completedTurns = state.turns.at(-1)?.calls.length && !state.turns.at(-1)?.results ? state.turns.slice(0, -1) : state.turns;
    let priorStall = companionAgentNoProgress(completedTurns, progressFrom);
    if (priorStall && epoch !== undefined && completedTurns.at(-1)?.hostProgressKey === epoch) {
      if (!await options.recoverNoProgress?.(priorStall)) throw new CompanionAgentNoProgressError(priorStall);
      progressFrom = state.turns.length; priorStall = undefined;
    }
    signal?.throwIfAborted();
    let turn = state.turns[step];
    if (turn && isCompanionFinalTurn(turn) && (options.finalWasRejected?.(turn, step)
      || companionFinalProposalReceiptStatus(turn) === 'rejected_before_execution'
      || state.rejectedFinals?.some(rejected => rejected.step === step
        && rejected.proposalChecksum === createHash('sha256').update(companionFinalProposalBytes(turn!)).digest('hex')))) continue;
    if (!turn) {
      turn = await options.infer(step);
      signal?.throwIfAborted();
      if (!turn) { step--; continue; }
      if (priorStall && companionAgentRepeatsObservation(turn, completedTurns.at(-1)!)) throw new CompanionAgentNoProgressError(priorStall);
      if (epoch !== undefined) turn.hostProgressKey = epoch;
      state.turns.push(turn);
      // Persist the exact model decision before dispatching any tool. A failed
      // save leaves this turn available to the caller, but causes no effects.
      await options.save();
      options.decisionCommitted?.(turn, step);
    }
    if (isCompanionFinalTurn(turn)) {
      let output: T;
      try {
        output = await options.finish(turn, step);
        if (turn.finalProposal && (companionFinalProposalReceiptStatus(turn) !== 'accepted_for_domain_commit'
          || turn.results!.some(result => companionFinalProposalReceiptSchema.parse(JSON.parse(result.content)).proposalChecksum
            !== createHash('sha256').update(companionFinalProposalBytes(turn)).digest('hex'))))
          throw new Error('领域最终提案尚未获得与原调用准确绑定的宿主接受回执。');
      }
      catch (error) { if (await options.recoverFinal?.(turn, step, error)) continue; throw error; }
      signal?.throwIfAborted();
      state.status = 'done';
      try { await options.save(); }
      catch (error) { state.status = 'running'; throw error; }
      await options.completed?.(output, turn);
      return output;
    }
    if (!turn.results) {
      const results = await options.execute(turn, step);
      signal?.throwIfAborted();
      // Every native call must receive exactly one corresponding result. In
      // particular, an interrupted parallel dispatch cannot become a complete
      // provider history with silently missing results.
      const expected = new Set(turn.calls.map(call => call.id));
      if (expected.size !== turn.calls.length || results.length !== expected.size
        || new Set(results.map(result => result.callId)).size !== expected.size
        || results.some(result => !expected.has(result.callId))) throw new Error('伙伴能力回执与本轮调用不完整匹配，保留待恢复步骤。');
      turn.results = results;
      await options.save();
      options.resultsCommitted?.(turn, step);
      const stalled = companionAgentNoProgress(state.turns, progressFrom);
      if (stalled) {
        if (!await options.recoverNoProgress?.(stalled)) throw new CompanionAgentNoProgressError(stalled);
        progressFrom = state.turns.length;
      }
    }
    } catch (error) { failed = true; throw error; }
    finally { await options.afterStep?.(!failed); }
  }
}
