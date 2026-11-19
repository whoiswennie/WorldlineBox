import { AppSettingsNavigation } from "./AppSettingsNavigation";
import { AppSettingsWindow } from "./AppSettingsWindow";
import { GeneralSettingsPage } from "./GeneralSettingsPage";
import { APP_SETTINGS_CATEGORIES, type AppSettingsCategoryId } from "./app-settings-sections";
import { useLocale } from "./i18n";
import { MusicSettingsSlot } from "./music/MusicProvider";
import { useDialogFocusTrap } from "./use-dialog-focus-trap";

export function FastAppSettings({ category, select, close, openPlugins, openLog, openExtensionReleases }: {
  category: AppSettingsCategoryId;
  select(category: AppSettingsCategoryId): void;
  close(): void;
  openPlugins(): void;
  openLog(): void;
  openExtensionReleases(): void;
}) {
  const { locale, t } = useLocale();
  const definition = APP_SETTINGS_CATEGORIES.find(item => item.id === category)!;
  useDialogFocusTrap(true);
  return <AppSettingsWindow onClose={close}>
    <div className="app-settings-frame">
      <AppSettingsNavigation activeCategory={category} activePluginSettingsId={null} pluginSettingsEntries={[]}
        onSelectCategory={select} onSelectPluginSettings={openPlugins} onOpenPluginSettingsRail={openPlugins} />
      <main aria-labelledby={`app-settings-tab-${category}`} className="app-settings-content" id={`app-settings-page-${category}`} role="tabpanel">
        <div className="app-settings-page-heading"><h3>{t(definition.labelKey)}</h3></div>
        {category === "general" ? <GeneralSettingsPage onOpenAppLog={openLog} onOpenExtensionReleases={openExtensionReleases} /> :
          category === "music" ? <MusicSettingsSlot /> :
          <p className="app-settings-help-note" role="status">{locale === "zh-CN" ? "正在加载此页设置…" : "Loading settings…"}</p>}
      </main>
    </div>
  </AppSettingsWindow>;
}
