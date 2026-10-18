import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { PublicError } from "../shared/protocol/errors";
import type { EmbeddingInstallProgress } from "../shared/embedding/install-progress";
import { isEmbeddingSelectionId } from "../shared/embedding/http-service";
import {
  SETTINGS_LOCAL_SEMANTIC_MODELS,
  SEMANTIC_MODEL_PACKAGE_BYTES,
  type SemanticSearchModelId,
} from "../shared/embedding/profile";
import { EmbeddingServiceSettings, type EmbeddingServiceSettingsApi } from "./EmbeddingServiceSettings";
import { notifyEmbeddingCatalogChanged, setEmbeddingInstallActive, subscribeEmbeddingCatalog } from "./embedding-catalog-events";
import { messageForPublicError } from "./error-utils";
import { formatBytes } from "./format-file-meta";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useLocale, useT } from "./i18n";
import {
  SEMANTIC_SEARCH_PAGE_SIZES,
  loadSemanticSearchPreferences,
  saveSemanticSearchPreferences,
  type SemanticSearchPageSize,
} from "./semantic-search-preferences";
import { SettingsCard } from "./ui/patterns";
import { Switch } from "./ui/primitives";

type InstallSnapshot = {
  runtimeInstalled: boolean;
  runtimeDownloadable: boolean;
  models: Array<{ modelId: SemanticSearchModelId; installed: boolean }>;
};

type ModelInstallState = "ready" | "missing" | "missing-runtime" | "runtime-unavailable" | "unknown";

export type EmbeddingCatalogApi = EmbeddingServiceSettingsApi & {
  embeddingInstallStatus: () => Promise<{ ok: boolean; value?: InstallSnapshot; error?: PublicError }>;
  embeddingInstall: (input: { modelId: SemanticSearchModelId }) => Promise<{ ok: boolean; value?: InstallSnapshot; error?: PublicError }>;
  embeddingUninstall: (input: { modelId: SemanticSearchModelId }) => Promise<{ ok: boolean; value?: InstallSnapshot; error?: PublicError }>;
  onEmbeddingInstallProgress?: (listener: (event: EmbeddingInstallProgress) => void) => () => void;
};

function resolveModelState(
  installed: boolean,
  install: InstallSnapshot | null,
): ModelInstallState {
  if (!install) return "unknown";
  if (!installed) return "missing";
  if (install.runtimeInstalled) return "ready";
  if (!install.runtimeDownloadable) return "runtime-unavailable";
  return "missing-runtime";
}

function progressPercent(progress: EmbeddingInstallProgress | null): number | null {
  if (!progress || progress.totalBytes == null || progress.totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((progress.bytesDownloaded / progress.totalBytes) * 100)));
}

