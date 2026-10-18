import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  deleteEmbeddingModel,
  EmbeddingModelCatalogError,
  parseEmbeddingModelCatalog,
  setDefaultEmbeddingModel,
  summarizeEmbeddingModels,
  upsertEmbeddingModel,
  type EmbeddingModelCatalog,
} from "../embedding-model-catalog";
import {
  EmbeddingInstallError,
  inspectManagedEmbeddingInstall,
  installEmbeddingFiles,
  installedSemanticModels,
  pinnedLlamaRuntimeAsset,
  semanticModelPackageBytes,
  uninstallSemanticModelFiles,
  type EmbeddingDownloadProgress,
} from "../embedding-install";
import type { EmbeddingInstallProgress } from "../../shared/embedding/install-progress";
import { probeFreeBytes } from "../disk-free-space";
import {
  clearEmbeddingBinding,
  writeEmbeddingBinding,
  type EmbeddingLibraryBinding,
} from "../embedding-library-binding";
import {
  deleteEmbeddingService,
  EmbeddingServiceRegistryError,
  grantEmbeddingService,
  markEmbeddingServiceProbe,
  parseEmbeddingServiceCatalog,
  saveEmbeddingService,
  summarizeEmbeddingServices,
  type EmbeddingServiceCatalog,
  type EmbeddingServiceCredentialStore,
} from "../embedding-service-registry";
import { EmbeddingHttpRequestError, probeEmbeddingHttp } from "../embedding-http";
import type { EmbeddingHttpIndex } from "../embedding-http-index";
import {
  isEmbeddingServiceSelectionId,
  normalizeEmbeddingServiceUrl,
  type EmbeddingProbeFailure,
} from "../../shared/embedding/http-service";
import { isSemanticSearchModelId, SEMANTIC_SEARCH_MODEL_IDS, type SemanticSearchModelId } from "../../shared/embedding/profile";
import type { EmbeddingTestIndex } from "../embedding-test-index";
import { createPublicError } from "../../shared/protocol/errors";
import type { RendererRequest } from "../../shared/protocol/requests";
import type { RendererResult } from "../../shared/protocol/responses";

export type EmbeddingModelRuntime = {
  readCatalog: () => unknown;
  writeCatalog: (catalog: EmbeddingModelCatalog) => void;
  readServices?: () => unknown;
  writeServices?: (catalog: EmbeddingServiceCatalog) => void;
  serviceCredentials?: EmbeddingServiceCredentialStore;
  userDataPath: () => string;
  homePath: () => string;
  readBindings?: () => Record<string, EmbeddingLibraryBinding>;
  writeBindings?: (bindings: Record<string, EmbeddingLibraryBinding>) => void;
  embeddingIndex?: EmbeddingTestIndex;
  embeddingHttpIndex?: EmbeddingHttpIndex;
  stopGemmaIndex?: (libraryId?: string) => void | Promise<void>;
  stopHttpIndex?: (libraryId?: string) => void | Promise<void>;
  onInstallProgress?: (event: EmbeddingInstallProgress) => void;
  logError?: (scope: string, error: unknown, context?: Record<string, unknown>) => void;
};

