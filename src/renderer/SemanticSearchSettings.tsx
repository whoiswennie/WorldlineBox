import { useEffect, useState, type ReactNode } from "react";
import type { PublicError } from "../shared/protocol/errors";
import type { GlobalEmbeddingSettings } from '../shared/embedding/global-settings';
import type { EmbeddingInstallProgress } from "../shared/embedding/install-progress";
import type { SemanticSearchModelId } from "../shared/embedding/profile";
import type { EmbeddingServiceSettingsApi } from "./EmbeddingServiceSettings";
import { LocalTextEmbeddingSettings, type LocalTextEmbeddingApi } from "./LocalTextEmbeddingSettings";
import { loadSemanticSearchPreferences, saveSemanticSearchPreferences, subscribeSemanticSearchPreferences, SEMANTIC_SEARCH_PAGE_SIZES } from "./semantic-search-preferences";
import { SettingsCard } from "./ui/patterns";
import { Switch } from "./ui/primitives";
import { useT } from "./i18n";
type InstallSnapshot = { runtimeInstalled: boolean; runtimeDownloadable: boolean; models: Array<{ modelId: SemanticSearchModelId; installed: boolean }> };
export type EmbeddingCatalogApi = EmbeddingServiceSettingsApi & {
  embeddingLocalTextStatus?: LocalTextEmbeddingApi['embeddingLocalTextStatus'];
  embeddingLocalTextInstall?: LocalTextEmbeddingApi['embeddingLocalTextInstall'];
  embeddingLocalTextDelete?: LocalTextEmbeddingApi['embeddingLocalTextDelete'];
  embeddingGetGlobalSettings?: () => Promise<{ ok: boolean; value?: GlobalEmbeddingSettings; error?: PublicError }>;
  embeddingSaveGlobalSettings?: (input: { selectionId: string | null }) => Promise<{ ok: boolean; value?: GlobalEmbeddingSettings; error?: PublicError }>;
  embeddingInstallStatus: () => Promise<{ ok: boolean; value?: InstallSnapshot; error?: PublicError }>;
  embeddingInstall: (input: { modelId: SemanticSearchModelId }) => Promise<{ ok: boolean; value?: InstallSnapshot; error?: PublicError }>;
  embeddingUninstall: (input: { modelId: SemanticSearchModelId }) => Promise<{ ok: boolean; value?: InstallSnapshot; error?: PublicError }>;
  onEmbeddingInstallProgress?: (listener: (event: EmbeddingInstallProgress) => void) => () => void;
};


export function SemanticSearchSettings({ servicesApi, section = "all" }: {
  libraryId?: string; servicesApi?: EmbeddingCatalogApi; section?: "all" | "models" | "search";
}): ReactNode {
  const t = useT();
  const [prefs, setPrefs] = useState(() => loadSemanticSearchPreferences());
  useEffect(() => subscribeSemanticSearchPreferences(() => setPrefs(loadSemanticSearchPreferences())), []);
  function save(patch: Partial<typeof prefs>) {
    const value = { ...loadSemanticSearchPreferences(), ...patch, modelId: "embeddinggemma-2-compact" };
    saveSemanticSearchPreferences(value); setPrefs(value);
  }
  const manager = servicesApi?.embeddingLocalTextStatus && servicesApi.embeddingLocalTextInstall && servicesApi.embeddingLocalTextDelete
    ? servicesApi as LocalTextEmbeddingApi : undefined;
  return <div className="semantic-search-layout">
    {section !== "search" && <SettingsCard className="semantic-search-card semantic-embedding-card">
      <div className="semantic-model-list" role="list"><LocalTextEmbeddingSettings api={manager} /></div>
    </SettingsCard>}
    {section !== "models" && <>
      <SettingsCard className="semantic-enable-card"><div className="app-settings-toggle-row"><div className="app-settings-row-copy">
        <strong>{t("settings.semanticSearch.enabled")}</strong><span>{t("settings.semanticSearch.enabledHint")}</span></div>
        <Switch aria-label={t("settings.semanticSearch.enabled")} checked={prefs.enabled} onCheckedChange={enabled => save({ enabled })} />
      </div><p className="app-settings-hint">{t("settings.semanticSearch.resourceNotice")}</p><p className="app-settings-hint">{t("settings.semanticSearch.videoCoverNote")}</p></SettingsCard>
      <SettingsCard className="semantic-batch-card"><div className="app-settings-action-row semantic-settings-toolbar"><div className="app-settings-row-copy">
        <strong>{t("settings.semanticSearch.pageSizeTitle")}</strong><span>{t("settings.semanticSearch.pageSizeHint")}</span></div>
        <div aria-label={t("settings.semanticSearch.pageSizeTitle")} className="app-settings-option-group semantic-settings-segment" role="radiogroup">
          {SEMANTIC_SEARCH_PAGE_SIZES.map(pageSize => <button key={pageSize} type="button" role="radio" aria-checked={prefs.pageSize === pageSize} className="app-settings-option" onClick={() => save({ pageSize })}>{pageSize}</button>)}
        </div></div></SettingsCard>
    </>}
  </div>;
}