export function SemanticSearchSettings({
  libraryId,
  servicesApi,
}: {
  libraryId?: string;
  servicesApi?: EmbeddingCatalogApi;
}): ReactNode {
  const t = useT();
  const { locale } = useLocale();
  const [prefs, setPrefs] = useState(() => loadSemanticSearchPreferences());
  const [mode, setMode] = useState<"local" | "custom">("local");
  const [install, setInstall] = useState<InstallSnapshot | null>(null);
  const [installingId, setInstallingId] = useState<SemanticSearchModelId | null>(null);
  const [uninstallingId, setUninstallingId] = useState<SemanticSearchModelId | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [progress, setProgress] = useState<EmbeddingInstallProgress | null>(null);
  const [serviceOptions, setServiceOptions] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!servicesApi) return;
    let cancelled = false;
    async function loadCatalog(): Promise<void> {
      if (!servicesApi) return;
      const [status, listed] = await Promise.all([
        servicesApi.embeddingInstallStatus(),
        servicesApi.embeddingListServices(),
      ]);
      if (cancelled) return;
      if (status.ok && status.value) setInstall(status.value);
      if (listed.ok && listed.value) {
        setServiceOptions(listed.value.map((service) => ({ id: service.id, name: service.name })));
      }
    }
    void loadCatalog();
    const unsubscribe = subscribeEmbeddingCatalog(() => {
      void loadCatalog();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [servicesApi]);

  useEffect(() => {
    if (!servicesApi?.onEmbeddingInstallProgress) return;
    return servicesApi.onEmbeddingInstallProgress((event) => {
      setProgress(event);
    });
  }, [servicesApi]);

  const localModels = useMemo(() => [...SETTINGS_LOCAL_SEMANTIC_MODELS], []);

  function updatePrefs(patch: Partial<{ enabled: boolean; modelId: string; pageSize: SemanticSearchPageSize }>): void {
    const saved = { ...loadSemanticSearchPreferences(), ...patch };
    saveSemanticSearchPreferences(saved);
    setPrefs(saved);
    notifyEmbeddingCatalogChanged();
  }

  function updatePageSize(pageSize: SemanticSearchPageSize): void {
    updatePrefs({ pageSize });
  }

  async function installModel(modelId: SemanticSearchModelId): Promise<void> {
    if (!servicesApi || installingId || uninstallingId) return;
    setInstallingId(modelId);
    setInstallError(null);
    setProgress({
      modelId,
      phase: "downloading-model",
      bytesDownloaded: 0,
    });
    setEmbeddingInstallActive(true);
    try {
      const result = await servicesApi.embeddingInstall({ modelId });
      if (!result.ok || !result.value) {
        setInstallError(result.error
          ? messageForPublicError(result.error, locale, t("error.code.EMBEDDING_INSTALL_FAILED"))
          : t("error.code.EMBEDDING_INSTALL_FAILED"));
        return;
      }
      setInstall(result.value);
      notifyEmbeddingCatalogChanged();
      setProgress({
        modelId,
        phase: "ready",
        bytesDownloaded: SEMANTIC_MODEL_PACKAGE_BYTES[modelId],
        totalBytes: SEMANTIC_MODEL_PACKAGE_BYTES[modelId],
      });
    } finally {
      setInstallingId(null);
      setEmbeddingInstallActive(false);
    }
  }

  async function uninstallModel(modelId: SemanticSearchModelId): Promise<void> {
    if (!servicesApi || installingId || uninstallingId) return;
    setUninstallingId(modelId);
    setInstallError(null);
    try {
      const result = await servicesApi.embeddingUninstall({ modelId });
      if (!result.ok || !result.value) {
        setInstallError(result.error
          ? messageForPublicError(result.error, locale, t("error.code.EMBEDDING_INSTALL_FAILED"))
          : t("error.code.EMBEDDING_INSTALL_FAILED"));
        return;
      }
      setInstall(result.value);
      notifyEmbeddingCatalogChanged();
      setProgress(null);
    } finally {
      setUninstallingId(null);
    }
  }

  const installedIds = new Set(
    (install?.models ?? []).filter((entry) => entry.installed).map((entry) => entry.modelId),
  );
  const defaultChoices: Array<{ id: string; label: string }> = [
    ...localModels.map((modelId) => ({
      id: modelId,
      label: `${t("settings.semanticSearch.modelCompact")}${installedIds.has(modelId) ? "" : ` (${t("settings.semanticSearch.installNotInstalled")})`}`,
    })),
    ...serviceOptions.map((service) => ({ id: service.id, label: service.name })),
  ];
  if (prefs.modelId && isEmbeddingSelectionId(prefs.modelId) && !defaultChoices.some((item) => item.id === prefs.modelId)) {
    defaultChoices.unshift({ id: prefs.modelId, label: prefs.modelId });
  }

  return (
    <div className="semantic-search-layout">
      <SettingsCard className="semantic-enable-card">
        <div className="app-settings-toggle-row">
          <div className="app-settings-row-copy">
            <strong>{t("settings.semanticSearch.enabled")}</strong>
            <span>{t("settings.semanticSearch.enabledHint")}</span>
          </div>
          <Switch
            aria-label={t("settings.semanticSearch.enabled")}
            checked={prefs.enabled}
            onCheckedChange={(enabled) => updatePrefs({ enabled })}
          />
        </div>
        <p className="app-settings-hint">{t("settings.semanticSearch.resourceNotice")}</p>
        <p className="app-settings-hint">{t("settings.semanticSearch.videoCoverNote")}</p>
        <div className="app-settings-card-divider" />
        <div className="app-settings-action-row semantic-settings-toolbar">
          <div className="app-settings-row-copy">
            <strong>{t("settings.semanticSearch.defaultModel")}</strong>
            <span>{t("settings.semanticSearch.defaultModelHint")}</span>
          </div>
          <select
            aria-label={t("settings.semanticSearch.defaultModel")}
            className="text-field semantic-default-model-select"
            disabled={!prefs.enabled || defaultChoices.length === 0}
            onChange={(event) => updatePrefs({ modelId: event.target.value })}
            value={prefs.modelId}
          >
            {defaultChoices.length === 0 ? (
              <option value={prefs.modelId}>{t("settings.semanticSearch.defaultModelEmpty")}</option>
            ) : null}
            {defaultChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label}</option>
            ))}
          </select>
        </div>
      </SettingsCard>

      <SettingsCard className={`semantic-search-card${prefs.enabled ? "" : " is-dimmed"}`}>
        <div className="app-settings-row-copy">
          <strong>{t("settings.semanticSearch.modelTitle")}</strong>
          <span>{t("settings.semanticSearch.libraryChooses")}</span>
        </div>

        <div
          aria-label={t("settings.semanticSearch.modelTitle")}
          className="semantic-settings-tabs"
          role="tablist"
        >
          <button
            aria-controls="semantic-settings-panel-local"
            aria-selected={mode === "local"}
            className={`semantic-settings-tab${mode === "local" ? " is-active" : ""}`}
            id="semantic-settings-tab-local"
            onClick={() => setMode("local")}
            role="tab"
            type="button"
          >
            {t("settings.semanticSearch.modeLocal")}
          </button>
          <button
            aria-controls="semantic-settings-panel-custom"
            aria-selected={mode === "custom"}
            className={`semantic-settings-tab${mode === "custom" ? " is-active" : ""}`}
            id="semantic-settings-tab-custom"
            onClick={() => setMode("custom")}
            role="tab"
            type="button"
          >
            {t("settings.semanticSearch.modeCustom")}
          </button>
        </div>

        {mode === "local" ? (
          <div
            aria-labelledby="semantic-settings-tab-local"
            className="semantic-settings-tabpanel"
            id="semantic-settings-panel-local"
            role="tabpanel"
          >
            <div className="semantic-model-list" role="list">
              {localModels.map((modelId) => {
                const installed = install?.models.some((entry) => entry.modelId === modelId && entry.installed) ?? false;
                const working = installingId === modelId;
                const state = resolveModelState(installed, install);
                const statusLabel = state === "ready"
                  ? t("settings.semanticSearch.installReady")
                  : state === "missing-runtime"
                    ? t("settings.semanticSearch.installNeedsRuntime")
                    : state === "runtime-unavailable"
                      ? t("settings.semanticSearch.installUnavailable")
                      : state === "missing"
                        ? t("settings.semanticSearch.installNotInstalled")
                        : null;
                const statusDetail = state === "missing-runtime"
                  ? t("settings.semanticSearch.installMissingRuntime")
                  : state === "runtime-unavailable"
                    ? t("settings.semanticSearch.installRuntimeUnavailable")
                    : null;
                const statusTone = state === "ready"
                  ? "connected"
                  : state === "missing-runtime"
                    ? "checking"
                    : state === "runtime-unavailable"
                      ? "failed"
                      : "idle";
                const actionLabel = working
                  ? t("settings.semanticSearch.installWorking")
                  : t("settings.semanticSearch.installAction");
                const deleteLabel = uninstallingId === modelId
                  ? t("settings.semanticSearch.installRemoving")
                  : t("settings.semanticSearch.installDelete");
                const packageBytes = SEMANTIC_MODEL_PACKAGE_BYTES[modelId];
                const activeProgress = working ? progress : null;
                const percent = progressPercent(activeProgress);
                const downloadDisabled = (
                  installingId !== null
                  || uninstallingId !== null
                  || state === "ready"
                  || state === "runtime-unavailable"
                );
                return (
                  <div className="semantic-model-card" key={modelId} role="listitem">
                    <div className="semantic-model-card-copy">
                      <div className="semantic-model-card-title-row">
                        <strong>{t("settings.semanticSearch.modelCompact")}</strong>
                        {statusLabel ? (
                          <span className="sync-status-indicator" data-state={statusTone}>
                            <span className="sync-status-dot" data-state={statusTone} />
                            <span>{statusLabel}</span>
                          </span>
                        ) : null}
                      </div>
                      <span>{t("settings.semanticSearch.modelCompactHint")}</span>
                      <span className="semantic-model-size">
                        {t("settings.semanticSearch.modelSize", { size: formatBytes(packageBytes) })}
                      </span>
                      {statusDetail ? <span>{statusDetail}</span> : null}
                      {working ? (
                        <div className="semantic-install-progress" role="status">
                          <div className="semantic-install-progress-label">
                            <span>
                              {activeProgress?.phase === "downloading-runtime"
                                ? t("settings.semanticSearch.installPhaseRuntime")
                                : activeProgress?.phase === "extracting"
                                  ? t("settings.semanticSearch.installPhaseExtract")
                                  : t("settings.semanticSearch.installPhaseModel")}
                            </span>
                            {percent != null ? <span>{percent}%</span> : null}
                          </div>
                          <progress
                            aria-label={actionLabel}
                            className="semantic-install-progress-bar"
                            max={activeProgress?.totalBytes ?? 1}
                            value={activeProgress?.totalBytes == null ? undefined : activeProgress.bytesDownloaded}
                          />
                          {activeProgress?.totalBytes != null ? (
                            <span className="app-settings-hint">
                              {formatBytes(activeProgress.bytesDownloaded)}
                              {" / "}
                              {formatBytes(activeProgress.totalBytes)}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="semantic-model-card-action">
                      <button
                        className="semantic-install-icon-button"
                        disabled={downloadDisabled}
                        onClick={() => { void installModel(modelId); }}
                        type="button"
                        {...iconActionAttrs(actionLabel)}
                      >
                        <Icon name={working ? "refresh" : "download"} size={15} />
                      </button>
                      {state === "ready" || state === "missing-runtime" ? (
                        <button
                          className="semantic-install-icon-button is-danger"
                          disabled={installingId !== null || uninstallingId !== null}
                          onClick={() => { void uninstallModel(modelId); }}
                          type="button"
                          {...iconActionAttrs(deleteLabel)}
                        >
                          <Icon name="trash" size={15} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {installError ? <p className="settings-error-message">{installError}</p> : null}
          </div>
        ) : servicesApi ? (
          <div
            aria-labelledby="semantic-settings-tab-custom"
            className="semantic-settings-tabpanel"
            id="semantic-settings-panel-custom"
            role="tabpanel"
          >
            <EmbeddingServiceSettings api={servicesApi} libraryId={libraryId} />
          </div>
        ) : null}
      </SettingsCard>

      <SettingsCard className="semantic-batch-card">
        <div className="app-settings-action-row semantic-settings-toolbar">
          <div className="app-settings-row-copy">
            <strong>{t("settings.semanticSearch.pageSizeTitle")}</strong>
            <span>{t("settings.semanticSearch.pageSizeHint")}</span>
          </div>
          <div
            aria-label={t("settings.semanticSearch.pageSizeTitle")}
            className="app-settings-option-group semantic-settings-segment"
            role="radiogroup"
          >
            {SEMANTIC_SEARCH_PAGE_SIZES.map((pageSize) => (
              <button
                aria-checked={prefs.pageSize === pageSize}
                className="app-settings-option"
                key={pageSize}
                onClick={() => updatePageSize(pageSize)}
                role="radio"
                type="button"
              >
                {pageSize}
              </button>
            ))}
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
