import type { RendererRequest, WorkerCommand } from "../../shared/protocol/requests";
import type { RendererResult, WorkerResult } from "../../shared/protocol/responses";
import { createPublicError } from "../../shared/protocol/errors";
import {
  DEFAULT_AI_ANALYSIS_SETTINGS,
  normalizeAiAnalysisSettings,
  toWireAiAnalysisSettings,
  type AiAnalysisSettings,
} from "../../shared/ai-analysis-settings";
import { normalizeAiAnalysisConcurrency } from "../../shared/ai-concurrency";
import { normalizeAiAnalysisImageEdgePx } from "../../shared/ai-analysis-image";
import { normalizeAiReliabilitySettings, type AiReliabilitySettings } from "../../shared/ai-reliability";
import {
  DEFAULT_AI_LANGUAGES,
  listAiModels,
  normalizeAiLanguages,
  type AiApiFormat,
} from "../../shared/ai-endpoints";
import { aiSearchFailureReason, planAiSearch } from "../ai-search-planner";
import {
  AiProfileStorageError,
  AiProfileValidationError,
  type AiConnectionProfileDraft,
  type AiConnectionProfileSummary,
} from "../ai-profile-store";

type AiConfigRead =
  | { ok: true; config: AiOwnedConfig }
  | { ok: false; result: RendererResult };

function readAiConfigForRequest(
  runtime: AiOwnedRequestRuntime,
  operation: string,
): AiConfigRead {
  try {
    return { ok: true, config: runtime.loadAiConfig() };
  } catch (error) {
    runtime.logError("ai.profile-storage.read", error, { operation });
    return {
      ok: false,
      result: {
        ok: false,
        error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
      } satisfies RendererResult,
    };
  }
}

export type AiOwnedConfig = {
  hasKey: boolean;
  activeProfileId: string | null;
  profiles: AiConnectionProfileSummary[];
  apiFormat: AiApiFormat;
  model: string;
  baseUrl: string;
  descriptionEnabled: boolean;
  tagEnabled: boolean;
  ratingEnabled: boolean;
  analysisSettings: AiAnalysisSettings;
  concurrencyLimit: number;
  maxAnalysisImageEdgePx: number;
  reliabilitySettings: AiReliabilitySettings;
  languages: Array<"zh-CN" | "en" | "ja" | "ko">;
  autoAnalyzeEnabled: boolean;
  disclaimerAccepted: boolean;
};

export type AiOwnedSavedConfig = Omit<AiOwnedConfig, "hasKey" | "activeProfileId" | "profiles">;

export type AiOwnedRequestRuntime = {
  loadAiConfig: () => AiOwnedConfig;
  getDecryptedApiKey: () => string;
  getDecryptedProfileApiKey: (profileId: string) => string;
  saveAiConfig: (config: AiOwnedSavedConfig) => void;
  saveConnectionProfile: (profile: AiConnectionProfileDraft & { apiKey?: string; clearCredential?: boolean }) => string;
  activateConnectionProfile: (profileId: string) => void;
  deleteConnectionProfile: (profileId: string) => void;
  workerAvailable: () => boolean;
  requestWorker: (command: WorkerCommand) => Promise<WorkerResult>;
  processAiQueue: (libraryId: string) => void;
  logInfo: (scope: string, message: string, context?: Record<string, unknown>) => void;
  logError: (scope: string, error: unknown, context?: Record<string, unknown>) => void;
};

/**
 * Main-owned AI config, search-plan, and analysis enqueue replies.
 * Undefined means the request is not fully handled here (including
 * `asset.analyze.request` falling through to synchronous Worker analyze).
 */
