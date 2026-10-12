/**
 * Renderer-side coordinator for the background-task status fallback queries
 * (`media.list-jobs`, `ai.status`, `plugin.jobs.list`).
 *
 * Before this module the renderer polled all three once per second for every
 * open library, unconditionally, and started a second identical stream while
 * the Background Tasks panel was open. Nothing coalesced them, so a Worker that
 * was blocked for 30 seconds accumulated 30 overlapping requests per kind on
 * top of an already deep queue (WorldlineBox-e97c00 / WorldlineBox-52eed4).
 *
 * Invariants this class is responsible for:
 *  - at most one in-flight request per kind, per library generation;
 *  - any number of requests that arrive while a kind is in flight collapse into
 *    exactly one follow-up, so pending stays O(1) no matter how long the owner
 *    is blocked;
 *  - results that arrive after the library changed (or after stop) are dropped
 *    instead of overwriting fresher state;
 *  - polling backs off when nothing is active, the panel is closed, and no job
 *    event has arrived recently; a job event immediately refreshes and returns
 *    to the fast cadence;
 *  - a hidden window stops polling entirely and does one coalesced refresh when
 *    it becomes visible again.
 *
 * Worker events stay the primary source of truth for whether work is active;
 * this coordinator is the bounded fallback. Media counts now come from
 * `media.job-summary` (O(1)); `media.list-jobs` is only for the open panel's
 * cursor pages.
 */

export type JobStatusKind = "media" | "ai" | "plugin";

export type JobStatusProbeResult = {
  /** Latest snapshot for this kind, applied only if the library is unchanged. */
  value: unknown;
  /** True when this kind currently reports active or queued work. */
  active: boolean;
};

/** Returns `null` when the query failed and the last known state must stand. */
export type JobStatusProbe = () => Promise<JobStatusProbeResult | null>;

export type JobStatusCoordinatorStats = {
  /** Requests actually sent to the Worker. */
  requests: number;
  /** Requests that were folded into an already in-flight or pending request. */
  coalesced: number;
  /** Largest number of kinds waiting behind an in-flight request. */
  maxPending: number;
};

export interface JobStatusCoordinatorOptions {
  probes: Record<JobStatusKind, JobStatusProbe>;
  /**
   * Receives a fresh snapshot. Never called for a result that resolved after
   * the library changed, stopped, or was invalidated.
   */
  onResult: (kind: JobStatusKind, value: unknown) => void;
  /** Called after every probe attempt, including failures and drops. */
  onSettled?: (kind: JobStatusKind) => void;
  /** Cadence while work is active, the panel is open, or an event just arrived. */
  activeIntervalMs?: number;
  /** Cadence when the library looks idle and the panel is closed. */
  idleIntervalMs?: number;
  /** Closed-panel cadence while work is active (the badge is not on screen). */
  closedPanelIntervalMs?: number;
  now?: () => number;
}

const JOB_STATUS_KINDS: readonly JobStatusKind[] = ["media", "ai", "plugin"];
const DEFAULT_ACTIVE_INTERVAL_MS = 1_000;
const DEFAULT_IDLE_INTERVAL_MS = 10_000;
/** Closed panel + active jobs: slow enough to disappear beside real browse work. */
const DEFAULT_CLOSED_PANEL_INTERVAL_MS = 15_000;

export class JobStatusCoordinator {
  readonly #probes: Record<JobStatusKind, JobStatusProbe>;
  readonly #onResult: (kind: JobStatusKind, value: unknown) => void;
  readonly #onSettled: ((kind: JobStatusKind) => void) | undefined;
  readonly #activeIntervalMs: number;
  readonly #idleIntervalMs: number;
  readonly #closedPanelIntervalMs: number;

  readonly #inFlight = new Set<JobStatusKind>();
  readonly #pending = new Set<JobStatusKind>();
  readonly #activeByKind = new Map<JobStatusKind, boolean>();
  readonly #stats: JobStatusCoordinatorStats = { requests: 0, coalesced: 0, maxPending: 0 };

