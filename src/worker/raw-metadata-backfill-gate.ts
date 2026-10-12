const RAW_METADATA_BACKFILL_MIN_INTERVAL_MS = 2_000;

/**
 * WorldlineBox-288cd9：RAW metadata 回填的准入游标。
 *
 * 旧实现只有一个 2 秒节流：即使全库 RAW 都已有任务/产物，secondary pump 每 2 秒仍会
 * 重跑一次昂贵候选探测（真实库单次约 94 ms，profile 里累计约 22.6 秒）。
 *
 * 这里区分两件不同的事：
 * - **节流**：两次探测之间至少间隔 MIN_INTERVAL，避免密集重扫；
 * - **扫完（exhausted）**：探测没有用满预算，说明当前没有待处理的 RAW 资产。
 *
 * 扫完之后不再靠定时器重扫，而是等一个**有效性 token 变化**再重扫。当前 token
 * 使用不包含 jobs/artifacts 后台写入的 `browse_change_sequence`：新增资产、revision
 * 变化和忽略规则变化会令它变化；到期的 RAW failed retry 走独立的 retry-only 有界
 * requeue 路径，不会把 catalog cursor 重新置空。
 *
 * 全局准入上限（已有 queued/running/paused 任务占满预算）导致的 0 结果**不算扫完**：
 * 此时 `budgetCapped` 为真，门控继续按节流重试。
 */
export type RawMetadataBackfillProbeOutcome = {
  /** 本轮真正入队/重新入队的任务数。 */
  admitted: number;
  /** 本轮候选探测返回的行数（受准入预算限制）。 */
  probed: number;
  /** 探测用满了预算（或全局上限已满）：不能据此判定已扫完。 */
  budgetCapped: boolean;
};

type LibraryAdmissionState = {
  nextAttemptAtMs: number;
  /** 上一次判定「已扫完」时的有效性 token；token 不变就不再重扫。 */
  exhaustedToken: string | null;
};

export type RawMetadataBackfillPersistedGateState = {
  exhaustedToken: string | null;
};

export type RawMetadataBackfillGateStats = {
  attempts: number;
  /** `shouldAttempt` 因「已扫完且 token 未变」而拒绝的次数（验收：连续 100 次不再重扫）。 */
  exhaustedSkips: number;
  throttledSkips: number;
  exhaustedLibraries: number;
};

export class RawMetadataBackfillAdmissionGate {
  private readonly stateByLibrary = new Map<string, LibraryAdmissionState>();

  private counters: RawMetadataBackfillGateStats = {
    attempts: 0,
    exhaustedSkips: 0,
    throttledSkips: 0,
    exhaustedLibraries: 0,
  };

  shouldAttempt(libraryId: string, token: string | null, now = Date.now()): boolean {
    const state = this.stateByLibrary.get(libraryId);
    if (!state) return true;
    if (token !== null && state.exhaustedToken === token) {
      this.counters.exhaustedSkips += 1;
      return false;
    }
    if (now < state.nextAttemptAtMs) {
      this.counters.throttledSkips += 1;
      return false;
    }
    return true;
  }

  hasState(libraryId: string): boolean {
    return this.stateByLibrary.has(libraryId);
  }

  /** Rehydrate only the durable exhaustion decision after Worker restart. */
  restore(
    libraryId: string,
    persisted: RawMetadataBackfillPersistedGateState,
    now = Date.now(),
  ): void {
    this.stateByLibrary.set(libraryId, {
      nextAttemptAtMs: now,
      exhaustedToken: persisted.exhaustedToken,
    });
  }

  /** 记录一次探测：总是重新武装节流，并在适用时标记「已扫完」。 */
  noteResult(
    libraryId: string,
    token: string | null,
    outcome: RawMetadataBackfillProbeOutcome,
    now = Date.now(),
  ): void {
    const state = this.stateByLibrary.get(libraryId)
      ?? { nextAttemptAtMs: 0, exhaustedToken: null };
    state.nextAttemptAtMs = now + RAW_METADATA_BACKFILL_MIN_INTERVAL_MS;
    state.exhaustedToken = !outcome.budgetCapped && token !== null ? token : null;
    this.stateByLibrary.set(libraryId, state);
    this.counters.attempts += 1;
  }

  remainingDelayMs(libraryId: string, now = Date.now()): number {
    return Math.max(0, (this.stateByLibrary.get(libraryId)?.nextAttemptAtMs ?? 0) - now);
  }

  isExhausted(libraryId: string, token: string | null): boolean {
    if (token === null) return false;
    return this.stateByLibrary.get(libraryId)?.exhaustedToken === token;
  }

  cancel(libraryId: string): void {
    this.stateByLibrary.delete(libraryId);
  }

  stats(): RawMetadataBackfillGateStats {
    return { ...this.counters, exhaustedLibraries: this.#countExhausted() };
  }

  #countExhausted(): number {
    let count = 0;
    for (const state of this.stateByLibrary.values()) {
      if (state.exhaustedToken !== null) count += 1;
    }
    return count;
  }
}
