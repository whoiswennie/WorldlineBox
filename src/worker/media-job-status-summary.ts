/**
 * WorldlineBox-e97c00：媒体任务状态摘要的有界缓存。
 *
 * 任务面板与常驻状态栏读的是「按状态分组的总数」。这条查询要遍历整个媒体任务历史
 * （真实 4.3 万资产库上中位约 110 ms，历史任务约 7.4 万条），并且会在每次完成事件后
 * 被再次读取；计划 §3.3 要求把它变成 O(1) 读，而不是每次重算。
 *
 * 这里采取的是「按变更序号校验 + 有界陈旧」而不是在每个写路径挂钩子：
 * `jobs` 表的 insert/update/delete 已经由 `library_change_on_jobs_*` 触发器 bump
 * `library_change_sequence`，忽略规则的变化则由 `browse_change_on_*_ignored_paths_*`
 * 触发器 bump `browse_change_sequence`——这两者共同决定摘要是否还有效（可见性过滤
 * 依赖忽略规则）。两个序号都相同才认为缓存必真；序号变化时若缓存还年轻
 * （< ttlMs），仍然返回缓存值——任务计数允许滞后一秒，否则繁忙队列会让每次读取都
 * 退回全表扫描，缓存等于没有。
 *
 * 计数器漂移不属于本模块职责：它只在序号未变时复用结果，任何写入都会让下一次读取
 * 在 ttlMs 内重新计算。忽略规则变化等需要立即准确的场景由调用方 `invalidate()`。
 */

export type MediaJobCounts = {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  paused: number;
  cancelled: number;
};

export const EMPTY_MEDIA_JOB_COUNTS: MediaJobCounts = {
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  paused: 0,
  cancelled: 0,
};

export type MediaJobSummarySource = 'hit' | 'stale-hit' | 'miss';

export type MediaJobSummaryRead = {
  /** 缓存里的计数；为 null 表示调用方必须重算。 */
  counts: MediaJobCounts | null;
  source: MediaJobSummarySource;
  ageMs: number;
  /** 上次重算时覆盖的可见任务总数，用于判断扫描规模。 */
  totalJobs: number;
};

export type MediaJobSummaryStats = {
  reads: number;
  hits: number;
  staleHits: number;
  misses: number;
  rebuilds: number;
  /** 最近一次重算覆盖的可见任务数。 */
  lastTotalJobs: number;
};

type SummaryEntry = {
  counts: MediaJobCounts;
  validationToken: string;
  storedAtMs: number;
  totalJobs: number;
};

/**
 * 陈旧窗口必须**大于**任务面板的轮询间隔，否则繁忙队列下每次读取都会过期重算，
 * 缓存等于没有。面板打开时约 1 Hz 轮询 + 完成事件触发，取 3 s 意味着最多 1 次重算
 * / 3 s，而任务计数滞后 3 秒对用户不可见（计划 §3.3 明确允许异步摘要）。
 */
const DEFAULT_STALE_WINDOW_MS = 3_000;

export class MediaJobStatusSummaryCache {
  readonly #entries = new Map<string, SummaryEntry>();

  readonly #ttlMs: number;

  readonly #now: () => number;

  #stats: MediaJobSummaryStats = {
    reads: 0,
    hits: 0,
    staleHits: 0,
    misses: 0,
    rebuilds: 0,
    lastTotalJobs: 0,
  };

  constructor(options: { staleWindowMs?: number; now?: () => number } = {}) {
    this.#ttlMs = Math.max(0, options.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS);
    this.#now = options.now ?? (() => Date.now());
  }

  read(libraryId: string, validationToken: string): MediaJobSummaryRead {
    this.#stats.reads += 1;
    const entry = this.#entries.get(libraryId);
    if (!entry) {
      this.#stats.misses += 1;
      return { counts: null, source: 'miss', ageMs: 0, totalJobs: 0 };
    }
    const ageMs = Math.max(0, this.#now() - entry.storedAtMs);
    if (entry.validationToken === validationToken) {
      this.#stats.hits += 1;
      return { counts: entry.counts, source: 'hit', ageMs, totalJobs: entry.totalJobs };
    }
    if (ageMs < this.#ttlMs) {
      this.#stats.staleHits += 1;
      return { counts: entry.counts, source: 'stale-hit', ageMs, totalJobs: entry.totalJobs };
    }
    this.#stats.misses += 1;
    return { counts: null, source: 'miss', ageMs, totalJobs: entry.totalJobs };
  }

  store(
    libraryId: string,
    validationToken: string,
    counts: MediaJobCounts,
    totalJobs: number,
  ): void {
    this.#entries.set(libraryId, {
      counts,
      validationToken,
      storedAtMs: this.#now(),
      totalJobs,
    });
    this.#stats.rebuilds += 1;
    this.#stats.lastTotalJobs = totalJobs;
  }

  invalidate(libraryId?: string): void {
    if (libraryId === undefined) this.#entries.clear();
    else this.#entries.delete(libraryId);
  }

  stats(): MediaJobSummaryStats {
    return { ...this.#stats };
  }

  resetStats(): void {
    this.#stats = {
      reads: 0,
      hits: 0,
      staleHits: 0,
      misses: 0,
      rebuilds: 0,
      lastTotalJobs: 0,
    };
  }
}

/** 把 `SELECT status, COUNT(*)` 的分组行折成摘要计数。 */
export function mediaJobCountsFromRows(
  rows: ReadonlyArray<{ status: string; count: number }>,
): MediaJobCounts {
  const counts: MediaJobCounts = { ...EMPTY_MEDIA_JOB_COUNTS };
  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as keyof MediaJobCounts] = row.count;
    }
  }
  return counts;
}

/** 摘要计数里可见媒体任务的总条数（用于日志/证据，不参与判定）。 */
export function mediaJobCountTotal(counts: MediaJobCounts): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}
