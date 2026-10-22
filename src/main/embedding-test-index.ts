import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FilterClause, SearchScope } from "../shared/asset-types";

import {
  EMBEDDING_GEMMA2_DIMENSIONS,
  EMBEDDING_GEMMA2_TIER_FILES,
  SEMANTIC_SEARCH_MODELS,
  embeddingProfileKey,
  formatEmbeddingSearchQuery,
  meanPoolEmbeddings,
  normalizeEmbedding,
  type EmbeddingIndexSnapshot,
  type SemanticSearchModelId,
} from "../shared/embedding/profile";
import type { WorkerCommand } from "../shared/protocol/requests";
import type { RendererResult, WorkerResult } from "../shared/protocol/responses";
import { createPublicError } from "../shared/protocol/errors";
import { LOCAL_SEMANTIC_ENCODE_MODALITIES } from "../shared/embedding/modalities";
import { fitSemanticImage, SemanticImageLimitError } from "./embedding-image-fit";
import {
  GEMMA_SEMANTIC_IMAGE_MAX_BYTES,
  GEMMA_SEMANTIC_IMAGE_MAX_EDGE_PX,
  SEMANTIC_IMAGE_DECODE_MAX_BYTES,
} from "../shared/embedding/image-limits";
import {
  localEmbeddingFilesReady,
  readLocalEmbeddingTestConfig,
  type LocalEmbeddingTestConfig,
} from "./embedding-local-config";
import { startLlamaEmbeddingSession, type LlamaEmbeddingMediaBinaries, type LlamaEmbeddingSession } from "./embedding-llama-session";

type JobState = EmbeddingIndexSnapshot & {
  generation: number;
  libraryId: string;
  modelId: SemanticSearchModelId;
  sessionGeneration: string;
  profileKey: string;
};

type EmbeddingTarget = {
  assetId: string;
  revisionId: string;
  kind: "image" | "video" | "audio" | "text";
  alreadyIndexed: boolean;
  jobStatus?: "pending" | "running" | "ready" | "failed";
};

class SemanticPreparationError extends Error {}
class SemanticProviderError extends Error {}
const CATCH_UP_DELAY_MS = 500;

export function embeddingSkipKey(assetId: string, revisionId: string): string {
  return `${assetId}\u0000${revisionId}`;
}

/** Images that still need a vector. Same revision already stored, or already failed, is left alone. */
export function embeddingTargetsToEncode<T extends { assetId: string; revisionId: string }>(
  targets: readonly T[],
  encoded: ReadonlyMap<string, { revisionId: string }>,
  skipped: ReadonlySet<string>,
): T[] {
  return targets.filter((target) => {
    if (encoded.get(target.assetId)?.revisionId === target.revisionId) return false;
    return !skipped.has(embeddingSkipKey(target.assetId, target.revisionId));
  });
}

export type ScoredEmbedding = { assetId: string; score: number };

function compareScoredEmbeddings(left: ScoredEmbedding, right: ScoredEmbedding): number {
  return right.score - left.score || (
    left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0
  );
}

/** Exact cosine ranking for the already L2-normalized query and corpus vectors. */
export function scoreEmbeddings(
  query: readonly number[],
  entries: readonly { assetId: string; vector: readonly number[]; revisionId?: string }[],
): ScoredEmbedding[] {
  const scored = entries.map((entry) => {
    let score = 0;
    const length = Math.min(query.length, entry.vector.length);
    for (let index = 0; index < length; index += 1) {
      score += (query[index] ?? 0) * (entry.vector[index] ?? 0);
    }
    return { assetId: entry.assetId, score };
  });
  scored.sort(compareScoredEmbeddings);
  return scored;
}

export function rankEmbeddings(
  query: readonly number[],
  entries: readonly { assetId: string; vector: readonly number[] }[],
  limit: number,
): string[] {
  return scoreEmbeddings(query, entries)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.assetId);
}

/** Same-space image similarity. The source asset is not a result. */
export function rankSimilarAssetIds(
  sourceAssetId: string,
  entries: readonly { assetId: string; vector: readonly number[] }[],
): string[] {
  const source = entries.find((entry) => entry.assetId === sourceAssetId);
  if (!source) return [];
  return rankEmbeddings(
    source.vector,
    entries.filter((entry) => entry.assetId !== sourceAssetId),
    entries.length,
  );
}

/** Pull a requested asset ahead of the remaining encode queue. */
export function takeNextEmbeddingTarget<T extends { assetId: string }>(
  pending: readonly T[],
  priorityAssetId: string | null,
): { target: T; rest: readonly T[] } | null {
  if (pending.length === 0) return null;
  const priorityIndex = priorityAssetId === null
    ? -1
    : pending.findIndex((target) => target.assetId === priorityAssetId);
  const index = priorityIndex >= 0 ? priorityIndex : 0;
  const target = pending[index];
  if (!target) return null;
  return {
    target,
    rest: [...pending.slice(0, index), ...pending.slice(index + 1)],
  };
}

