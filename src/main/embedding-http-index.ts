import { randomUUID } from "node:crypto";
import type { FilterClause, SearchScope } from "../shared/asset-types";
import { postEmbeddingHttp } from "./embedding-http";
import type { EmbeddingPurpose } from '../shared/embedding/global-profile';
import { fitSemanticImage, SemanticImageLimitError } from "./embedding-image-fit";
import { DASHSCOPE_VISUAL_SEARCH_INSTRUCT } from "../shared/embedding/http-service";
import { embeddingSkipKey } from "./embedding-test-index";
import {
  embeddingHttpProfileKey,
  type EmbeddingHttpAdapter,
  type EmbeddingHttpContent,
  type EmbeddingServiceDestination,
  type EmbeddingTextStatus,
} from "../shared/embedding/http-service";
import {
  type EmbeddingIndexSnapshot,
} from "../shared/embedding/profile";
import {
  embeddingInputModalitiesForAdapter,
  type EmbeddingModality,
  type EmbeddingSourceModality,
} from "../shared/embedding/modalities";
import type { WorkerCommand } from "../shared/protocol/requests";
import type { RendererResult, WorkerResult } from "../shared/protocol/responses";
import { createPublicError } from "../shared/protocol/errors";
import {
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
  normalizeSemanticImageBytes,
  normalizeSemanticImageEdgePx,
  SEMANTIC_IMAGE_DECODE_MAX_BYTES,
} from "../shared/embedding/image-limits";

type JobState = EmbeddingIndexSnapshot & {
  generation: number;
  libraryId: string;
  serviceId: string;
  sessionGeneration: string;
  profileKey: string;
  sourceModalitiesKey: string;
};

type HttpEmbeddingTarget = {
  assetId: string;
  revisionId: string;
  kind: "text" | "image";
  modality: EmbeddingSourceModality;
  alreadyIndexed: boolean;
  jobStatus?: "pending" | "running" | "ready" | "failed";
};

export type EmbeddingHttpServiceView = {
  id: string;
  adapter: EmbeddingHttpAdapter;
  destination: EmbeddingServiceDestination;
  baseUrl: string;
  modelName: string;
  textStatus: EmbeddingTextStatus;
  dimensions: number | null;
  grantedLibraryIds: readonly string[];
  modalities: readonly EmbeddingModality[];
  maxImageEdgePx?: number;
  maxImageBytes?: number;
  /** Managed local text encoders supply the same identity used by companion memory. */
  profileKey?: string;
};

export type EmbeddingIndexTextEncoder = (texts: readonly string[], input: {
  selectionId: string;
  purpose: EmbeddingPurpose;
  expectedProfileKey: string;
  signal?: AbortSignal;
}) => Promise<{ vectors: number[][] }>;

export class EmbeddingHttpIndex {
  #generation = 0;
  #state: JobState | null = null;
  #skipped = new Set<string>();
  #imageLimitAssets = new Set<string>();
  #runningGeneration: number | null = null;
  #activeQueryId: string | null = null;
  #activeQuerySessionGeneration: string | null = null;
  #activeQueryLibraryId: string | null = null;
  #queryControllers = new Map<string, AbortController>();
  #activeRequestControllers = new Set<AbortController>();

  constructor(private readonly options: {
    requestWorker: (command: WorkerCommand) => Promise<WorkerResult>;
    loadService: (id: string) => EmbeddingHttpServiceView | null;
    readKey: (id: string) => string | null;
    isLibraryEnabled?: (libraryId: string, serviceId: string) => boolean;
    /** Text requests share the global encoder; media keeps its configured HTTP adapter. */
    embed?: EmbeddingIndexTextEncoder;
  }) {}

