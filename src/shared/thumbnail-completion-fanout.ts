import type { ThumbnailEvent } from "./protocol/responses";

/** Off-screen thumbnail completions merge into one IPC in this window. */
export const OFFSCREEN_THUMBNAIL_BATCH_MS = 75;
/** Hard cap on ready/failed items per batch event. Extra items flush as another event. */
export const OFFSCREEN_THUMBNAIL_BATCH_LIMIT = 100;

export type ThumbnailReadyItem = {
  assetId: string;
  artifactId: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type ThumbnailFailedItem = {
  assetId: string;
  errorCode: string;
  reason: string;
  width?: number;
  height?: number;
};

type FanoutTimer = unknown;

export type ThumbnailCompletionFanoutOptions = {
  publish: (event: ThumbnailEvent) => void;
  delayMs?: number;
  limit?: number;
  schedule?: (callback: () => void, delayMs: number) => FanoutTimer;
  cancel?: (timer: FanoutTimer) => void;
};

type LibraryFanoutState = {
  generation: number;
  immediateIds: Set<string>;
  ready: ThumbnailReadyItem[];
  failed: ThumbnailFailedItem[];
  timer: FanoutTimer | null;
};

function defaultSchedule(callback: () => void, delayMs: number): FanoutTimer {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function defaultCancel(timer: FanoutTimer): void {
  clearTimeout(timer as NodeJS.Timeout);
}

/**
 * Visible/focused completions stay per-asset. Background completions wait
 * 50–100 ms and leave as `asset.thumbnail.batch-ready` so Renderer IPC and
 * React work stay bounded while a large library is filling.
 */
export class ThumbnailCompletionFanout {
  readonly #publish: (event: ThumbnailEvent) => void;
  readonly #delayMs: number;
  readonly #limit: number;
  readonly #schedule: (callback: () => void, delayMs: number) => FanoutTimer;
  readonly #cancel: (timer: FanoutTimer) => void;
  readonly #states = new Map<string, LibraryFanoutState>();

  constructor(options: ThumbnailCompletionFanoutOptions) {
    this.#publish = options.publish;
    this.#delayMs = options.delayMs ?? OFFSCREEN_THUMBNAIL_BATCH_MS;
    this.#limit = Math.max(1, options.limit ?? OFFSCREEN_THUMBNAIL_BATCH_LIMIT);
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#cancel = options.cancel ?? defaultCancel;
  }

  setImmediateAssetIds(libraryId: string, assetIds: readonly string[]): void {
    const state = this.#ensure(libraryId);
    state.immediateIds = new Set(assetIds);
    this.#promoteQueued(libraryId, state);
  }

  addImmediateAssetIds(libraryId: string, assetIds: readonly string[]): void {
    if (assetIds.length === 0) return;
    const state = this.#ensure(libraryId);
    for (const assetId of assetIds) state.immediateIds.add(assetId);
    this.#promoteQueued(libraryId, state);
  }

  publishImmediate(event: ThumbnailEvent): void {
    this.#publish(event);
  }

  publish(event: ThumbnailEvent): void {
    if (event.type === "asset.thumbnail.ready") {
      this.publishReady({
        libraryId: event.libraryId,
        assetId: event.assetId,
        artifactId: event.artifactId,
        ...(event.width === undefined ? {} : { width: event.width }),
        ...(event.height === undefined ? {} : { height: event.height }),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      });
      return;
    }
    if (event.type === "asset.thumbnail.failed") {
      this.publishFailed({
        libraryId: event.libraryId,
        assetId: event.assetId,
        errorCode: event.errorCode,
        reason: event.reason,
        ...(event.width === undefined ? {} : { width: event.width }),
        ...(event.height === undefined ? {} : { height: event.height }),
      });
      return;
    }
    this.#publish(event);
  }

  publishReady(input: ThumbnailReadyItem & { libraryId: string }): void {
    const { libraryId, ...item } = input;
    const state = this.#ensure(libraryId);
    if (state.immediateIds.has(item.assetId)) {
      this.#publish({
        type: "asset.thumbnail.ready",
        libraryId,
        assetId: item.assetId,
        artifactId: item.artifactId,
        ...(item.width === undefined ? {} : { width: item.width }),
        ...(item.height === undefined ? {} : { height: item.height }),
        ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
      });
      return;
    }
    state.ready.push(item);
    this.#arm(libraryId, state);
  }

  publishFailed(input: ThumbnailFailedItem & { libraryId: string }): void {
    const { libraryId, ...item } = input;
    const state = this.#ensure(libraryId);
    if (state.immediateIds.has(item.assetId)) {
      this.#publish({
        type: "asset.thumbnail.failed",
        libraryId,
        assetId: item.assetId,
        errorCode: item.errorCode,
        reason: item.reason,
        ...(item.width === undefined ? {} : { width: item.width }),
        ...(item.height === undefined ? {} : { height: item.height }),
      });
      return;
    }
    state.failed.push(item);
    this.#arm(libraryId, state);
  }

  flush(libraryId?: string): void {
    if (libraryId) {
      const state = this.#states.get(libraryId);
      if (state) this.#flushState(libraryId, state);
      return;
    }
    for (const [id, state] of this.#states) this.#flushState(id, state);
  }

  clear(libraryId: string): void {
    const state = this.#states.get(libraryId);
    if (!state) return;
    if (state.timer !== null) this.#cancel(state.timer);
    state.generation += 1;
    this.#states.delete(libraryId);
  }

  dispose(): void {
    for (const libraryId of [...this.#states.keys()]) this.clear(libraryId);
  }

  #ensure(libraryId: string): LibraryFanoutState {
    const existing = this.#states.get(libraryId);
    if (existing) return existing;
    const created: LibraryFanoutState = {
      generation: 0,
      immediateIds: new Set(),
      ready: [],
      failed: [],
      timer: null,
    };
    this.#states.set(libraryId, created);
    return created;
  }

  #arm(libraryId: string, state: LibraryFanoutState): void {
    if (state.timer !== null) return;
    const generation = state.generation;
    state.timer = this.#schedule(() => {
      const current = this.#states.get(libraryId);
      if (!current || current.generation !== generation) return;
      current.timer = null;
      this.#flushState(libraryId, current);
    }, this.#delayMs);
  }

  #promoteQueued(libraryId: string, state: LibraryFanoutState): void {
    const ready: ThumbnailReadyItem[] = [];
    for (const item of state.ready) {
      if (state.immediateIds.has(item.assetId)) {
        this.#publish({
          type: "asset.thumbnail.ready",
          libraryId,
          assetId: item.assetId,
          artifactId: item.artifactId,
          ...(item.width === undefined ? {} : { width: item.width }),
          ...(item.height === undefined ? {} : { height: item.height }),
          ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
        });
      } else {
        ready.push(item);
      }
    }
    state.ready = ready;

    const failed: ThumbnailFailedItem[] = [];
    for (const item of state.failed) {
      if (state.immediateIds.has(item.assetId)) {
        this.#publish({
          type: "asset.thumbnail.failed",
          libraryId,
          assetId: item.assetId,
          errorCode: item.errorCode,
          reason: item.reason,
          ...(item.width === undefined ? {} : { width: item.width }),
          ...(item.height === undefined ? {} : { height: item.height }),
        });
      } else {
        failed.push(item);
      }
    }
    state.failed = failed;
    if (state.ready.length === 0 && state.failed.length === 0 && state.timer !== null) {
      this.#cancel(state.timer);
      state.timer = null;
    }
  }

  #flushState(libraryId: string, state: LibraryFanoutState): void {
    if (state.timer !== null) {
      this.#cancel(state.timer);
      state.timer = null;
    }
    while (state.ready.length > 0 || state.failed.length > 0) {
      const ready = state.ready.splice(0, this.#limit);
      const remaining = this.#limit - ready.length;
      const failed = remaining > 0 ? state.failed.splice(0, remaining) : [];
      this.#publish({
        type: "asset.thumbnail.batch-ready",
        libraryId,
        ready,
        failed,
        completedCount: ready.length + failed.length,
      });
    }
  }
}
