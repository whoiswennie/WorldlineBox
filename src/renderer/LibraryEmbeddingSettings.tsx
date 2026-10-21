import { useEffect, useState, type ReactNode } from "react";

import type { EmbeddingIndexSnapshot, SemanticSearchModelId } from "../shared/embedding/profile";
import { embeddingBindingIssue } from "../shared/embedding/library-binding";
import { isEmbeddingServiceSelectionId } from "../shared/embedding/http-service";
import { embeddingServiceTextOnly } from "../shared/embedding/modalities";
import type { EmbeddingHttpServiceSummary } from "../shared/library-api";
import { notifyEmbeddingCatalogChanged, subscribeEmbeddingCatalog } from "./embedding-catalog-events";
import { useT } from "./i18n";
import { loadSemanticSearchPreferences } from "./semantic-search-preferences";
import { embeddingIndexCopyKey } from "./semantic-index-copy";

const MODEL_LABEL_KEYS = {
  "embeddinggemma-2-compact": "settings.semanticSearch.modelCompact",
  "embeddinggemma-2-balanced": "settings.semanticSearch.modelBalanced",
  "embeddinggemma-2-quality": "settings.semanticSearch.modelQuality",
} as const;

const INHERIT_VALUE = "";
const OFF_VALUE = "__off__";

type InstallSnapshot = {
  runtimeInstalled: boolean;
  models: Array<{ modelId: SemanticSearchModelId; installed: boolean }>;
};

export type LibraryEmbeddingCallbacks = {
  listServices: () => Promise<{ ok: true; value: EmbeddingHttpServiceSummary[] } | { ok: false }>;
  installStatus: () => Promise<{ ok: true; value: InstallSnapshot } | { ok: false }>;
  getBinding: (input: { libraryId: string }) => Promise<{ ok: true; value: { selectionId: string | null; enabled: boolean; inherit: boolean } } | { ok: false }>;
  saveBinding: (input: { libraryId: string; selectionId: string | null; inherit?: boolean }) => Promise<{ ok: true } | { ok: false }>;
  rebuildIndex: (input: { libraryId: string; modelId: string }) => Promise<{ ok: true } | { ok: false }>;
};

function toSelectValue(binding: { selectionId: string | null; enabled: boolean; inherit: boolean }): string {
  if (binding.inherit) return INHERIT_VALUE;
  if (!binding.enabled || !binding.selectionId) return OFF_VALUE;
  return INHERIT_VALUE;
}

function indexStatusTone(phase: EmbeddingIndexSnapshot["phase"]): "checking" | "connected" | "failed" | "idle" {
  if (phase === "starting" || phase === "indexing") return "checking";
  if (phase === "ready") return "connected";
  if (phase === "failed") return "failed";
  return "idle";
}

function indexPhaseLabelKey(phase: EmbeddingIndexSnapshot["phase"]): string {
  if (phase === "starting" || phase === "indexing") return "settings.librarySemantic.indexPhaseIndexing";
  if (phase === "ready") return "settings.librarySemantic.indexPhaseReady";
  if (phase === "failed") return "settings.librarySemantic.indexPhaseFailed";
  return "settings.librarySemantic.indexPhaseUnavailable";
}