export function resolveContainedPath(root: string, relativePath: string): string | null {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/")) return null;
  const target = path.resolve(root, ...relativePath.split("/").filter(Boolean));
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return target;
}

function emptySnapshot(phase: EmbeddingIndexSnapshot["phase"] = "unavailable"): EmbeddingIndexSnapshot {
  return { phase, done: 0, total: 0, failedCount: 0 };
}

export class EmbeddingTestIndex {
  #generation = 0;
  #state: JobState | null = null;
  #session: LlamaEmbeddingSession | null = null;
  #sessionGate: Promise<LlamaEmbeddingSession | null> = Promise.resolve(null);
  #sessionStartController: AbortController | null = null;
  #sessionStartPromise: Promise<LlamaEmbeddingSession> | null = null;
  #sessionStartPromiseController: AbortController | null = null;
  #sessionStartFailure: AggregateError | null = null;
  #deferredCleanupFailure: { error: unknown } | null = null;
  #closing: Promise<void> | null = null;
  #closingLibraryId: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #skipped = new Set<string>();
  #imageLimitAssets = new Set<string>();
  #priorityAssetId: string | null = null;
  #catchUpRequested = false;
  #catchUpRunning = false;
  #catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  #activeQueryId: string | null = null;
  #activeQuerySessionGeneration: string | null = null;
  #activeQueryLibraryId: string | null = null;

  constructor(private readonly options: {
    configDirectories: readonly string[];
    requestWorker: (command: WorkerCommand) => Promise<WorkerResult>;
    installedLayout?: (modelId: SemanticSearchModelId) => LocalEmbeddingTestConfig | null;
    resolveMediaBinaries?: () => LlamaEmbeddingMediaBinaries | undefined;
    koffiPath?: string;
    startSession?: typeof startLlamaEmbeddingSession;
    ensureDeviceCapability?: (signal?: AbortSignal) => Promise<void>;
    devicePreference?: () => { backend?: 'cpu' | 'gpu'; deviceId?: string };
  }) {}