  async close(libraryId?: string): Promise<void> {
    if (libraryId !== undefined && this.#state?.libraryId !== libraryId
      && this.#activeQueryLibraryId !== libraryId) return;
    const state = this.#state;
    const activeQueryId = this.#activeQueryId;
    const activeQuerySessionGeneration = this.#activeQuerySessionGeneration;
    const activeQueryLibraryId = this.#activeQueryLibraryId;
    this.#generation += 1;
    this.#abortRequests();
    this.#activeQueryId = null;
    this.#activeQuerySessionGeneration = null;
    this.#activeQueryLibraryId = null;
    this.#queryControllers.clear();
    this.#state = null;
    this.#skipped.clear();
    if (activeQueryId && activeQuerySessionGeneration && activeQueryLibraryId) {
      await this.options.requestWorker({ type: "semantic.index.cancel-search", libraryId: activeQueryLibraryId,
        sessionGeneration: activeQuerySessionGeneration, queryId: activeQueryId }).catch(() => undefined);
    }
    if (state) await this.options.requestWorker({
      type: "semantic.index.close",
      libraryId: state.libraryId,
      sessionGeneration: state.sessionGeneration,
    });
  }

  catchUp(libraryId: string): void {
    const state = this.#state;
    if (!state || state.libraryId !== libraryId || state.phase !== "ready") return;
    void this.#encode(state.generation, state.libraryId, state.serviceId);
  }

  handleStatus(request: {
    libraryId: string;
    modelId: string;
    run: boolean;
    rebuild?: boolean;
  }): RendererResult {
    const service = this.options.loadService(request.modelId);
    if (service && !this.#isLibraryEnabled(request.libraryId, request.modelId)) {
      return { ok: true, type: "embedding.index.status", phase: "unavailable", done: 0, total: 0,
        failedCount: 0, hold: "grant" };
    }
    if (request.rebuild === true) {
      if (this.#state?.phase === "failed" && this.#state.libraryId === request.libraryId
        && this.#state.serviceId === request.modelId) this.#rebuild(request.libraryId, request.modelId);
      return { ok: true, type: "embedding.index.status", ...this.#snapshot() };
    }
    if (request.run) {
      const current = this.#state;
      const active = current
        && current.libraryId === request.libraryId
        && current.serviceId === request.modelId
        && (current.phase === "starting" || current.phase === "indexing" || current.phase === "ready");
      if (!active) void this.#encode(this.#begin(request.libraryId, request.modelId), request.libraryId, request.modelId);
    }
    return { ok: true, type: "embedding.index.status", ...this.#snapshot() };
  }

  async handleSearch(request: {
    libraryId: string;
    modelId: string;
    query: string;
    filters?: FilterClause[];
    scope?: SearchScope | null;
    showIgnored?: boolean;
  }): Promise<RendererResult> {
    const queryId = this.#startQuery(request.libraryId);
    let requestController: AbortController | null = null;
    const service = this.options.loadService(request.modelId);
    if (!httpServiceReady(service) || !this.#isLibraryEnabled(request.libraryId, request.modelId)) {
      const grantMissing = Boolean(service && !this.#isLibraryEnabled(request.libraryId, request.modelId));
      return { ok: true, type: "embedding.search", phase: "unavailable", done: 0, total: 0,
        failedCount: 0, ...(grantMissing ? { hold: "grant" as const } : {}), assetIds: [], scores: [] };
    }
    const generation = this.#begin(request.libraryId, request.modelId);
    const indexedState = this.#state;
    if (indexedState?.phase !== "ready" || indexedState.generation !== generation) {
      void this.#encode(generation, request.libraryId, request.modelId);
    }
    const snapshot = this.#snapshot();
    const state = this.#state;
    if (state?.phase === "failed" && state.libraryId === request.libraryId && state.serviceId === request.modelId) {
      return { ok: false, error: createPublicError("INTERNAL_ERROR") };
    }
    if (!state || state.done === 0 || this.#activeQueryId !== queryId) {
      return { ok: true, type: "embedding.search", ...snapshot, assetIds: [], scores: [] };
    }
    try {
      const controller = new AbortController();
      requestController = controller;
      this.#activeRequestControllers.add(controller);
      this.#queryControllers.set(queryId, controller);
      const checkedService = this.#currentService(state);
      if (!checkedService) throw new Error("Embedding service configuration changed.");
      const [vector] = await this.#embed(checkedService, 'query', {
        baseUrl: checkedService.baseUrl,
        modelName: checkedService.modelName,
        adapter: checkedService.adapter,
        dimensions: checkedService.dimensions,
        inputs: [request.query],
        apiKey: this.options.readKey(checkedService.id),
        signal: controller.signal,
        instruct: checkedService.adapter === "dashscope-multimodal-v1"
          ? DASHSCOPE_VISUAL_SEARCH_INSTRUCT
          : null,
      });
      if (!vector || this.#activeQueryId !== queryId
        || this.#state?.generation !== generation || !this.#currentService(state)) {
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
      if (ranked.cancelled || this.#activeQueryId !== queryId || this.#state?.generation !== generation) {
        return { ok: true, type: "embedding.search", ...this.#snapshot(), cancelled: true, assetIds: [], scores: [] };
      }
      return {
        ok: true,
        type: "embedding.search",
        ...this.#snapshot(),
        assetIds: ranked.assetIds,
        scores: ranked.scores,
      };
    } catch {
      if (this.#activeQueryId !== queryId || requestController?.signal.aborted) {
        return { ok: true, type: "embedding.search", ...this.#snapshot(), assetIds: [], scores: [] };
      }
      return { ok: false, error: createPublicError("INTERNAL_ERROR") };
    } finally {
      if (requestController && this.#queryControllers.get(queryId) === requestController) {
        this.#queryControllers.delete(queryId);
      }
      if (requestController) this.#activeRequestControllers.delete(requestController);
    }
  }

  async handleSimilar(request: {
    libraryId: string;
    modelId: string;
    assetId: string;
    filters?: FilterClause[];
    scope?: SearchScope | null;
  }): Promise<RendererResult> {
    const queryId = this.#startQuery(request.libraryId);
    const state = this.#state;
    const snapshot = this.#snapshot();
    const service = this.options.loadService(request.modelId);
    const grantMissing = Boolean(service && !this.#isLibraryEnabled(request.libraryId, request.modelId));
    if (
      !state
      || state.libraryId !== request.libraryId
      || state.serviceId !== request.modelId
      || state.phase === "unavailable"
      || state.phase === "failed"
      || !httpServiceReady(service)
      || !this.#isLibraryEnabled(request.libraryId, request.modelId)
    ) {
      return {
        ok: true,
        type: "embedding.similar",
        ...snapshot,
        status: "unavailable",
        ...(grantMissing ? { hold: "grant" as const } : {}),
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
      && ranked.sourceTarget && this.#state?.generation === state.generation) {
      const supported = encodeModalitiesForAdapter(service.adapter, service.modalities);
      if (!supported.has(ranked.sourceTarget.modality)) {
        return { ok: true, type: "embedding.similar", ...snapshot, status: "unsupported", sourceAssetId: request.assetId, assetIds: [] };
      }
      let preparingTarget: HttpEmbeddingTarget | null = null;
      const claimToken = randomUUID();
      let claimedJob = false;
      let errorCategory: "provider" | "preparation" | "storage" = "storage";
      try {
        const targetPage = await this.#listTargets(request.libraryId, state, service, 0, null, request.assetId);
        const target = targetPage.targets.find((entry) => entry.assetId === request.assetId);
        if (target && !target.alreadyIndexed) {
          const claimed = await this.#setDurableJob(state.generation, target.assetId, target.revisionId, claimToken, "claim");
          if (claimed) {
            preparingTarget = target;
            claimedJob = true;
            errorCategory = "preparation";
            const prepared = await this.options.requestWorker({
              type: "semantic.index.prepare", libraryId: request.libraryId,
              sessionGeneration: state.sessionGeneration, assetId: target.assetId,
              sourceRevision: target.revisionId, kind: target.kind,
              maxInputBytes: SEMANTIC_IMAGE_DECODE_MAX_BYTES,
            });
            if (!prepared.ok || prepared.type !== "semantic.index.prepared") throw new Error("Semantic content is unavailable.");
            const checkedService = this.#currentService(state);
            if (!checkedService) throw new Error("Embedding service configuration changed.");
            const inputs: EmbeddingHttpContent[] | string[] = target.kind === "text"
              ? [prepared.text ?? ""]
              : [{ image: await semanticImageDataUrl(prepared.mimeType, prepared.bytesBase64, imageLimitsOf(checkedService)) }];
            if (this.#state?.generation !== state.generation || !this.#currentService(state)) {
              throw new Error("Semantic source changed.");
            }
            const controller = this.#newRequestController();
            let vector: number[] | undefined;
            errorCategory = "provider";
            try {
              [vector] = await this.#embed(checkedService, 'document', {
                baseUrl: checkedService.baseUrl, modelName: checkedService.modelName, adapter: checkedService.adapter,
                dimensions: checkedService.dimensions, inputs, apiKey: this.options.readKey(checkedService.id),
                signal: controller.signal,
              });
            } finally {
              this.#activeRequestControllers.delete(controller);
            }
            if (!vector || this.#state?.generation !== state.generation || !this.#currentService(state)) {
              throw new Error("Semantic source changed.");
            }
            errorCategory = "storage";
            const written = await this.options.requestWorker({
              type: "semantic.index.write", libraryId: request.libraryId,
              sessionGeneration: state.sessionGeneration, profileKey: state.profileKey,
              vectors: [{ assetId: target.assetId, sourceRevision: target.revisionId, vector, claimToken }],
            });
            if (written.ok && written.type === "semantic.index.written" && written.accepted.includes(target.assetId)) {
              this.#write(state.generation, { done: this.#state.done + 1 });
            } else {
              throw new Error("Semantic vector could not be stored.");
            }
          }
        }
      } catch (caught) {
        if (caught instanceof SemanticImageLimitError) this.#imageLimitAssets.add(request.assetId);
        if (claimedJob && preparingTarget && this.#state?.generation === state.generation) {
          await this.#setDurableJob(state.generation, preparingTarget.assetId, preparingTarget.revisionId,
            claimToken, "fail", errorCategory).catch(() => false);
          this.#write(state.generation, { failedCount: this.#state.failedCount + 1 });
        }
      }
      if (this.#state?.generation === state.generation) {
        ranked = await this.options.requestWorker({
          type: "semantic.index.similar", libraryId: request.libraryId,
          sessionGeneration: state.sessionGeneration, queryId,
          profileKey: state.profileKey, sourceAssetId: request.assetId,
          filters: request.filters, scope: request.scope,
        });
      }
    }
    if (this.#activeQueryId !== queryId || this.#state?.generation !== state.generation) {
      return { ok: true, type: "embedding.similar", ...this.#snapshot(), status: "preparing", sourceAssetId: request.assetId, assetIds: [] };
    }
    if (!ranked.ok || ranked.type !== "semantic.index.ranked") {
      return { ok: false, error: createPublicError("INTERNAL_ERROR") };
    }
    if (ranked.cancelled) return { ok: true, type: "embedding.similar", ...this.#snapshot(), status: "preparing", sourceAssetId: request.assetId, assetIds: [] };
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

  #begin(libraryId: string, serviceId: string): number {
    const current = this.#state;
    const service = this.options.loadService(serviceId);
    const sourceModalitiesKey = service
      ? [...encodeModalitiesForAdapter(service.adapter, service.modalities)].sort().join(",")
      : "";
    const profileKey = service?.dimensions
      ? profileKeyForService(service)
      : "";
    if (current && current.libraryId === libraryId && current.serviceId === serviceId
      && current.profileKey === profileKey
      && current.sourceModalitiesKey === sourceModalitiesKey) return current.generation;
    this.#abortRequests();
    this.#generation += 1;
    this.#skipped.clear();
    this.#imageLimitAssets.clear();
    this.#state = {
      phase: "starting",
      done: 0,
      total: 0,
      failedCount: 0,
      generation: this.#generation,
      libraryId,
      serviceId,
      sessionGeneration: randomUUID(),
      profileKey,
      sourceModalitiesKey,
    };
    return this.#generation;
  }

  #rebuild(libraryId: string, serviceId: string): void {
    const failed = this.#state;
    if (!failed || failed.phase !== "failed" || failed.libraryId !== libraryId || failed.serviceId !== serviceId) return;
    this.#abortRequests();
    this.#generation += 1;
    const generation = this.#generation;
    const state: JobState = { ...failed, phase: "starting", done: 0, total: 0, failedCount: 0,
      generation, sessionGeneration: randomUUID() };
    this.#state = state;
    void (async () => {
      const rebuilt = await this.options.requestWorker({
        type: "semantic.index.rebuild", libraryId, sessionGeneration: state.sessionGeneration, confirmed: true,
      });
      if (!rebuilt.ok || rebuilt.type !== "semantic.index.rebuilt") throw new Error("Semantic index rebuild failed.");
      if (this.#state?.generation === generation) void this.#encode(generation, libraryId, serviceId);
    })().catch(() => this.#write(generation, { phase: "failed" }));
  }

  async #encode(generation: number, libraryId: string, serviceId: string): Promise<void> {
    if (this.#runningGeneration !== null) return;
    const service = this.options.loadService(serviceId);
    if (!httpServiceReady(service) || !this.#isLibraryEnabled(libraryId, serviceId)) {
      this.#write(generation, { phase: "unavailable", ...(service ? { hold: "grant" } : {}) });
      return;
    }
    this.#runningGeneration = generation;
    try {
      const state = this.#state;
      if (!state) return;
      const begun = await this.options.requestWorker({
        type: "semantic.index.begin", libraryId,
        sessionGeneration: state.sessionGeneration,
        profileKey: state.profileKey,
        dimensions: service.dimensions,
        modelRevision: "http-embedding-v1",
        modality: "mixed",
        modalities: [...encodeModalitiesForAdapter(service.adapter, service.modalities)],
        maxInputBytes: SEMANTIC_IMAGE_DECODE_MAX_BYTES,
      });
      if (!begun.ok || begun.type !== "semantic.index.started") throw new Error("Semantic index is unavailable.");
      const imported = await this.options.requestWorker({ type: "semantic.index.import-legacy", libraryId,
        sessionGeneration: state.sessionGeneration, cacheKind: "http", cacheId: serviceId });
      if (!imported.ok || imported.type !== "semantic.index.legacy-imported") {
        throw new Error("Legacy semantic cache migration could not be checked.");
      }
      let offset = 0;
      let revisionSnapshot: number | null = null;
      let done = 0;
      let total = 0;
      do {
        if (this.#state?.generation !== generation) return;
        const page = await this.#listTargets(libraryId, state, service, offset, revisionSnapshot);
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
        this.#write(generation, { total, done, phase: "indexing", hold: undefined });
        for (const target of page.targets) {
          if (target.alreadyIndexed) continue;
          if (this.#state?.generation !== generation) return;
          const claimToken = randomUUID();
          let errorCategory: "provider" | "preparation" | "storage" = "storage";
          let claimedJob = false;
          try {
            const claimed = await this.#setDurableJob(generation, target.assetId, target.revisionId, claimToken, "claim");
            if (!claimed) {
              if (target.jobStatus === "failed") {
                this.#write(generation, { failedCount: (this.#state?.failedCount ?? 0) + 1 });
              }
              continue;
            }
            claimedJob = true;
            errorCategory = "preparation";
            const checkedService = this.#currentService(state);
            if (!checkedService) throw new Error("Embedding service configuration changed.");
            const prepared = await this.options.requestWorker({
              type: "semantic.index.prepare", libraryId,
              sessionGeneration: state.sessionGeneration,
              assetId: target.assetId,
              sourceRevision: target.revisionId,
              kind: target.kind,
              maxInputBytes: SEMANTIC_IMAGE_DECODE_MAX_BYTES,
            });
            if (!prepared.ok || prepared.type !== "semantic.index.prepared") throw new Error("Semantic content is unavailable.");
            const inputs: EmbeddingHttpContent[] | string[] = target.kind === "text"
              ? [prepared.text ?? ""]
              : [{ image: await semanticImageDataUrl(prepared.mimeType, prepared.bytesBase64, imageLimitsOf(checkedService)) }];
            if (this.#state?.generation !== generation || !this.#currentService(state)) return;
            const controller = this.#newRequestController();
            errorCategory = "provider";
            const [vector] = await this.#embed(checkedService, 'document', {
              baseUrl: checkedService.baseUrl, modelName: checkedService.modelName, adapter: checkedService.adapter,
              dimensions: checkedService.dimensions, inputs, apiKey: this.options.readKey(checkedService.id),
              signal: controller.signal,
            });
            this.#activeRequestControllers.delete(controller);
            if (!vector || this.#state?.generation !== generation || !this.#currentService(state)) return;
            errorCategory = "storage";
            const written = await this.options.requestWorker({
              type: "semantic.index.write", libraryId,
              sessionGeneration: state.sessionGeneration,
              profileKey: state.profileKey,
              vectors: [{ assetId: target.assetId, sourceRevision: target.revisionId, vector, claimToken }],
            });
            if (written.ok && written.type === "semantic.index.written" && written.accepted.includes(target.assetId)) {
              done += 1;
              this.#write(generation, { done });
            } else {
              await this.#setDurableJob(generation, target.assetId, target.revisionId, claimToken, "fail", "storage")
                .catch(() => false);
              this.#skipped.add(embeddingSkipKey(target.assetId, target.revisionId));
              this.#write(generation, { failedCount: (this.#state?.failedCount ?? 0) + 1 });
            }
          } catch (caught) {
            if (this.#state?.generation !== generation) return;
            if (caught instanceof SemanticImageLimitError) this.#imageLimitAssets.add(target.assetId);
            if (claimedJob) {
              await this.#setDurableJob(generation, target.assetId, target.revisionId, claimToken, "fail", errorCategory).catch(() => false);
            }
            this.#skipped.add(embeddingSkipKey(target.assetId, target.revisionId));
            this.#write(generation, { failedCount: (this.#state?.failedCount ?? 0) + 1 });
          }
        }
        offset = page.nextOffset ?? 100_001;
      } while (offset <= 100_000);
      if (this.#state?.generation === generation) this.#write(generation, { phase: "ready" });
    } catch {
      if (this.#state?.generation === generation) this.#write(generation, { phase: "failed" });
    } finally {
      this.#abortRequests();
      if (this.#runningGeneration === generation) this.#runningGeneration = null;
      const latest = this.#state;
      if (latest && latest.generation !== generation && latest.phase === "starting") {
        // A library/service switch can begin while an old provider request is
        // unwinding. The old generation owns the running slot until cleanup;
        // hand that slot to the newest request once, after it is released.
        queueMicrotask(() => {
          const current = this.#state;
          if (this.#runningGeneration === null && current?.phase === "starting") {
            void this.#encode(current.generation, current.libraryId, current.serviceId);
          }
        });
      }
    }
  }

  /**
   * List assets the service can encode. OpenAI-compatible stays text-only.
   * Current remote adapters send text and, where supported, image payloads.
   * A ready preview is only an image fallback for adapters without video input;
   * the local EmbeddingGemma path is separate and sends the original video.
   */
  async #listTargets(
    libraryId: string,
    state: JobState,
    service: EmbeddingHttpServiceView & { dimensions: number },
    offset: number,
    revisionSnapshot: number | null,
    assetId?: string,
  ): Promise<{ targets: HttpEmbeddingTarget[]; revisionSnapshot: number; nextOffset: number | null; snapshotChanged: boolean }> {
    const encodeModalities = encodeModalitiesForAdapter(service.adapter, service.modalities);
    const result = await this.options.requestWorker({
      type: "semantic.index.targets",
      libraryId,
      sessionGeneration: state.sessionGeneration,
      modalities: [...encodeModalities],
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
      targets: result.targets.filter((target) => encodeModalities.has(target.modality)).map((target) => ({
        assetId: target.assetId,
        revisionId: target.sourceRevision,
        kind: target.kind === "text" ? "text" : "image",
        modality: target.modality,
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

  #snapshot(): EmbeddingIndexSnapshot {
    if (!this.#state) return { phase: "unavailable", done: 0, total: 0, failedCount: 0 };
    return {
      phase: this.#state.phase,
      done: this.#state.done,
      total: this.#state.total,
      failedCount: this.#state.failedCount,
      ...(this.#state.hold ? { hold: this.#state.hold } : {}),
    };
  }

  #write(generation: number, patch: Partial<JobState>): void {
    if (!this.#state || this.#state.generation !== generation) return;
    this.#state = { ...this.#state, ...patch };
  }

  #currentService(state: JobState): EmbeddingHttpServiceView & { dimensions: number } | null {
    const service = this.options.loadService(state.serviceId);
    if (!httpServiceReady(service) || !this.#isLibraryEnabled(state.libraryId, state.serviceId)) return null;
    const profileKey = profileKeyForService(service);
    const active = this.#state;
    return profileKey === state.profileKey && active?.generation === state.generation
      && [...encodeModalitiesForAdapter(service.adapter, service.modalities)].sort().join(",") === state.sourceModalitiesKey
      && active.libraryId === state.libraryId && active.serviceId === state.serviceId
      ? service
      : null;
  }

  #startQuery(libraryId: string): string {
    const previousQueryId = this.#activeQueryId;
    const previousSessionGeneration = this.#activeQuerySessionGeneration;
    const previousLibraryId = this.#activeQueryLibraryId;
    if (previousQueryId) this.#queryControllers.get(previousQueryId)?.abort();
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

  #newRequestController(): AbortController {
    const controller = new AbortController();
    this.#activeRequestControllers.add(controller);
    return controller;
  }

  #abortRequests(): void {
    for (const controller of this.#activeRequestControllers) controller.abort();
    this.#activeRequestControllers.clear();
  }

  #isLibraryEnabled(libraryId: string, serviceId: string): boolean {
    return this.options.isLibraryEnabled?.(libraryId, serviceId) ?? false;
  }

  async #embed(service: EmbeddingHttpServiceView, purpose: EmbeddingPurpose, input: Parameters<typeof postEmbeddingHttp>[0]): Promise<number[][]> {
    if (this.options.embed && input.inputs.every(item => typeof item === 'string')) {
      return (await this.options.embed(input.inputs as readonly string[], {
        selectionId: service.id, purpose, expectedProfileKey: profileKeyForService(service), signal: input.signal,
      })).vectors;
    }
    return postEmbeddingHttp(input);
  }
}

function httpServiceReady(
  service: EmbeddingHttpServiceView | null,
): service is EmbeddingHttpServiceView & { dimensions: number } {
  return Boolean(
    service
    && service.textStatus === "verified"
    && service.dimensions
    && service.modalities.includes("text"),
  );
}

function profileKeyForService(service: EmbeddingHttpServiceView): string {
  if (service.profileKey) return service.profileKey;
  if (service.dimensions == null) return "";
  const limits = imageLimitsOf(service);
  return embeddingHttpProfileKey({
    adapter: service.adapter,
    baseUrl: service.baseUrl,
    modelName: service.modelName,
    dimensions: service.dimensions,
    maxImageEdgePx: limits.maxEdgePx,
    maxImageBytes: limits.maxBytes,
  });
}

function imageLimitsOf(service: EmbeddingHttpServiceView): { maxEdgePx: number; maxBytes: number } {
  return {
    maxEdgePx: normalizeSemanticImageEdgePx(service.maxImageEdgePx) ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
    maxBytes: normalizeSemanticImageBytes(service.maxImageBytes) ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
  };
}

async function semanticImageDataUrl(
  mimeType: string | undefined,
  bytesBase64: string | undefined,
  limits: { maxEdgePx: number; maxBytes: number },
): Promise<string> {
  if (!mimeType || !bytesBase64) throw new Error("Semantic image payload is unavailable.");
  const fitted = await fitSemanticImage({
    bytes: Buffer.from(bytesBase64, "base64"),
    mimeType,
    maxEdgePx: limits.maxEdgePx,
    maxBytes: limits.maxBytes,
  });
  return `data:${fitted.mimeType};base64,${fitted.bytes.toString("base64")}`;
}

/** Actual HTTP input channels; image-capable adapters may use a ready preview for video files. */
export function encodeModalitiesForAdapter(
  adapter: EmbeddingHttpAdapter,
  modalities: readonly EmbeddingModality[],
): Set<EmbeddingSourceModality> {
  return new Set(embeddingInputModalitiesForAdapter(adapter, modalities));
}