export async function tryHandleEmbeddingModelRequest(
  request: RendererRequest,
  runtime: EmbeddingModelRuntime,
): Promise<RendererResult | undefined> {
  switch (request.type) {
    case "embedding.models.list.request":
      return {
        ok: true,
        type: "embedding.models.listed",
        models: summarizeEmbeddingModels(parseEmbeddingModelCatalog(runtime.readCatalog())),
      };
    case "embedding.models.upsert.request":
      return saveModel(request, runtime);
    case "embedding.models.delete.request":
      return removeModel(request.id, runtime);
    case "embedding.models.set-default.request":
      return chooseDefault(request.id, runtime);
    case "embedding.services.list.request":
      return listServices(runtime);
    case "embedding.services.save.request":
      return saveService(request, runtime);
    case "embedding.services.delete.request":
      return removeService(request.id, runtime);
    case "embedding.services.probe.request":
      return probeService(request.id, runtime);
    case "embedding.services.grant.request":
      return grantService(request.id, request.libraryId, runtime);
    case "embedding.binding.get.request":
      return readBinding(request.libraryId, runtime);
    case "embedding.binding.save.request":
      return saveBinding(request.libraryId, request.selectionId, runtime, request.inherit === true);
    case "embedding.install.status.request":
      return installStatus(runtime);
    case "embedding.install.start.request":
      return installModel(request.modelId, runtime);
    case "embedding.install.delete.request":
      return uninstallModel(request.modelId, runtime);
    case "embedding.index.status.request":
      if (request.stop === true) {
        await stopLibraryIndexes(request.libraryId, runtime);
        return unavailableIndex();
      }
      // run:false is a snapshot only — never stop/wipe an index that may still be useful.
      if (!request.run) {
        if (isEmbeddingServiceSelectionId(request.modelId)) {
          return runtime.embeddingHttpIndex?.handleStatus(request) ?? unavailableIndex();
        }
        if (!isSemanticSearchModelId(request.modelId)) return unavailableIndex();
        return runtime.embeddingIndex?.handleStatus({ ...request, modelId: request.modelId }) ?? unavailableIndex();
      }
      if (isEmbeddingServiceSelectionId(request.modelId)) {
        await runtime.stopGemmaIndex?.(request.libraryId);
        return runtime.embeddingHttpIndex?.handleStatus(request) ?? unavailableIndex();
      }
      await runtime.stopHttpIndex?.(request.libraryId);
      if (!isSemanticSearchModelId(request.modelId)) return unavailableIndex();
      return runtime.embeddingIndex?.handleStatus({ ...request, modelId: request.modelId }) ?? unavailableIndex();
    case "embedding.search.request":
      if (isEmbeddingServiceSelectionId(request.modelId)) {
        await runtime.stopGemmaIndex?.(request.libraryId);
        return runtime.embeddingHttpIndex?.handleSearch(request) ?? emptySearch();
      }
      await runtime.stopHttpIndex?.(request.libraryId);
      if (!isSemanticSearchModelId(request.modelId)) return emptySearch();
      return runtime.embeddingIndex?.handleSearch({ ...request, modelId: request.modelId }) ?? emptySearch();
    case "embedding.similar.request":
      if (isEmbeddingServiceSelectionId(request.modelId)) {
        await runtime.stopGemmaIndex?.(request.libraryId);
        return runtime.embeddingHttpIndex?.handleSimilar(request) ?? {
          ok: true,
          type: "embedding.similar",
          phase: "unavailable",
          done: 0,
          total: 0,
          failedCount: 0,
          status: "unsupported",
          sourceAssetId: request.assetId,
          assetIds: [],
        };
      }
      await runtime.stopHttpIndex?.(request.libraryId);
      if (!isSemanticSearchModelId(request.modelId)) {
        return {
          ok: true,
          type: "embedding.similar",
          phase: "unavailable",
          done: 0,
          total: 0,
          failedCount: 0,
          status: "unsupported",
          sourceAssetId: request.assetId,
          assetIds: [],
        };
      }
      return runtime.embeddingIndex?.handleSimilar({ ...request, modelId: request.modelId }) ?? {
        ok: true,
        type: "embedding.similar",
        phase: "unavailable",
        done: 0,
        total: 0,
        failedCount: 0,
        status: "unavailable",
        sourceAssetId: request.assetId,
        assetIds: [],
      };
    default:
      return undefined;
  }
}

function installStatus(runtime: EmbeddingModelRuntime): RendererResult {
  const inspection = inspectManagedEmbeddingInstall(runtime.userDataPath());
  const installed = new Set(installedSemanticModels(new Set(inspection.files.keys())));
  return {
    ok: true,
    type: "embedding.install.status",
    runtimeInstalled: inspection.runtimeFound,
    runtimeDownloadable: pinnedLlamaRuntimeAsset(process.platform, process.arch) !== null,
    models: SEMANTIC_SEARCH_MODEL_IDS.map((modelId) => ({
      modelId,
      installed: installed.has(modelId),
    })),
  };
}

async function installModel(modelId: SemanticSearchModelId, runtime: EmbeddingModelRuntime): Promise<RendererResult> {
  const current = installStatus(runtime);
  if (!current.ok || current.type !== "embedding.install.status") return current;
  const modelInstalled = current.models.some((model) => model.modelId === modelId && model.installed);
  if (modelInstalled && current.runtimeInstalled) return current;
  const destinationDir = path.join(runtime.userDataPath(), "embedding-models");
  const inspection = inspectManagedEmbeddingInstall(runtime.userDataPath());
  const emit = (progress: EmbeddingDownloadProgress): void => {
    runtime.onInstallProgress?.({
      modelId,
      phase: progress.phase,
      bytesDownloaded: progress.bytesDownloaded,
      ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
      ...(progress.fileName === undefined ? {} : { fileName: progress.fileName }),
    });
  };
  try {
    const freeBytes = await probeFreeBytes(destinationDir);
    await installEmbeddingFiles({
      modelId,
      destinationDir,
      alreadyFound: new Set(inspection.files.keys()),
      runtimeFound: inspection.runtimeFound,
      platform: process.platform,
      arch: process.arch,
      freeBytes,
      onProgress: emit,
    });
    runtime.onInstallProgress?.({
      modelId,
      phase: "ready",
      bytesDownloaded: semanticModelPackageBytes(modelId),
      totalBytes: semanticModelPackageBytes(modelId),
    });
  } catch (error) {
    runtime.logError?.("embedding.install.failed", error, { modelId });
    runtime.onInstallProgress?.({
      modelId,
      phase: "failed",
      bytesDownloaded: 0,
      message: error instanceof Error ? error.message : undefined,
    });
    if (error instanceof EmbeddingInstallError && error.kind === "space") {
      return { ok: false, error: createPublicError("DISK_FULL") };
    }
    return { ok: false, error: createPublicError("EMBEDDING_INSTALL_FAILED") };
  }
  return installStatus(runtime);
}