  close(libraryId?: string): Promise<void> {
    if (this.#closing && (libraryId === undefined || libraryId === this.#closingLibraryId)) return this.#closing;
    if (libraryId !== undefined && this.#state?.libraryId !== libraryId
      && this.#activeQueryLibraryId !== libraryId) return Promise.resolve();
    if (this.#closing) return this.#closing.then(() => this.close(libraryId));
    this.#closingLibraryId = this.#state?.libraryId ?? this.#activeQueryLibraryId;
    const closing = this.#closeIndex();
    this.#closing = closing;
    void closing.then(
      () => { if (this.#closing === closing) { this.#closing = null; this.#closingLibraryId = null; } },
      () => { if (this.#closing === closing) { this.#closing = null; this.#closingLibraryId = null; } },
    );
    return closing;
  }

  async #closeIndex(): Promise<void> {
    const state = this.#state;
    const activeQueryId = this.#activeQueryId;
    const activeQuerySessionGeneration = this.#activeQuerySessionGeneration;
    this.#generation += 1;
    this.#state = null;
    this.#activeQueryId = null;
    this.#activeQuerySessionGeneration = null;
    this.#activeQueryLibraryId = null;
    this.#priorityAssetId = null;
    this.#catchUpRequested = false;
    if (this.#catchUpTimer) clearTimeout(this.#catchUpTimer);
    this.#catchUpTimer = undefined;
    await this.#closeSession();
    if (state) {
      if (activeQueryId && activeQuerySessionGeneration) {
        void this.options.requestWorker({ type: "semantic.index.cancel-search", libraryId: state.libraryId,
          sessionGeneration: activeQuerySessionGeneration, queryId: activeQueryId }).catch(() => undefined);
      }
      await this.options.requestWorker({
        type: "semantic.index.close",
        libraryId: state.libraryId,
        sessionGeneration: state.sessionGeneration,
      }).catch(() => undefined);
    }
  }

  /**
   * Import and other asset changes already notify Main. Encode only the
   * pictures that are not in the current index, the same way a later thumbnail
   * wave only queues files that still need a preview.
   */
  catchUp(libraryId: string): void {
    const state = this.#state;
    if (!state || state.libraryId !== libraryId) return;
    if (state.phase === "unavailable" || state.phase === "failed") return;
    this.#catchUpRequested = true;
    if (state.phase !== "ready" || this.#catchUpRunning || this.#catchUpTimer) return;
    this.#catchUpTimer = setTimeout(() => {
      this.#catchUpTimer = undefined;
      const current = this.#state;
      if (!current || current.libraryId !== libraryId || current.phase !== "ready") return;
      void this.#catchUp(current.generation);
    }, CATCH_UP_DELAY_MS);
  }

  handleStatus(request: {
    libraryId: string;
    modelId: SemanticSearchModelId;
    run: boolean;
    restart: boolean;
    rebuild?: boolean;
  }): RendererResult {
    if (request.rebuild === true) {
      if (this.#state?.phase === "failed" && this.#state.libraryId === request.libraryId
        && this.#state.modelId === request.modelId) this.#rebuild(request.libraryId, request.modelId);
      return { ok: true, type: "embedding.index.status", ...this.#snapshot() };
    }
    if (request.run) this.#ensure(request);
    return { ok: true, type: "embedding.index.status", ...this.#snapshot() };
  }

  async handleSearch(request: {
    libraryId: string;
    modelId: SemanticSearchModelId;
    query: string;
    filters?: FilterClause[];
    scope?: SearchScope | null;
    showIgnored?: boolean;
  }): Promise<RendererResult> {
    const queryId = this.#startQuery(request.libraryId);
    this.#ensure({ ...request, restart: false });
    const session = await this.#sessionGate;
    const state = this.#state;
    if (this.#activeQueryId !== queryId) {
      return { ok: true, type: "embedding.search", ...this.#snapshot(), assetIds: [], scores: [] };
    }
    if (state?.phase === "failed") return { ok: false, error: createPublicError("INTERNAL_ERROR") };
    if (
      !session
      || !state
      || state.libraryId !== request.libraryId
      || state.modelId !== request.modelId
      || state.done === 0
    ) {
      return { ok: true, type: "embedding.search", ...this.#snapshot(), assetIds: [], scores: [] };
    }
    try {
      const vector = normalizeEmbedding(await this.#enqueue(() => session.embedText(
        formatEmbeddingSearchQuery(request.query),
      )));
      if (this.#activeQueryId !== queryId || this.#state?.generation !== state.generation) {
        return { ok: true, type: "embedding.search", ...this.#snapshot(), assetIds: [], scores: [] };
      }
      const ranked = await this.options.requestWorker({
        type: "semantic.index.search",
        libraryId: request.libraryId,
        sessionGeneration: state.sessionGeneration,
        queryId,
        profileKey: state.profileKey,
        vector,
        filters: request.filters,
        scope: request.scope,
        showIgnored: request.showIgnored,
      });
      if (!ranked.ok || ranked.type !== "semantic.index.ranked") {
        return { ok: false, error: createPublicError("INTERNAL_ERROR") };
      }
      if (ranked.cancelled || this.#activeQueryId !== queryId || this.#state?.generation !== state.generation) {
        return { ok: true, type: "embedding.search", ...this.#snapshot(), cancelled: true, assetIds: [], scores: [] };
      }
      return {
        ok: true,
        type: "embedding.search",
        ...this.#snapshot(),
        // Return the stable, exact ranking as an ID snapshot. Renderer pages
        // summaries from this order as the user scrolls; score thresholds and
        // a single fixed Top-K would either discard candidates or limit recall.
        assetIds: ranked.assetIds,
        scores: ranked.scores,
      };
    } catch {
      if (this.#activeQueryId !== queryId) {
        return { ok: true, type: "embedding.search", ...this.#snapshot(), assetIds: [], scores: [] };
      }
      return { ok: false, error: createPublicError("INTERNAL_ERROR") };
    }
  }

  async handleSimilar(request: {
    libraryId: string;
    modelId: SemanticSearchModelId;
    assetId: string;
    filters?: FilterClause[];
    scope?: SearchScope | null;
  }): Promise<RendererResult> {
    const queryId = this.#startQuery(request.libraryId);
    const state = this.#state;
    const snapshot = this.#snapshot();
    if (
      !state
      || state.libraryId !== request.libraryId
      || state.modelId !== request.modelId
      || state.phase === "unavailable"
      || state.phase === "failed"
    ) {
      return {
        ok: true,
        type: "embedding.similar",
        ...snapshot,
        status: "unavailable",
        sourceAssetId: request.assetId,
        assetIds: [],
      };
    }
    let ranked = await this.options.requestWorker({
      type: "semantic.index.similar",
      libraryId: request.libraryId,
      sessionGeneration: state.sessionGeneration,
      queryId,
      profileKey: state.profileKey,
      sourceAssetId: request.assetId,
      filters: request.filters,
      scope: request.scope,
    });
    if (this.#activeQueryId !== queryId) {
      return { ok: true, type: "embedding.similar", ...this.#snapshot(), status: "preparing", sourceAssetId: request.assetId, assetIds: [] };
    }
    if (ranked.ok && ranked.type === "semantic.index.ranked" && ranked.sourceStatus === "preparing"
      && ranked.sourceTarget && this.#session && this.#state?.generation === state.generation) {
      this.#priorityAssetId = request.assetId;
      try {
        const targetPage = await this.#listTargets(request.libraryId, state, 0, null, request.assetId);
        const target = targetPage.targets.find((entry) => entry.assetId === request.assetId);
        if (target && !target.alreadyIndexed) await this.#encodeTargets(state.generation, this.#session, [target]);
      } catch {
        // Similarity stays in preparing state; catch-up can retry after transient file changes.
      } finally {
        this.#priorityAssetId = null;
      }
      if (this.#activeQueryId === queryId && this.#state?.generation === state.generation) {
        ranked = await this.options.requestWorker({
          type: "semantic.index.similar",
          libraryId: request.libraryId,
          sessionGeneration: state.sessionGeneration,
          queryId,
          profileKey: state.profileKey,
          sourceAssetId: request.assetId,
          filters: request.filters,
          scope: request.scope,
        });
      }
    }
    if (this.#activeQueryId !== queryId || this.#state?.generation !== state.generation) {
      return { ok: true, type: "embedding.similar", ...this.#snapshot(), status: "preparing", sourceAssetId: request.assetId, assetIds: [] };
    }
    if (!ranked.ok || ranked.type !== "semantic.index.ranked") {
      return { ok: false, error: createPublicError("INTERNAL_ERROR") };
    }
    if (ranked.cancelled) {
      return { ok: true, type: "embedding.similar", ...this.#snapshot(), status: "preparing", sourceAssetId: request.assetId, assetIds: [] };
    }
    if (ranked.sourceStatus === "failed" && this.#imageLimitAssets.has(request.assetId)) {
      return { ok: false, error: createPublicError("SEMANTIC_IMAGE_TOO_LARGE") };
    }
    return {
      ok: true,
      type: "embedding.similar",
      ...snapshot,
      status: ranked.sourceStatus ?? (ranked.sourceTarget ? "preparing" : "ready"),
      sourceAssetId: request.assetId,
      assetIds: ranked.assetIds,
    };
  }

  #snapshot(): EmbeddingIndexSnapshot {
    if (!this.#state) return emptySnapshot();
    return {
      phase: this.#state.phase,
      done: this.#state.done,
      total: this.#state.total,
      failedCount: this.#state.failedCount,
    };
  }

  #ensure(request: {
    libraryId: string;
    modelId: SemanticSearchModelId;
    restart: boolean;
  }): void {
    const current = this.#state;
    if (
      current
      && current.libraryId === request.libraryId
      && current.modelId === request.modelId
    ) {
      if (current.phase === "starting" || current.phase === "indexing" || current.phase === "ready") return;
      if (!request.restart) return;
    }
    const config = this.options.installedLayout
      ? this.options.installedLayout(request.modelId)
      : readLocalEmbeddingTestConfig(this.options.configDirectories);
    if (!config || !localEmbeddingFilesReady(config, request.modelId)) {
      const generation = ++this.#generation;
      void this.#closeSession().catch((error: unknown) => {
        this.#deferredCleanupFailure = { error };
        if (this.#state?.generation === generation) this.#write(generation, { phase: "failed" });
      });
      this.#state = {
        ...emptySnapshot("unavailable"),
        generation,
        libraryId: request.libraryId,
        modelId: request.modelId,
        sessionGeneration: randomUUID(),
        profileKey: "",
      };
      this.#sessionGate = Promise.resolve(null);
      return;
    }
    this.#generation += 1;
    this.#priorityAssetId = null;
    this.#skipped.clear();
    this.#imageLimitAssets.clear();
    this.#catchUpRequested = false;
    const generation = this.#generation;
    this.#sessionStartController?.abort(new Error("Semantic runtime startup was superseded."));
    const startController = new AbortController();
    this.#sessionStartController = startController;
    this.#state = {
      ...emptySnapshot("starting"),
      generation,
      libraryId: request.libraryId,
      modelId: request.modelId,
      sessionGeneration: randomUUID(),
      profileKey: embeddingProfileKey(SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === request.modelId)!.tier),
    };
    let resolveGate: (session: LlamaEmbeddingSession | null) => void = () => undefined;
    this.#sessionGate = new Promise((resolve) => {
      resolveGate = resolve;
    });
    void this.#run(generation, request.libraryId, request.modelId, config, resolveGate, startController);
  }

  #rebuild(libraryId: string, modelId: SemanticSearchModelId): void {
    const failed = this.#state;
    if (!failed || failed.phase !== "failed" || failed.libraryId !== libraryId || failed.modelId !== modelId) return;
    this.#generation += 1;
    const generation = this.#generation;
    const sessionGeneration = randomUUID();
    this.#state = { ...failed, phase: "starting", done: 0, total: 0, failedCount: 0,
      generation, sessionGeneration };
    void (async () => {
      await this.#closeSession();
      const rebuilt = await this.options.requestWorker({
        type: "semantic.index.rebuild", libraryId, sessionGeneration, confirmed: true,
      });
      if (!rebuilt.ok || rebuilt.type !== "semantic.index.rebuilt") throw new Error("Semantic index rebuild failed.");
      if (this.#state?.generation !== generation) return;
      this.#state = null;
      this.#ensure({ libraryId, modelId, restart: true });
    })().catch(() => {
      this.#write(generation, { phase: "failed" });
    });
  }

  async #run(
    generation: number,
    libraryId: string,
    modelId: SemanticSearchModelId,
    config: LocalEmbeddingTestConfig,
    resolveGate: (session: LlamaEmbeddingSession | null) => void,
    startController: AbortController,
  ): Promise<void> {
    try {
      await this.#closeSession(startController);
      const initial = this.#state;
      if (!initial || initial.generation !== generation) {
        resolveGate(null);
        return;
      }
      const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === modelId);
      if (!model) throw new Error("Unknown semantic model.");
      const begun = await this.options.requestWorker({
        type: "semantic.index.begin",
        libraryId,
        sessionGeneration: initial.sessionGeneration,
        profileKey: initial.profileKey,
        dimensions: EMBEDDING_GEMMA2_DIMENSIONS,
        modelRevision: `${model.id}:${model.tier}`,
        modality: "mixed",
        modalities: [...LOCAL_SEMANTIC_ENCODE_MODALITIES],
        maxInputBytes: SEMANTIC_IMAGE_DECODE_MAX_BYTES,
      });
      if (!begun.ok || begun.type !== "semantic.index.started") throw new Error("Semantic index is unavailable.");
      const imported = await this.options.requestWorker({ type: "semantic.index.import-legacy", libraryId,
        sessionGeneration: initial.sessionGeneration, cacheKind: "local", cacheId: modelId });
      if (!imported.ok || imported.type !== "semantic.index.legacy-imported") {
        throw new Error("Legacy semantic cache migration could not be checked.");
      }
      const starting = this.#openSession(config, modelId, startController.signal);
      this.#sessionStartPromise = starting;
      this.#sessionStartPromiseController = startController;
      let session: LlamaEmbeddingSession;
      try {
        session = await starting;
      } finally {
        if (this.#sessionStartPromise === starting) this.#sessionStartPromise = null;
        if (this.#sessionStartPromiseController === startController) this.#sessionStartPromiseController = null;
      }
      if (this.#state?.generation !== generation) {
        await session.close().catch((error: unknown) => {
          throw new AggregateError([error], "Superseded semantic runtime cleanup failed.");
        });
        resolveGate(null);
        return;
      }
      if (this.#sessionStartController === startController) this.#sessionStartController = null;
      this.#session = session;
      resolveGate(session);
      this.#write(generation, { phase: "indexing", done: 0, total: 0 });
      let offset = 0;
      let revisionSnapshot: number | null = null;
      let done = 0;
      let total = 0;
      do {
        if (this.#state?.generation !== generation) return;
        const page = await this.#listTargets(libraryId, initial, offset, revisionSnapshot);
        if (page.snapshotChanged) {
          offset = 0;
          revisionSnapshot = null;
          done = 0;
          total = 0;
          this.#write(generation, { done, total });
          continue;
        }
        revisionSnapshot = page.revisionSnapshot;
        total += page.targets.length;
        done += page.targets.filter((target) => target.alreadyIndexed).length;
        this.#write(generation, { total, done });
        if (page.targets.some((target) => !target.alreadyIndexed)) {
          this.#write(generation, { phase: "indexing" });
          const finished = await this.#encodeTargets(generation, session, page.targets.filter((target) => !target.alreadyIndexed));
          if (!finished) return;
        }
        offset = page.nextOffset ?? 100_001;
      } while (offset <= 100_000);
      if (this.#catchUpRequested) {
        await this.#catchUp(generation);
        return;
      }
      this.#write(generation, { phase: "ready" });
    } catch (error: unknown) {
      if (error instanceof AggregateError) {
        this.#sessionStartFailure = error;
      }
      if (this.#state?.generation !== generation) {
        resolveGate(null);
        return;
      }
      this.#write(generation, { phase: "failed" });
      resolveGate(null);
    }
  }

  async #catchUp(generation: number): Promise<void> {
    if (this.#catchUpRunning) return;
    this.#catchUpRunning = true;
    try {
      while (this.#state?.generation === generation && this.#catchUpRequested) {
        this.#catchUpRequested = false;
        const state = this.#state;
        const session = this.#session;
        if (!state || !session) return;
        let offset = 0;
        let revisionSnapshot: number | null = null;
        let done = 0;
        let total = 0;
        this.#write(generation, { done: 0, total: 0, phase: "indexing" });
        do {
          const page = await this.#listTargets(state.libraryId, state, offset, revisionSnapshot);
          if (page.snapshotChanged) {
            offset = 0;
            revisionSnapshot = null;
            done = 0;
            total = 0;
            this.#write(generation, { done, total });
            continue;
          }
          revisionSnapshot = page.revisionSnapshot;
          total += page.targets.length;
          done += page.targets.filter((target) => target.alreadyIndexed).length;
          this.#write(generation, { total, done });
          const pending = page.targets.filter((target) => !target.alreadyIndexed);
          if (pending.length > 0) {
            const finished = await this.#encodeTargets(generation, session, pending);
            if (!finished) return;
          }
          offset = page.nextOffset ?? 100_001;
        } while (offset <= 100_000);
      }
      if (this.#state?.generation === generation) this.#write(generation, { phase: "ready" });
    } catch {
      if (this.#state?.generation === generation) this.#write(generation, { phase: "failed" });
    } finally {
      this.#catchUpRunning = false;
    }
  }

  async #encodeTargets(
    generation: number,
    session: LlamaEmbeddingSession,
    pending: readonly EmbeddingTarget[],
  ): Promise<boolean> {
    let remaining = pending;
    while (remaining.length > 0) {
      if (this.#state?.generation !== generation) return false;
      const next = takeNextEmbeddingTarget(remaining, this.#priorityAssetId);
      if (!next) return false;
      remaining = next.rest;
      const target = next.target;
      const claimToken = randomUUID();
      try {
        const claimed = await this.#setDurableJob(generation, target.assetId, target.revisionId, claimToken, "claim");
        if (!claimed) {
          if (target.jobStatus === "failed") {
            this.#write(generation, { failedCount: (this.#state?.failedCount ?? 0) + 1 });
          }
          continue;
        }
        const vector = await this.#embedTarget(generation, session, target);
        if (!vector || this.#state?.generation !== generation) return false;
        const state = this.#state;
        if (!state) return false;
        const written = await this.options.requestWorker({
          type: "semantic.index.write",
          libraryId: state.libraryId,
          sessionGeneration: state.sessionGeneration,
          profileKey: state.profileKey,
          vectors: [{ assetId: target.assetId, sourceRevision: target.revisionId, vector, claimToken }],
        });
        if (!written.ok || written.type !== "semantic.index.written"
          || !written.accepted.includes(target.assetId)) {
          this.#skipped.add(embeddingSkipKey(target.assetId, target.revisionId));
          await this.#setDurableJob(generation, target.assetId, target.revisionId, claimToken, "fail", "storage").catch(() => false);
          this.#write(generation, { failedCount: (this.#state?.failedCount ?? 0) + 1 });
        } else {
          this.#write(generation, { done: (this.#state?.done ?? 0) + 1 });
        }
      } catch (caught) {
        if (this.#state?.generation !== generation) return false;
        if (caught instanceof SemanticImageLimitError) this.#imageLimitAssets.add(target.assetId);
        const errorCategory = caught instanceof SemanticPreparationError || caught instanceof SemanticImageLimitError
          ? "preparation"
          : caught instanceof SemanticProviderError ? "provider" : "storage";
        await this.#setDurableJob(generation, target.assetId, target.revisionId, claimToken, "fail", errorCategory).catch(() => false);
        this.#skipped.add(embeddingSkipKey(target.assetId, target.revisionId));
        this.#write(generation, { failedCount: (this.#state?.failedCount ?? 0) + 1 });
      }
    }
    return this.#state?.generation === generation;
  }

  async #openSession(
    config: LocalEmbeddingTestConfig,
    modelId: SemanticSearchModelId,
    signal: AbortSignal,
  ): Promise<LlamaEmbeddingSession> {
    await this.options.ensureDeviceCapability?.(signal);
    signal.throwIfAborted();
    const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === modelId);
    if (!model) throw new Error("Unknown semantic model.");
    const files = EMBEDDING_GEMMA2_TIER_FILES[model.tier];
    const sessionFiles = {
      corePath: path.join(config.modelDirectory, files.coreFile),
      projectorPath: path.join(config.modelDirectory, files.projectorFile),
    };
    const mediaBinaries = this.options.resolveMediaBinaries?.();
    const startSession = this.options.startSession ?? startLlamaEmbeddingSession;
    const preference = this.options.devicePreference?.();
    const baseSessionOptions = {
      executable: config.runtimePath,
      files: sessionFiles,
      ...(mediaBinaries ? { mediaBinaries } : {}),
      ...(this.options.koffiPath ? { koffiPath: this.options.koffiPath } : {}),
    };
    try {
      return await startSession({
        ...baseSessionOptions,
        gpuLayers: preference?.backend === 'cpu' ? 0 : 99,
        ...(preference?.backend === 'cpu' ? { executable: config.cpuRuntimePath ?? config.runtimePath } : {}),
        ...(preference?.backend === 'gpu' && preference.deviceId ? { device: preference.deviceId } : {}),
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason ?? new Error("Semantic runtime startup was cancelled.");
      if (error instanceof AggregateError) throw error;
      if (preference?.backend) throw new Error('已通过检测的向量运行设备未能启动，请在设置的全局模型中重新检测。', { cause: error });
      return startSession({
        ...baseSessionOptions,
        executable: config.cpuRuntimePath ?? config.runtimePath,
        gpuLayers: 0,
        signal,
      });
    }
  }

  async #embedTarget(
    generation: number,
    session: LlamaEmbeddingSession,
    target: EmbeddingTarget,
  ): Promise<number[] | null> {
    const state = this.#state;
    if (!state || state.generation !== generation) return null;
    let prepared: WorkerResult;
    try {
      prepared = await this.options.requestWorker({
        type: "semantic.index.prepare",
        libraryId: state.libraryId,
        sessionGeneration: state.sessionGeneration,
        assetId: target.assetId,
        sourceRevision: target.revisionId,
        kind: target.kind,
        maxInputBytes: SEMANTIC_IMAGE_DECODE_MAX_BYTES,
      });
    } catch {
      throw new SemanticPreparationError("Semantic asset preparation failed.");
    }
    if (!prepared.ok || prepared.type !== "semantic.index.prepared" || prepared.kind !== target.kind) {
      throw new SemanticPreparationError("Semantic asset could not be prepared.");
    }
    if (target.kind === "audio") {
      if (!prepared.audioHandle || prepared.audioWindowCount === undefined) {
        throw new SemanticPreparationError("Audio payload is unavailable.");
      }
      try {
        const vectors: number[][] = [];
        for (let index = 0; index < prepared.audioWindowCount; index += 1) {
          if (this.#state?.generation !== generation) return null;
          let window: WorkerResult;
          try {
            window = await this.options.requestWorker({
              type: "semantic.index.audio-window",
              libraryId: state.libraryId,
              sessionGeneration: state.sessionGeneration,
              audioHandle: prepared.audioHandle,
              windowIndex: index,
            });
          } catch {
            throw new SemanticPreparationError("Audio window is unavailable.");
          }
          if (!window.ok || window.type !== "semantic.index.audio-window") {
            throw new SemanticPreparationError("Audio window is unavailable.");
          }
          if (this.#state?.generation !== generation) return null;
          vectors.push(await this.#embedWithProvider(() => session.embedAudioPayload(window.bytesBase64)));
        }
        if (this.#state?.generation !== generation) return null;
        if (vectors.length === 0) throw new SemanticPreparationError("Audio conversion produced no windows.");
        return meanPoolEmbeddings(vectors);
      } finally {
        await this.options.requestWorker({
          type: "semantic.index.audio.release",
          libraryId: state.libraryId,
          sessionGeneration: state.sessionGeneration,
          audioHandle: prepared.audioHandle,
        }).catch(() => undefined);
      }
    }
    if (target.kind === "text") {
      if (this.#state?.generation !== generation) return null;
      if (prepared.text === undefined) throw new SemanticPreparationError("Semantic text payload is unavailable.");
      const text = prepared.text;
      return this.#embedWithProvider(() => session.embedText(text));
    }
    if (target.kind === "video") {
      if (!prepared.videoWindows?.length) throw new SemanticPreparationError('Video windows are unavailable.');
      const vectors: number[][] = [];
      for (const window of prepared.videoWindows) {
        if (this.#state?.generation !== generation) return null;
        vectors.push(await this.#embedWithProvider(() => session.embedVideoPayload(window.bytesBase64, window.audioBase64)));
      }
      return meanPoolEmbeddings(vectors);
    }
    if (!prepared.mimeType || !prepared.bytesBase64) {
      throw new SemanticPreparationError("Semantic image payload is unavailable.");
    }
    const fitted = await fitSemanticImage({
      bytes: Buffer.from(prepared.bytesBase64, "base64"),
      mimeType: prepared.mimeType,
      maxEdgePx: GEMMA_SEMANTIC_IMAGE_MAX_EDGE_PX,
      maxBytes: GEMMA_SEMANTIC_IMAGE_MAX_BYTES,
    });
    if (this.#state?.generation !== generation) return null;
    return this.#embedWithProvider(() => session.embedImagePayload(
      fitted.mimeType,
      fitted.bytes.toString("base64"),
    ));
  }

  async #embedWithProvider(work: () => Promise<number[]>): Promise<number[]> {
    try {
      return normalizeEmbedding(await this.#enqueue(work));
    } catch {
      throw new SemanticProviderError("Embedding model request failed.");
    }
  }

  async #listTargets(
    libraryId: string,
    state: JobState,
    offset: number,
    revisionSnapshot: number | null,
    assetId?: string,
  ): Promise<{ targets: EmbeddingTarget[]; revisionSnapshot: number; nextOffset: number | null; snapshotChanged: boolean }> {
    const result = await this.options.requestWorker({
      type: "semantic.index.targets",
      libraryId,
      sessionGeneration: state.sessionGeneration,
      modalities: [...LOCAL_SEMANTIC_ENCODE_MODALITIES],
      offset,
      limit: 500,
      revisionSnapshot,
      ...(assetId ? { assetId } : {}),
    });
    if (!result.ok || result.type !== "semantic.index.targets") throw new Error("Semantic targets are unavailable.");
    return {
      revisionSnapshot: result.revisionSnapshot,
      snapshotChanged: result.snapshotChanged === true,
      nextOffset: result.nextOffset,
      targets: result.targets.map((target) => ({
        assetId: target.assetId,
        revisionId: target.sourceRevision,
        kind: target.kind,
        alreadyIndexed: target.alreadyIndexed,
        ...(target.jobStatus ? { jobStatus: target.jobStatus } : {}),
      })),
    };
  }

  async #setDurableJob(
    generation: number,
    assetId: string,
    sourceRevision: string,
    claimToken: string,
    action: "claim" | "fail",
    errorCategory?: "provider" | "preparation" | "storage",
  ): Promise<boolean> {
    const state = this.#state;
    if (!state || state.generation !== generation) return false;
    const result = await this.options.requestWorker({
      type: "semantic.index.job",
      libraryId: state.libraryId,
      sessionGeneration: state.sessionGeneration,
      action,
      claimToken,
      assetId,
      sourceRevision,
      ...(errorCategory ? { errorCategory } : {}),
    });
    return result.ok && result.type === "semantic.index.job-updated" && result.updated;
  }

  #write(generation: number, patch: Partial<JobState>): void {
    if (!this.#state || this.#state.generation !== generation) return;
    this.#state = { ...this.#state, ...patch };
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job, job);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #closeSession(preserveStartController?: AbortController): Promise<void> {
    if (this.#sessionStartController && this.#sessionStartController !== preserveStartController) {
      this.#sessionStartController.abort(new Error("Semantic runtime startup was cancelled."));
      this.#sessionStartController = null;
    }
    const session = this.#session;
    this.#session = null;
    const starting = this.#sessionStartPromise;
    const startingController = this.#sessionStartPromiseController;
    const startFailure = this.#sessionStartFailure;
    const deferredFailure = this.#deferredCleanupFailure;
    this.#sessionStartFailure = null;
    this.#deferredCleanupFailure = null;
    const results = await Promise.allSettled([
      ...(session ? [session.close()] : []),
      ...(startFailure ? [Promise.reject(startFailure)] : []),
      ...(deferredFailure ? [Promise.reject(deferredFailure.error)] : []),
      ...(starting ? [starting.then((opened) => opened.close(), (error: unknown) => {
        // The concrete session startup only rejects an aborted open after its
        // owner has confirmed tree cleanup. AggregateError marks an additional
        // cleanup failure and must remain observable by application shutdown.
        if (startingController?.signal.aborted && !(error instanceof AggregateError)) return;
        throw error;
      })] : []),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  #startQuery(libraryId: string): string {
    const previousQueryId = this.#activeQueryId;
    const previousSessionGeneration = this.#activeQuerySessionGeneration;
    const previousLibraryId = this.#activeQueryLibraryId;
    const queryId = randomUUID();
    this.#activeQueryId = queryId;
    this.#activeQuerySessionGeneration = this.#state?.libraryId === libraryId
      ? this.#state.sessionGeneration
      : null;
    this.#activeQueryLibraryId = libraryId;
    if (previousQueryId && previousSessionGeneration) {
      void this.options.requestWorker({
        type: "semantic.index.cancel-search",
        libraryId: previousLibraryId ?? libraryId,
        sessionGeneration: previousSessionGeneration,
        queryId: previousQueryId,
      }).catch(() => undefined);
    }
    return queryId;
  }
}
