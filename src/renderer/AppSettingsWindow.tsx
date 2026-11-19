import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";
import { DialogShell } from "./ui/patterns/dialog";

export function AppSettingsWindow({ children, onClose, appearanceAdjusting = false, backdropProps }: {
  children: ReactNode;
  onClose(): void;
  appearanceAdjusting?: boolean;
  backdropProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const t = useT();
  return <div
    className={`dialog-backdrop app-settings-backdrop${appearanceAdjusting ? " is-adjusting" : ""}`}
    role="presentation"
    {...backdropProps}
  >
    <DialogShell className="create-dialog app-settings-dialog" contentClassName="ui-dialog-shell__content--flush"
      dialogId="app-settings-dialog" onRequestClose={onClose} title={t("settings.title")}
      headerActions={<button className="dialog-close" onClick={onClose} type="button" {...iconActionAttrs(t("common.close"))}>
        <Icon name="close" size={16} />
      </button>}>
      {children}
    </DialogShell>
  </div>;
}