function uninstallModel(modelId: SemanticSearchModelId, runtime: EmbeddingModelRuntime): RendererResult {
  uninstallSemanticModelFiles({
    modelId,
    userDataPath: runtime.userDataPath(),
  });
  return installStatus(runtime);
}

function saveModel(
  request: Extract<RendererRequest, { type: "embedding.models.upsert.request" }>,
  runtime: EmbeddingModelRuntime,
): RendererResult {
  const catalog = parseEmbeddingModelCatalog(runtime.readCatalog());
  try {
    const id = request.id ?? randomUUID();
    const next = upsertEmbeddingModel(catalog, {
      id,
      name: request.name,
      tier: request.tier,
      modelDirectory: request.modelDirectory,
      runtimePath: request.runtimePath,
    });
    runtime.writeCatalog(next);
    return { ok: true, type: "embedding.model.saved", id };
  } catch (error) {
    if (error instanceof EmbeddingModelCatalogError) {
      return { ok: false, error: createPublicError("EMBEDDING_MODEL_INVALID") };
    }
    throw error;
  }
}

function removeModel(id: string, runtime: EmbeddingModelRuntime): RendererResult {
  const catalog = parseEmbeddingModelCatalog(runtime.readCatalog());
  runtime.writeCatalog(deleteEmbeddingModel(catalog, id));
  return { ok: true, type: "embedding.model.deleted", id };
}

function chooseDefault(id: string, runtime: EmbeddingModelRuntime): RendererResult {
  const catalog = parseEmbeddingModelCatalog(runtime.readCatalog());
  try {
    runtime.writeCatalog(setDefaultEmbeddingModel(catalog, id));
    return { ok: true, type: "embedding.model.default-set", id };
  } catch (error) {
    if (error instanceof EmbeddingModelCatalogError) {
      return { ok: false, error: createPublicError("EMBEDDING_MODEL_INVALID") };
    }
    throw error;
  }
}

function unavailableIndex(): RendererResult {
  return {
    ok: true,
    type: "embedding.index.status",
    phase: "unavailable",
    done: 0,
    total: 0,
    failedCount: 0,
  };
}

function emptySearch(): RendererResult {
  return {
    ok: true,
    type: "embedding.search",
    phase: "unavailable",
    done: 0,
    total: 0,
    failedCount: 0,
    assetIds: [],
    scores: [],
  };
}

function listServices(runtime: EmbeddingModelRuntime): RendererResult {
  if (!runtime.readServices || !runtime.serviceCredentials) {
    return { ok: true, type: "embedding.services.listed", services: [] };
  }
  return {
    ok: true,
    type: "embedding.services.listed",
    services: summarizeEmbeddingServices(
      parseEmbeddingServiceCatalog(runtime.readServices()),
      runtime.serviceCredentials,
    ),
  };
}

async function saveService(
  request: Extract<RendererRequest, { type: "embedding.services.save.request" }>,
  runtime: EmbeddingModelRuntime,
): Promise<RendererResult> {
  if (!runtime.readServices || !runtime.writeServices || !runtime.serviceCredentials) {
    return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
  }
  try {
    const next = saveEmbeddingService(
      parseEmbeddingServiceCatalog(runtime.readServices()),
      runtime.serviceCredentials,
      request,
    );
    runtime.writeServices(next);
    await runtime.stopHttpIndex?.();
    const id = request.id ?? next.services.at(-1)?.id;
    if (!id) return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
    return { ok: true, type: "embedding.service.saved", id };
  } catch (error) {
    if (error instanceof EmbeddingServiceRegistryError) {
      return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
    }
    throw error;
  }
}

async function removeService(id: string, runtime: EmbeddingModelRuntime): Promise<RendererResult> {
  if (!runtime.readServices || !runtime.writeServices || !runtime.serviceCredentials) {
    return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
  }
  runtime.writeServices(deleteEmbeddingService(
    parseEmbeddingServiceCatalog(runtime.readServices()),
    runtime.serviceCredentials,
    id,
  ));
  await runtime.stopHttpIndex?.();
  return { ok: true, type: "embedding.service.deleted", id };
}