  #panelOpen = false;
  // Default to the closed-panel budget before React's first effect applies
  // the actual panel state. A thumbnail burst can arrive while that initial
  // effect is still pending; it must not turn every completion into a full
  // status/list query.
  #eventDrivenQueries = false;
  #hidden = false;
  #running = false;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: JobStatusCoordinatorOptions) {
    this.#probes = options.probes;
    this.#onResult = options.onResult;
    this.#onSettled = options.onSettled;
    this.#activeIntervalMs = options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS;
    this.#idleIntervalMs = Math.max(
      options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS,
      options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS,
    );
    this.#closedPanelIntervalMs = Math.max(
      options.closedPanelIntervalMs ?? DEFAULT_CLOSED_PANEL_INTERVAL_MS,
      options.activeIntervalMs ?? DEFAULT_ACTIVE_INTERVAL_MS,
    );
  }

  /** Begin the fallback cadence and refresh every kind once. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.refreshAll();
  }

  stop(): void {
    this.#running = false;
    this.#generation += 1;
    this.#pending.clear();
    this.#clearTimer();
  }

  /**
   * The library (or its generation) changed: drop queued work and stale
   * results, then reload from the new library exactly once.
   */
  invalidate(): void {
    this.#generation += 1;
    this.#pending.clear();
    this.#activeByKind.clear();
    if (this.#running) this.refreshAll();
  }

  setPanelOpen(open: boolean): void {
    if (this.#panelOpen === open) return;
    this.#panelOpen = open;
    if (open) this.refreshAll();
    this.#schedule();
  }

  setHidden(hidden: boolean): void {
    if (this.#hidden === hidden) return;
    this.#hidden = hidden;
    if (!hidden) this.refreshAll();
    this.#schedule();
  }

  /** A Worker/main event proves something changed: refresh that kind now. */
  noteActivity(kind: JobStatusKind): void {
    // Panel closed: an event must not turn into a full status re-query. The
    // canvas does not show job counters, so the slow fallback is enough.
    if (!this.#panelOpen && !this.#eventDrivenQueries) {
      this.#schedule();
      return;
    }
    this.#request(kind);
    this.#schedule();
    this.#pump();
  }

  /**
   * Enable querying on completion events. Enabled while the tasks panel is
   * open (its numbers must track reality) and disabled during plain browsing.
   */
  setEventDrivenQueries(enabled: boolean): void {
    if (this.#eventDrivenQueries === enabled) return;
    this.#eventDrivenQueries = enabled;
    if (enabled) this.refreshAll();
  }

  refreshAll(): void {
    for (const kind of JOB_STATUS_KINDS) this.#request(kind);
    this.#schedule();
    this.#pump();
  }

  stats(): JobStatusCoordinatorStats {
    return { ...this.#stats };
  }

  /**
   * Start whatever is queued. Each kind runs independently: a query that never
   * returns must not stop the other kinds from being refreshed.
   */
  #pump(): void {
    if (!this.#running) return;
    for (const kind of JOB_STATUS_KINDS) {
      if (!this.#pending.has(kind) || this.#inFlight.has(kind)) continue;
      this.#pending.delete(kind);
      this.#inFlight.add(kind);
      this.#stats.requests += 1;
      void this.#runProbe(kind);
    }
  }

  async #runProbe(kind: JobStatusKind): Promise<void> {
    const generation = this.#generation;
    try {
      const outcome = await this.#probes[kind]();
      if (generation !== this.#generation || !this.#running) return;
      if (outcome === null) return;
      const active = outcome.active === true;
      this.#activeByKind.set(kind, active);
      this.#onResult(kind, outcome.value);
    } catch {
      // A transient Worker restart keeps the last known task state.
    } finally {
      this.#inFlight.delete(kind);
      this.#onSettled?.(kind);
      // A request that arrived mid-flight is served exactly once, next pass.
      if (this.#pending.has(kind)) this.#pump();
    }
  }

  /**
   * Record a request. A kind that already has queued or in-flight work keeps
   * exactly one follow-up slot, so the queue cannot grow with blocking time.
   */
  #request(kind: JobStatusKind): void {
    if (this.#pending.has(kind) || this.#inFlight.has(kind)) {
      this.#stats.coalesced += 1;
    }
    this.#pending.add(kind);
    this.#stats.maxPending = Math.max(this.#stats.maxPending, this.#pending.size);
  }

  #schedule(): void {
    this.#clearTimer();
    if (!this.#running || this.#hidden) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.refreshAll();
    }, this.#nextDelayMs());
  }

  #nextDelayMs(): number {
    if (this.#panelOpen) return this.#activeIntervalMs;
    // WorldlineBox-e97c00 (third round): with the tasks panel closed the badge is
    // decoration — a media completion event does not change what the user sees
    // on the canvas. Polling on those events produced 2.71 `media.list-jobs`
    // calls per second and ~206 s of Worker execution in a 344 s profile, which
    // starved the thumbnail pump and the browse queries the user *is* waiting
    // for. Closed panel therefore uses the slow fallback only.
    const anyActive = [...this.#activeByKind.values()].some(Boolean);
    return anyActive ? this.#closedPanelIntervalMs : this.#idleIntervalMs;
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

