import { useEffect, useState, type ReactNode } from "react";
import type { PublicError } from "../shared/protocol/errors";
import type { GlobalEmbeddingSettings } from '../shared/embedding/global-settings';
import type { EmbeddingInstallProgress } from "../shared/embedding/install-progress";
import type { SemanticSearchModelId } from "../shared/embedding/profile";
import type { EmbeddingServiceSettingsApi } from "./EmbeddingServiceSettings";
import type { EmbeddingDeviceCapability } from '../shared/embedding/device-capability';
import { LocalTextEmbeddingSettings, type LocalTextEmbeddingApi } from "./LocalTextEmbeddingSettings";
import { DeviceCapabilitySettings, type DeviceCapabilitySettingsApi } from './DeviceCapabilitySettings';
import { loadSemanticSearchPreferences, saveSemanticSearchPreferences, subscribeSemanticSearchPreferences, SEMANTIC_SEARCH_PAGE_SIZES } from "./semantic-search-preferences";
import { SettingsCard } from "./ui/patterns";
import { Button, Switch } from "./ui/primitives";
import { useLocale, useT } from "./i18n";
import './semantic-search-settings.css';
type InstallSnapshot = { runtimeInstalled: boolean; runtimeDownloadable: boolean; models: Array<{ modelId: SemanticSearchModelId; installed: boolean }> };
export type EmbeddingCatalogApi = EmbeddingServiceSettingsApi & Partial<DeviceCapabilitySettingsApi> & {
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


export function SemanticSearchSettings({ servicesApi, section = "all", onOpenDeviceSettings }: {
  libraryId?: string; servicesApi?: EmbeddingCatalogApi; section?: "all" | "models" | "search";
  onOpenDeviceSettings?: () => void;
}): ReactNode {
  const t = useT();
  const { locale } = useLocale();
  const zh = locale === 'zh-CN';
  const [prefs, setPrefs] = useState(() => loadSemanticSearchPreferences());
  const [deviceSnapshot, setDeviceSnapshot] = useState<{ api: typeof servicesApi; value: EmbeddingDeviceCapability }>();
  const device = deviceSnapshot && deviceSnapshot.api === servicesApi ? deviceSnapshot.value : undefined;
  const limited = device?.state === 'unsupported' || device?.state === 'error';
  useEffect(() => subscribeSemanticSearchPreferences(() => setPrefs(loadSemanticSearchPreferences())), []);
  useEffect(() => {
    if (section === 'models' || !servicesApi?.embeddingDeviceStatus) return;
    let cancelled = false;
    const read = async () => {
      try {
        const result = await servicesApi.embeddingDeviceStatus!();
        if (!cancelled && result.ok) setDeviceSnapshot({ api: servicesApi, value: result.value });
      } catch { /* An unread result remains unknown; only an actual failed device check limits vectors. */ }
    };
    void read();
    window.addEventListener('focus', read);
    return () => { cancelled = true; window.removeEventListener('focus', read); };
  }, [servicesApi, section]);
  function save(patch: Partial<typeof prefs>) {
    if (patch.enabled === true && limited) return;
    const value = { ...loadSemanticSearchPreferences(), ...patch, modelId: "embeddinggemma-2-compact" };
    saveSemanticSearchPreferences(value); setPrefs(value);
  }
  const manager = servicesApi?.embeddingLocalTextStatus && servicesApi.embeddingLocalTextInstall && servicesApi.embeddingLocalTextDelete
    ? servicesApi as LocalTextEmbeddingApi : undefined;
  return <div className="semantic-search-layout">
    {section !== "search" && <SettingsCard className="semantic-search-card semantic-embedding-card">
      <div className="semantic-model-list" role="list"><LocalTextEmbeddingSettings api={manager} /></div>
    </SettingsCard>}
    {section !== "search" && <SettingsCard className="semantic-search-card"><DeviceCapabilitySettings api={servicesApi} /></SettingsCard>}
    {section !== "models" && <>
      <SettingsCard className="semantic-enable-card"><div className="app-settings-toggle-row"><div className="app-settings-row-copy">
        <strong>{t("settings.semanticSearch.enabled")}</strong><span>{t("settings.semanticSearch.enabledHint")}</span></div>
        <Switch aria-label={t("settings.semanticSearch.enabled")} checked={prefs.enabled} disabled={!prefs.enabled && limited} onCheckedChange={enabled => save({ enabled })} />
      </div>
      {limited && <div className="semantic-search-device-notice" role="status">
        <p><strong>{zh ? '本地向量功能暂不可用' : 'Local vector features are unavailable'}</strong><span>{zh ? (device?.message || '当前设备未通过运行检测，请在全局模型中重新检测。') : 'The device check did not pass. Recheck the device in Global models.'}</span></p>
        <p>{zh ? '普通资产全文搜索和已有文档查阅仍可使用。' : 'Full-text asset search and existing documents remain accessible.'}</p>
        {onOpenDeviceSettings && <Button size="sm" variant="quiet" onClick={onOpenDeviceSettings}>{zh ? '前往全局模型检测' : 'Open device checks'}</Button>}
      </div>}
      <p className="app-settings-hint">{t("settings.semanticSearch.resourceNotice")}</p><p className="app-settings-hint">{t("settings.semanticSearch.videoCoverNote")}</p></SettingsCard>
      <SettingsCard className="semantic-batch-card"><div className="app-settings-action-row semantic-settings-toolbar"><div className="app-settings-row-copy">
        <strong>{t("settings.semanticSearch.pageSizeTitle")}</strong><span>{t("settings.semanticSearch.pageSizeHint")}</span></div>
        <div aria-label={t("settings.semanticSearch.pageSizeTitle")} className="app-settings-option-group semantic-settings-segment" role="radiogroup">
          {SEMANTIC_SEARCH_PAGE_SIZES.map(pageSize => <button key={pageSize} type="button" role="radio" aria-checked={prefs.pageSize === pageSize} className="app-settings-option" onClick={() => save({ pageSize })}>{pageSize}</button>)}
        </div></div></SettingsCard>
    </>}
  </div>;
}