async function probeService(id: string, runtime: EmbeddingModelRuntime): Promise<RendererResult> {
  if (!runtime.readServices || !runtime.writeServices || !runtime.serviceCredentials) {
    return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
  }
  const catalog = parseEmbeddingServiceCatalog(runtime.readServices());
  const service = catalog.services.find((entry) => entry.id === id);
  if (!service) return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
  const url = normalizeEmbeddingServiceUrl(service.baseUrl);
  if (url?.place === "internet" && url.protocol === "http:") {
    runtime.writeServices(markEmbeddingServiceProbe(catalog, id, { ok: false, failure: "https" }));
    return {
      ok: true,
      type: "embedding.service.probed",
      id,
      textStatus: "failed",
      dimensions: service.dimensions,
      probeFailure: "https",
    };
  }
  try {
    const probed = await probeEmbeddingHttp({
      baseUrl: service.baseUrl,
      modelName: service.modelName,
      adapter: service.adapter,
      dimensions: service.dimensions,
      apiKey: runtime.serviceCredentials.read(id),
    });
    const next = markEmbeddingServiceProbe(catalog, id, { ok: true, dimensions: probed.dimensions });
    const marked = next.services.find((entry) => entry.id === id);
    runtime.writeServices(next);
    if (marked?.textStatus === "failed") {
      return {
        ok: true,
        type: "embedding.service.probed",
        id,
        textStatus: "failed",
        dimensions: marked.dimensions,
        probeFailure: marked.probeFailure,
      };
    }
    return {
      ok: true,
      type: "embedding.service.probed",
      id,
      textStatus: "verified",
      dimensions: probed.dimensions,
      probeFailure: null,
    };
  } catch (error) {
    const failure: EmbeddingProbeFailure = error instanceof EmbeddingHttpRequestError
      ? error.kind
      : "network";
    runtime.writeServices(markEmbeddingServiceProbe(catalog, id, { ok: false, failure }));
    return {
      ok: true,
      type: "embedding.service.probed",
      id,
      textStatus: "failed",
      dimensions: service.dimensions,
      probeFailure: failure,
    };
  }
}

function readBinding(libraryId: string, runtime: EmbeddingModelRuntime): RendererResult {
  const record = runtime.readBindings?.()[libraryId];
  if (!record) {
    return {
      ok: true,
      type: "embedding.binding",
      libraryId,
      selectionId: null,
      enabled: false,
      inherit: true,
    };
  }
  return {
    ok: true,
    type: "embedding.binding",
    libraryId,
    selectionId: record.selectionId,
    enabled: record.enabled,
    inherit: false,
  };
}

async function saveBinding(
  libraryId: string,
  selectionId: string | null,
  runtime: EmbeddingModelRuntime,
  inherit = false,
): Promise<RendererResult> {
  if (!runtime.readBindings || !runtime.writeBindings) {
    return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
  }
  if (inherit) {
    runtime.writeBindings(clearEmbeddingBinding(runtime.readBindings(), libraryId));
    await stopLibraryIndexes(libraryId, runtime);
    return {
      ok: true,
      type: "embedding.binding",
      libraryId,
      selectionId: null,
      enabled: false,
      inherit: true,
    };
  }
  const next = writeEmbeddingBinding(runtime.readBindings(), libraryId, selectionId);
  const saved = next[libraryId] ?? { selectionId: null, enabled: false };
  if (selectionId && saved.selectionId !== selectionId) {
    return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
  }
  runtime.writeBindings(next);
  await stopLibraryIndexes(libraryId, runtime);
  return {
    ok: true,
    type: "embedding.binding",
    libraryId,
    selectionId: saved.selectionId,
    enabled: saved.enabled,
    inherit: false,
  };
}

async function stopLibraryIndexes(libraryId: string, runtime: EmbeddingModelRuntime): Promise<void> {
  await Promise.all([
    runtime.stopGemmaIndex?.(libraryId),
    runtime.stopHttpIndex?.(libraryId),
  ]);
}

async function grantService(id: string, libraryId: string, runtime: EmbeddingModelRuntime): Promise<RendererResult> {
  if (!runtime.readServices || !runtime.writeServices) {
    return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
  }
  try {
    runtime.writeServices(grantEmbeddingService(
      parseEmbeddingServiceCatalog(runtime.readServices()),
      id,
      libraryId,
    ));
    await runtime.stopHttpIndex?.();
    return { ok: true, type: "embedding.service.granted", id };
  } catch (error) {
    if (error instanceof EmbeddingServiceRegistryError) {
      return { ok: false, error: createPublicError("EMBEDDING_SERVICE_INVALID") };
    }
    throw error;
  }
}
