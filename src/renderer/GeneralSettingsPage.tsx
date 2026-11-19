import { useState, type ReactNode } from "react";
import { APP_SETTINGS_LOCALE_OPTIONS } from "./app-settings-sections";
import { useLocale } from "./i18n";
import { loadTaskCompletionSoundPreferences, saveTaskCompletionSoundPreferences } from "./task-completion-sound-preferences";
import { loadFeatureHintPreferences, saveFeatureHintPreferences } from "./feature-hint-preferences";
import { useStartupPreferences } from "./use-startup-preferences";
import { SettingsCard } from "./ui/patterns";
import { Switch } from "./ui/primitives";

type SettingsToggleRowProps = {
  checked: boolean;
  disabled?: boolean;
  hint: string;
  label: string;
  onChange: () => void;
};

export function SettingsToggleRow({
  checked,
  disabled = false,
  hint,
  label,
  onChange,
}: SettingsToggleRowProps): ReactNode {
  return (
    <label className="app-settings-toggle-row">
      <span className="app-settings-row-copy">
        <strong>{label}</strong>
        <span>{hint}</span>
      </span>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </label>
  );
}

export function GeneralSettingsPage({
  onOpenAppLog,
  onOpenExtensionReleases,
}: {
  onOpenAppLog?: () => void;
  onOpenExtensionReleases?: () => void;
} = {}): ReactNode {
  const { t, preference: localePreference, setLocale } = useLocale();
  const [taskCompletionSoundEnabled, setTaskCompletionSoundEnabled] = useState(
    () => loadTaskCompletionSoundPreferences().enabled,
  );
  const [featureHintsEnabled, setFeatureHintsEnabled] = useState(
    () => loadFeatureHintPreferences().enabled,
  );

  function toggleTaskCompletionSound(): void {
    const enabled = !taskCompletionSoundEnabled;
    saveTaskCompletionSoundPreferences({ version: 1, enabled });
    setTaskCompletionSoundEnabled(enabled);
  }

  function toggleFeatureHints(): void {
    const enabled = !featureHintsEnabled;
    const current = loadFeatureHintPreferences();
    saveFeatureHintPreferences({ version: 2, enabled, seen: current.seen });
    setFeatureHintsEnabled(enabled);
  }

  const startup = useStartupPreferences();

  return (
    <>
      {startup.available ? (
        <SettingsCard>
          {startup.snapshot.supported ? (
            <>
              <SettingsToggleRow
                checked={startup.snapshot.openAtLogin}
                hint={t("settings.openAtLoginHint")}
                label={t("settings.openAtLogin")}
                onChange={() => {
                  startup.setOpenAtLogin(!startup.snapshot.openAtLogin);
                }}
              />
              {startup.snapshot.approvalRequired ? (
                <p className="app-settings-help-note">{t("settings.openAtLoginApproval")}</p>
              ) : null}
              {startup.snapshot.registrationFailed ? (
                <p className="app-settings-help-note" role="status">
                  {t("settings.openAtLoginFailed")}
                </p>
              ) : null}
            </>
          ) : (
            <div className="app-settings-row-copy">
              <strong>{t("settings.openAtLogin")}</strong>
              <span>{t("settings.openAtLoginUnsupported")}</span>
            </div>
          )}
        </SettingsCard>
      ) : null}
      <SettingsCard>
        <div className="app-settings-row app-settings-row-stack">
          <div className="app-settings-row-copy">
            <strong>{t("shell.language")}</strong>
            <span>{t("settings.languageHint")}</span>
          </div>
          <div
            aria-label={t("shell.language")}
            className="app-settings-option-group"
            role="radiogroup"
          >
            {APP_SETTINGS_LOCALE_OPTIONS.map((option) => (
              <button
                aria-checked={localePreference === option.value}
                className="app-settings-option"
                key={option.value}
                onClick={() => setLocale(option.value)}
                role="radio"
                type="button"
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </SettingsCard>
      <SettingsCard>
        <SettingsToggleRow
          checked={taskCompletionSoundEnabled}
          hint={t("settings.taskCompletionSoundHint")}
          label={t("settings.taskCompletionSound")}
          onChange={toggleTaskCompletionSound}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsToggleRow
          checked={featureHintsEnabled}
          hint={t("settings.featureHintsHint")}
          label={t("settings.featureHints")}
          onChange={toggleFeatureHints}
        />
      </SettingsCard>
      {onOpenAppLog ? (
        <SettingsCard>
          <div className="app-settings-action-row">
            <div className="app-settings-row-copy">
              <strong>{t("settings.diagnosticsTitle")}</strong>
              <span>{t("settings.diagnosticsHint")}</span>
            </div>
            <button className="secondary-button" onClick={onOpenAppLog} type="button">
              {t("settings.viewDiagnostics")}
            </button>
          </div>
        </SettingsCard>
      ) : null}
      <SettingsCard>
        <div className="app-settings-row app-settings-row-stack">
          <div className="app-settings-row-copy">
            <strong>{t("settings.browserExtensionTitle")}</strong>
            <span>{t("settings.browserExtensionIntro")}</span>
          </div>
          {onOpenExtensionReleases ? (
            <button
              className="secondary-button app-settings-download-button"
              onClick={onOpenExtensionReleases}
              type="button"
            >
              {t("settings.browserExtensionDownload")}
            </button>
          ) : null}
          <ol className="app-settings-help-list">
            <li>{t("settings.browserExtensionStepDownload")}</li>
            <li>{t("settings.browserExtensionStepExtract")}</li>
            <li>{t("settings.browserExtensionStepLoad")}</li>
            <li>{t("settings.browserExtensionFirefoxStepInstall")}</li>
          </ol>
          <p className="app-settings-help-note">
            {t("settings.browserExtensionNote")}
          </p>
        </div>
      </SettingsCard>
    </>
  );
}
