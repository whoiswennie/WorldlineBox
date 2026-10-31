import { Activity, useEffect, useState, type ReactNode } from "react";

import startupLogo from "../../assets/icons/startup-logo.png";
import { Icon, type IconName } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";
import { isImeKeyboardEvent } from "./ime-safe-dismiss";
import "./application-shell.css";

/** Register complete feature views here, separately from asset workspaces. */
export interface ApplicationModule {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  readonly content: ReactNode;
  /** Keep a module's dialog controller active while its view stays hidden. */
  readonly keepEffectsActive?: boolean;
  /** Fetch only feature code on navigation intent; never mount hidden views. */
  readonly preload?: () => void;
}

export interface ApplicationShellState {
  readonly settingsOpen: boolean;
  readonly settingsDisabled: boolean;
}

export function ApplicationShell({
  modules,
  activeModuleId,
  onSelectModule,
  onOpenSettings,
  settingsOpen = false,
  settingsDisabled = false,
  tools,
}: {
  readonly modules: readonly ApplicationModule[];
  readonly activeModuleId: string;
  readonly onSelectModule: (id: string) => void;
  readonly onOpenSettings: () => void;
  readonly settingsOpen?: boolean;
  readonly settingsDisabled?: boolean;
  readonly tools?: ReactNode;
}) {
  const t = useT();
  const selectedId = modules.some((module) => module.id === activeModuleId)
    ? activeModuleId
    : modules[0]?.id;
  const [activated, setActivated] = useState(() => new Set(selectedId ? [selectedId] : []));
  const newlyActivated = modules.filter(module => (module.id === selectedId || module.keepEffectsActive) && !activated.has(module.id));
  if (newlyActivated.length) setActivated(new Set([...activated, ...newlyActivated.map(module => module.id)]));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsDisabled || event.repeat || isImeKeyboardEvent(event)) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        onOpenSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenSettings, settingsDisabled]);

  return (
    <div className="application-shell">
      <aside aria-label={t("appNavigation.label")} className="application-navigation">
        <div className="application-navigation-brand">
          <img alt="WorldlineBox" draggable={false} src={startupLogo} />
        </div>
        <nav aria-label={t("appNavigation.modules")} className="application-navigation-modules">
          {modules.map((module) => (
            <button
              {...iconActionAttrs(module.label)}
              aria-current={selectedId === module.id ? "page" : undefined}
              className={`application-navigation-item${selectedId === module.id ? " is-active" : ""}`}
              data-application-module={module.id}
              key={module.id}
              onPointerEnter={module.preload}
              onFocus={module.preload}
              onClick={() => { module.preload?.(); onSelectModule(module.id); }}
              type="button"
            >
              <Icon name={module.icon} size={22} />
              <span className="application-navigation-item-label">{module.label}</span>
            </button>
          ))}
        </nav>
        <div className="application-navigation-footer">
          {tools}
          <button
            {...iconActionAttrs(t("toolbar.appSettings"))}
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            className={`application-navigation-item application-navigation-settings${settingsOpen ? " is-active" : ""}`}
            disabled={settingsDisabled}
            onClick={onOpenSettings}
            type="button"
          >
            <Icon name="settings" size={22} />
            <span className="application-navigation-item-label">{t("toolbar.appSettings")}</span>
          </button>
        </div>
      </aside>
      <div className="application-module-host">
        {modules.map((module) => (
          <Activity key={module.id} mode={selectedId === module.id || module.keepEffectsActive ? "visible" : "hidden"}>
            <div className="application-module-view" data-application-view={module.id} hidden={selectedId !== module.id}>
              {activated.has(module.id) ? module.content : null}
            </div>
          </Activity>
        ))}
      </div>
    </div>
  );
}