export function LibraryEmbeddingSettings({
  libraryId,
  callbacks,
  index,
}: {
  libraryId: string;
  callbacks: LibraryEmbeddingCallbacks;
  index: EmbeddingIndexSnapshot | null;
}): ReactNode {
  const t = useT();
  const [services, setServices] = useState<EmbeddingHttpServiceSummary[]>([]);
  const [install, setInstall] = useState<InstallSnapshot | null>(null);
  const [selectionValue, setSelectionValue] = useState(INHERIT_VALUE);
  const [savedValue, setSavedValue] = useState(INHERIT_VALUE);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const globalPrefs = loadSemanticSearchPreferences();

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const [listed, status, binding] = await Promise.all([
        callbacks.listServices(),
        callbacks.installStatus(),
        callbacks.getBinding({ libraryId }),
      ]);
      if (cancelled) return;
      if (listed.ok) setServices(listed.value);
      if (status.ok) setInstall(status.value);
      if (binding.ok) {
        const next = toSelectValue(binding.value);
        setSelectionValue(next);
        setSavedValue(next);
      }
    }
    void load();
    const unsubscribe = subscribeEmbeddingCatalog(() => {
      void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId]);

  const installed = new Set(
    (install?.models ?? []).filter((model) => model.installed).map((model) => model.modelId),
  );
  const nothingReady = installed.size === 0 && services.length === 0;
  const effectiveSelectionId = savedValue === INHERIT_VALUE
    ? globalPrefs.enabled ? globalPrefs.modelId : null
    : savedValue === OFF_VALUE ? null : globalPrefs.modelId;
  const savedBinding = effectiveSelectionId
    ? { selectionId: effectiveSelectionId, enabled: true }
    : { selectionId: null, enabled: false };
  const issue = embeddingBindingIssue({
    binding: savedBinding,
    services: new Map(services.map((service) => [service.id, service])),
    runtimeInstalled: install?.runtimeInstalled ?? false,
    installedModelIds: installed,
  });
  const defaultLabel = (() => {
    const id = globalPrefs.modelId;
    if (id in MODEL_LABEL_KEYS) return t(MODEL_LABEL_KEYS[id as keyof typeof MODEL_LABEL_KEYS]);
    const service = services.find((item) => item.id === id);
    return service?.name ?? id;
  })();
  const dirty = selectionValue !== savedValue;
  const showIndex = Boolean(
    issue === "ready"
    && index
    && effectiveSelectionId,
  );

  async function save(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const inherit = selectionValue === INHERIT_VALUE;
      const result = await callbacks.saveBinding({
        libraryId,
        selectionId: inherit || selectionValue === OFF_VALUE ? null : selectionValue,
        ...(inherit ? { inherit: true } : {}),
      });
      if (!result.ok) return;
      setSavedValue(selectionValue);
      setNotice(t("settings.librarySemantic.saved"));
      notifyEmbeddingCatalogChanged();
    } finally {
      setBusy(false);
    }
  }

  async function rebuildIndex(): Promise<void> {
    if (!effectiveSelectionId) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await callbacks.rebuildIndex({ libraryId, modelId: effectiveSelectionId });
      if (!result.ok) setNotice(t("settings.librarySemantic.rebuildFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="app-settings-page-heading">
        <h3>{t("settings.librarySemantic.title")}</h3>
        <p>{t("settings.librarySemantic.hint")}</p>
      </div>
      <section className="app-settings-card library-semantic-card">
        <div className="app-settings-row app-settings-row-stack">
          <div className="app-settings-row-copy">
            <strong>{t("settings.librarySemantic.model")}</strong>
            <span>{t("settings.librarySemantic.inheritHint", { model: defaultLabel })}</span>
          </div>
          <select
            aria-label={t("settings.librarySemantic.model")}
            className="text-field library-semantic-select"
            onChange={(event) => {
              setSelectionValue(event.target.value);
              setNotice(null);
            }}
            value={selectionValue}
          >
            <option value={INHERIT_VALUE}>
              {t("settings.librarySemantic.inherit", { model: defaultLabel })}
            </option>
            <option value={OFF_VALUE}>{t("settings.librarySemantic.off")}</option>
          </select>
          {!globalPrefs.enabled ? (
            <p className="app-settings-help-note">{t("settings.librarySemantic.globalOff")}</p>
          ) : null}
          {nothingReady ? <p className="app-settings-help-note">{t("settings.librarySemantic.empty")}</p> : null}
          {savedValue !== INHERIT_VALUE && issue === "missing" ? (
            <p className="app-settings-help-note">{t("settings.librarySemantic.missing")}</p>
          ) : null}
          {savedValue !== INHERIT_VALUE && issue === "install" ? (
            <p className="app-settings-help-note">{t("settings.librarySemantic.install")}</p>
          ) : null}
          {savedValue !== INHERIT_VALUE && issue === "configure" ? (
            <p className="app-settings-help-note">{t("settings.librarySemantic.configure")}</p>
          ) : null}
        </div>

        {showIndex && index ? (
          <>
            <div className="app-settings-card-divider" />
            <div className="app-settings-row library-semantic-status-row">
              <div className="app-settings-row-copy">
                <strong>{t("settings.librarySemantic.indexStatus")}</strong>
                <span>
                  {t(embeddingIndexCopyKey(index, {
                    textOnly: isEmbeddingServiceSelectionId(savedValue)
                      && embeddingServiceTextOnly(services.find((item) => item.id === savedValue)?.modalities),
                  }), {
                    done: index.done,
                    total: index.total,
                    failed: index.failedCount,
                  })}
                </span>
              </div>
              <span className="sync-status-indicator" data-state={indexStatusTone(index.phase)} role="status">
                <span className="sync-status-dot" data-state={indexStatusTone(index.phase)} />
                <span>{t(indexPhaseLabelKey(index.phase))}</span>
              </span>
            </div>
            {index.phase === "failed" ? (
              <>
                <p className="app-settings-help-note">{t("settings.librarySemantic.rebuildHint")}</p>
                <div className="library-settings-gitignore-actions library-sync-actions">
                  <button className="primary-button" disabled={busy} onClick={() => { void rebuildIndex(); }} type="button">
                    {t("settings.librarySemantic.rebuildIndex")}
                  </button>
                </div>
              </>
            ) : null}
          </>
        ) : null}

        <div className="app-settings-card-divider" />
        <div className="library-settings-gitignore-actions library-sync-actions">
          <button
            className="primary-button"
            disabled={busy || !dirty}
            onClick={() => { void save(); }}
            type="button"
          >
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
        {notice ? <p className="library-settings-gitignore-help library-semantic-notice">{notice}</p> : null}
      </section>
    </>
  );
}