export async function tryHandleAiOwnedRequest(
  request: RendererRequest,
  runtime: AiOwnedRequestRuntime,
): Promise<RendererResult | undefined> {
  switch (request.type) {
    case "assets.analyze.request": {
      const configRead = readAiConfigForRequest(runtime, request.type);
      if (!configRead.ok) return configRead.result;
      const config = configRead.config;
      if (!config.hasKey || !config.apiFormat || !config.model.trim()) {
        return {
          ok: false,
          error: createPublicError("AI_ANALYSIS_FAILED", "AI_NOT_CONFIGURED"),
        } satisfies RendererResult;
      }
      try {
        if (!runtime.getDecryptedApiKey().trim()) throw Error('AI_NOT_CONFIGURED');
      } catch (error) {
        if (error instanceof AiProfileStorageError) {
          runtime.logError("ai.profile-storage.read", error, { operation: request.type });
          return { ok: false, error: createPublicError("AI_PROFILE_STORAGE_FAILED") } satisfies RendererResult;
        }
        return {
          ok: false,
          error: createPublicError("AI_ANALYSIS_FAILED", "AI_NOT_CONFIGURED"),
        } satisfies RendererResult;
      }
      if (!runtime.workerAvailable()) throw new Error("Library Worker is unavailable.");
      try {
        const enqueueResult = await runtime.requestWorker({
          type: "ai.enqueue-analysis",
          libraryId: request.libraryId,
          assetIds: request.assetIds,
          resumePaused: true,
          // 手动分析可覆盖已有 AI 结果（8-09 WIP 恢复：worker 已支持）
          forceExisting: true,
        });
        if (enqueueResult.ok && enqueueResult.type === "ai.jobs.enqueued") {
          const jobIds = [
            ...enqueueResult.jobIds,
            ...enqueueResult.alreadyPendingJobIds,
          ];
          if (jobIds.length > 0) {
            void runtime.processAiQueue(request.libraryId);
            return {
              ok: true,
              type: "assets.analyze-queued",
              assetIds: request.assetIds,
              jobIds,
              skippedAssetIds: enqueueResult.skippedAssetIds,
              enqueued: enqueueResult.enqueued,
            } satisfies RendererResult;
          }
          return { ok: false, error: createPublicError("AI_ANALYSIS_FAILED", "AI_NO_ELIGIBLE_ASSETS") } satisfies RendererResult;
        }
      } catch (error) {
        runtime.logError("ai.analyze.batch-enqueue", error);
      }
      return {
        ok: false,
        error: createPublicError("AI_ANALYSIS_FAILED"),
      } satisfies RendererResult;
    }
    case "asset.analyze.request": {
      const configRead = readAiConfigForRequest(runtime, request.type);
      if (!configRead.ok) return configRead.result;
      const config = configRead.config;
      if (!config.hasKey || !config.apiFormat || !config.model.trim()) {
        return {
          ok: false,
          error: createPublicError("AI_ANALYSIS_FAILED", "AI_NOT_CONFIGURED"),
        } satisfies RendererResult;
      }
      try {
        if (!runtime.getDecryptedApiKey().trim()) throw Error('AI_NOT_CONFIGURED');
      } catch (error) {
        if (error instanceof AiProfileStorageError) {
          runtime.logError("ai.profile-storage.read", error, { operation: request.type });
          return { ok: false, error: createPublicError("AI_PROFILE_STORAGE_FAILED") } satisfies RendererResult;
        }
        return {
          ok: false,
          error: createPublicError("AI_ANALYSIS_FAILED", "AI_NOT_CONFIGURED"),
        } satisfies RendererResult;
      }
      if (!runtime.workerAvailable()) throw new Error("Library Worker is unavailable.");
      try {
        const enqueueResult = await runtime.requestWorker({
          type: "ai.enqueue-analysis",
          libraryId: request.libraryId,
          assetIds: [request.assetId],
          // 手动分析可覆盖已有 AI 结果（8-09 WIP 恢复：worker 已支持）
          forceExisting: true,
        });
        if (
          enqueueResult.ok &&
          enqueueResult.type === "ai.jobs.enqueued" &&
          enqueueResult.enqueued > 0
        ) {
          void runtime.processAiQueue(request.libraryId);
          return {
            ok: true,
            type: "asset.analyze-queued",
            assetId: request.assetId,
            enqueued: enqueueResult.enqueued,
          } satisfies RendererResult;
        }
        if (
          enqueueResult.ok &&
          enqueueResult.type === "ai.jobs.enqueued" &&
          enqueueResult.enqueued === 0
        ) {
          const statusResult = await runtime.requestWorker({
            type: "ai.status",
            libraryId: request.libraryId,
          });
          const alreadyPending =
            statusResult.ok &&
            statusResult.type === "ai.jobs.status" &&
            statusResult.jobs.some(
              (job) =>
                job.assetId === request.assetId &&
                (job.status === "queued" ||
                  job.status === "running" ||
                  job.status === "paused"),
            );
          if (alreadyPending) {
            void runtime.processAiQueue(request.libraryId);
            return {
              ok: true,
              type: "asset.analyze-queued",
              assetId: request.assetId,
              enqueued: 1,
            } satisfies RendererResult;
          }
        }
      } catch (error) {
        runtime.logError("ai.analyze.enqueue", error);
      }
      // Fall through to synchronous asset.analyze for eligibility errors.
      return undefined;
    }
    case "ai.config.get.request": {
      const configRead = readAiConfigForRequest(runtime, request.type);
      if (!configRead.ok) return configRead.result;
      const config = configRead.config;
      return {
        ok: true,
        type: "ai.config.got",
        activeProfileId: config.activeProfileId,
        profiles: config.profiles,
        apiFormat: config.apiFormat,
        model: config.model,
        baseUrl: config.baseUrl ?? "",
        hasKey: config.hasKey,
        enabledFields: {
          description: config.descriptionEnabled,
          tags: config.tagEnabled,
          rating: config.ratingEnabled,
        },
        analysisSettings: toWireAiAnalysisSettings(config.analysisSettings),
        languages: config.languages,
        concurrencyLimit: config.concurrencyLimit,
        maxAnalysisImageEdgePx: config.maxAnalysisImageEdgePx,
        reliabilitySettings: config.reliabilitySettings,
        autoAnalyzeEnabled: config.autoAnalyzeEnabled,
        disclaimerAccepted: config.disclaimerAccepted,
      } satisfies RendererResult;
    }
    case "ai.config.set.request": {
      const configRead = readAiConfigForRequest(runtime, request.type);
      if (!configRead.ok) return configRead.result;
      const currentConfig = configRead.config;
      if (request.autoAnalyzeEnabled && !request.disclaimerAccepted) {
        return {
          ok: false,
          error: createPublicError("CONFIRMATION_REQUIRED"),
        } satisfies RendererResult;
      }
      const savedConfig: AiOwnedSavedConfig = {
        apiFormat: currentConfig.apiFormat,
        model: currentConfig.model,
        baseUrl: currentConfig.baseUrl,
        descriptionEnabled: request.enabledFields?.description ?? true,
        tagEnabled: request.enabledFields?.tags ?? true,
        ratingEnabled: request.enabledFields?.rating ?? true,
        analysisSettings: normalizeAiAnalysisSettings({
          ...DEFAULT_AI_ANALYSIS_SETTINGS,
          ...request.analysisSettings,
          descriptionEnabled: request.enabledFields?.description ?? true,
          tagEnabled: request.enabledFields?.tags ?? true,
          ratingEnabled: request.enabledFields?.rating ?? true,
        }),
        concurrencyLimit: normalizeAiAnalysisConcurrency(
          request.concurrencyLimit ?? currentConfig.concurrencyLimit,
        ),
        maxAnalysisImageEdgePx: normalizeAiAnalysisImageEdgePx(
          request.maxAnalysisImageEdgePx ?? currentConfig.maxAnalysisImageEdgePx,
        ),
        // Retry policy remains durable but is no longer a user-facing setting.
        reliabilitySettings: request.reliabilitySettings
          ? normalizeAiReliabilitySettings(request.reliabilitySettings)
          : currentConfig.reliabilitySettings,
        languages: normalizeAiLanguages(
          request.languages ?? request.language ?? DEFAULT_AI_LANGUAGES,
        ),
        autoAnalyzeEnabled: request.autoAnalyzeEnabled,
        disclaimerAccepted: request.disclaimerAccepted,
      };
      try {
        // Preserve the global LLM bridge used by companions, capture tools and
        // existing asset clients. Preference-only writes never edit a profile.
        const writesConnection = request.apiFormat !== undefined
          || request.model !== undefined || request.baseUrl !== undefined
          || request.apiKey !== undefined;
        if (writesConnection) {
          const existing = currentConfig.profiles.find((profile) => profile.id === currentConfig.activeProfileId);
          if (!request.apiKey?.trim() && !currentConfig.hasKey) {
            return { ok: false, error: createPublicError("AI_SETTINGS_INCOMPLETE") } satisfies RendererResult;
          }
          const id = runtime.saveConnectionProfile({
            ...(existing ? { id: existing.id } : {}),
            name: existing?.name ?? "Default AI connection",
            apiFormat: request.apiFormat ?? currentConfig.apiFormat,
            model: request.model ?? currentConfig.model,
            baseUrl: request.baseUrl?.trim() ?? currentConfig.baseUrl,
            ...(request.apiKey?.trim() ? { apiKey: request.apiKey.trim() } : {}),
          });
          if (!existing) runtime.activateConnectionProfile(id);
        }
        runtime.saveAiConfig(savedConfig);
      } catch (error) {
        runtime.logError("ai.analysis-preferences.save", error);
        return {
          ok: false,
          error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
        } satisfies RendererResult;
      }
      if (runtime.workerAvailable()) {
        try {
          const update = await runtime.requestWorker({
            type: "ai.set-concurrency-limit",
            concurrencyLimit: savedConfig.concurrencyLimit,
          });
          if (!update.ok || update.type !== "ai.concurrency.updated") {
            runtime.logError(
              "ai.config.concurrency-update",
              new Error("Library Worker did not acknowledge the AI concurrency update."),
              { concurrencyLimit: savedConfig.concurrencyLimit },
            );
          }
        } catch (error) {
          // Saving stays durable even if the Worker is restarting. The next
          // queue batch always reapplies this value before dispatching work.
          runtime.logError("ai.config.concurrency-update", error, {
            concurrencyLimit: savedConfig.concurrencyLimit,
          });
        }
      }
      return { ok: true, type: "ai.config.saved" } satisfies RendererResult;
    }
    case "ai.profiles.save.request": {
      try {
        const id = runtime.saveConnectionProfile({
          ...(request.id ? { id: request.id } : {}),
          name: request.name,
          apiFormat: request.apiFormat,
          model: request.model,
          baseUrl: request.baseUrl,
          ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
          ...(request.clearCredential !== undefined
            ? { clearCredential: request.clearCredential }
            : {}),
        });
        return { ok: true, type: "ai.profiles.saved", id } satisfies RendererResult;
      } catch (error) {
        if (error instanceof AiProfileValidationError) {
          return {
            ok: false,
            error: createPublicError("AI_SETTINGS_INCOMPLETE"),
          } satisfies RendererResult;
        }
        runtime.logError("ai.profile.save", error, { profileId: request.id ?? null });
        return {
          ok: false,
          error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
        } satisfies RendererResult;
      }
    }
    case "ai.profiles.activate.request": {
      try {
        runtime.activateConnectionProfile(request.id);
        return {
          ok: true,
          type: "ai.profiles.activated",
          id: request.id,
        } satisfies RendererResult;
      } catch (error) {
        if (error instanceof AiProfileValidationError) {
          return {
            ok: false,
            error: createPublicError("AI_SETTINGS_INCOMPLETE"),
          } satisfies RendererResult;
        }
        runtime.logError("ai.profile.activate", error, { profileId: request.id });
        return {
          ok: false,
          error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
        } satisfies RendererResult;
      }
    }
    case "ai.profiles.delete.request": {
      try {
        runtime.deleteConnectionProfile(request.id);
        return {
          ok: true,
          type: "ai.profiles.deleted",
          id: request.id,
        } satisfies RendererResult;
      } catch (error) {
        if (error instanceof AiProfileValidationError) {
          return {
            ok: false,
            error: createPublicError("AI_SETTINGS_INCOMPLETE"),
          } satisfies RendererResult;
        }
        runtime.logError("ai.profile.delete", error, { profileId: request.id });
        return {
          ok: false,
          error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
        } satisfies RendererResult;
      }
    }
    case "ai.test-connection.request": {
      // Resolve credentials here so a missing key returns AI_NOT_CONFIGURED
      // instead of the generic CANCELLED path from commandFor().
      let apiKey = request.apiKey?.trim() ?? "";
      const apiFormat = request.apiFormat;
      const model = request.model;
      const baseUrl = request.baseUrl;
      if (!apiKey) {
        try {
          if (request.profileId) {
            // The selected profile supplies only its saved credential; probe
            // the protocol, model, and endpoint currently in the editor.
            apiKey = runtime.getDecryptedProfileApiKey(request.profileId);
          } else {
            apiKey = runtime.getDecryptedApiKey();
          }
        } catch (error) {
          if (error instanceof AiProfileStorageError) {
            runtime.logError("ai.profile-storage.read", error, { operation: request.type });
            return {
              ok: false,
              error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
            } satisfies RendererResult;
          }
          return {
            ok: false,
            error: createPublicError("AI_ANALYSIS_FAILED", "AI_NOT_CONFIGURED"),
          } satisfies RendererResult;
        }
      }
      if (!runtime.workerAvailable()) throw new Error("Library Worker is unavailable.");
      const workerResult = await runtime.requestWorker({
        type: "ai.test-connection",
        apiFormat,
        model,
        apiKey,
        ...(baseUrl?.trim()
          ? { baseUrl: baseUrl.trim() }
          : {}),
      });
      if (!workerResult.ok) {
        return {
          ok: false,
          error: workerResult.error,
        } satisfies RendererResult;
      }
      if (workerResult.type !== "ai.test-connection.result") {
        return {
          ok: false,
          error: createPublicError("AI_ANALYSIS_FAILED"),
        } satisfies RendererResult;
      }
      return {
        ok: true,
        type: "ai.test-connection.result",
        success: workerResult.success,
        ...(workerResult.errorKind
          ? { errorKind: workerResult.errorKind }
          : {}),
        ...(workerResult.reason ? { reason: workerResult.reason } : {}),
      } satisfies RendererResult;
    }
    case "ai.list-models.request": {
      let apiKey = request.apiKey?.trim() ?? "";
      const apiFormat = request.apiFormat;
      const baseUrl = request.baseUrl;
      if (!apiKey) {
        try {
          if (request.profileId) {
            // Keep the current editor settings and use the profile only as a
            // secure credential reference.
            apiKey = runtime.getDecryptedProfileApiKey(request.profileId);
          } else {
            apiKey = runtime.getDecryptedApiKey();
          }
        } catch (error) {
          if (error instanceof AiProfileStorageError) {
            runtime.logError("ai.profile-storage.read", error, { operation: request.type });
            return {
              ok: false,
              error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
            } satisfies RendererResult;
          }
          return {
            ok: true,
            type: "ai.list-models.result",
            models: [],
            errorKind: "auth",
            reason: "API key is required to list models.",
          } satisfies RendererResult;
        }
      }
      const listed = await listAiModels({
        apiFormat,
        apiKey,
        baseUrl,
      });
      if (!listed.ok) {
        return {
          ok: true,
          type: "ai.list-models.result",
          models: [],
          errorKind: listed.errorKind,
          reason: listed.reason,
        } satisfies RendererResult;
      }
      return {
        ok: true,
        type: "ai.list-models.result",
        models: listed.models,
      } satisfies RendererResult;
    }
    case "ai.search-plan.request": {
      const configRead = readAiConfigForRequest(runtime, request.type);
      if (!configRead.ok) return configRead.result;
      const config = configRead.config;
      if (!config.hasKey || !config.disclaimerAccepted) {
        runtime.logInfo(
          "ai.search-plan.unavailable",
          "AI search requires configured credentials and accepted disclosure.",
          {
            apiFormat: config.apiFormat,
            hasKey: config.hasKey,
            disclaimerAccepted: config.disclaimerAccepted,
          },
        );
        return {
          ok: false,
          error: createPublicError("AI_SEARCH_FAILED", "AI_NOT_CONFIGURED"),
        } satisfies RendererResult;
      }
      let apiKey: string;
      try {
        apiKey = runtime.getDecryptedApiKey();
      } catch (caught) {
        if (caught instanceof AiProfileStorageError) {
          runtime.logError("ai.profile-storage.read", caught, { operation: request.type });
          return {
            ok: false,
            error: createPublicError("AI_PROFILE_STORAGE_FAILED"),
          } satisfies RendererResult;
        }
        runtime.logError("ai.search-plan.credentials", caught, {
          apiFormat: config.apiFormat,
        });
        return {
          ok: false,
          error: createPublicError("AI_SEARCH_FAILED", "AI_NOT_CONFIGURED"),
        } satisfies RendererResult;
      }
      try {
        const plan = await planAiSearch({
          apiFormat: config.apiFormat,
          model: config.model,
          apiKey,
          baseUrl: config.baseUrl,
          languages: config.languages,
          naturalQuery: request.naturalQuery,
        });
        runtime.logInfo("ai.search-plan.completed", "AI search plan validated.", {
          apiFormat: config.apiFormat,
          model: config.model,
          keywordCount: plan.keywords.length,
          synonymCount: plan.synonyms.length,
          exclusionCount: plan.exclusions.length,
          filterCount: plan.filters.length,
        });
        return {
          ok: true,
          type: "ai.search-plan.result",
          plan,
          apiFormat: config.apiFormat,
          model: config.model,
        } satisfies RendererResult;
      } catch (caught) {
        const reason = aiSearchFailureReason(caught);
        runtime.logError("ai.search-plan.failed", caught, {
          apiFormat: config.apiFormat,
          model: config.model,
          reason,
        });
        return {
          ok: false,
          error: createPublicError("AI_SEARCH_FAILED", reason),
        } satisfies RendererResult;
      }
    }
    default:
      return undefined;
  }
}
