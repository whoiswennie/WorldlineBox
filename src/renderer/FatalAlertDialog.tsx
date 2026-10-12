import React from "react";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";

export interface FatalAlertDialogProps {
  /** Body text; dialog is closed when null/empty. */
  message: string | null;
  /** Optional title override (WorldlineBox-4sw0: AI uses plain wording). */
  title?: string | null;
  onDismiss: () => void;
  /** Keeps a failed library open recoverable without requiring a relaunch. */
  onSwitchLibrary?: () => void;
  /** Secondary dismiss that does not switch libraries (already-open prompt). */
  onCancel?: () => void;
  /** Primary action when it is not the same as dismiss (already-open switch). */
  onConfirm?: () => void;
  confirmLabel?: string | null;
  cancelLabel?: string | null;
}

/**
 * Blocking error alert (WorldlineBox-99lv). Not a toast — user must acknowledge
 * before continuing. Title names the operation (import, open library, etc.).
 */
export function FatalAlertDialog({
  message,
  title,
  onDismiss,
  onSwitchLibrary,
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel,
}: FatalAlertDialogProps) {
  const t = useT();
  if (!message) return null;

  const heading =
    title?.trim() || t("dialog.blockingError.fallback");
  const primaryLabel = confirmLabel?.trim() || t("dialog.blockingError.confirm");
  const cancelActionLabel = cancelLabel?.trim() || t("common.cancel");
  const secondary = onCancel
    ? {
        label: cancelActionLabel,
        onClick: onCancel,
      }
    : onSwitchLibrary
      ? {
          label: t("dialog.blockingError.switchLibrary"),
          onClick: onSwitchLibrary,
        }
      : null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-describedby="fatal-alert-body"
        aria-labelledby="fatal-alert-title"
        aria-modal="true"
        className="create-dialog"
        role="alertdialog"
      >
        <div className="dialog-heading">
          <div>
            <h2 id="fatal-alert-title">{heading}</h2>
          </div>
          <button
            className="dialog-close"
            onClick={onCancel ?? onDismiss}
            type="button"
            {...iconActionAttrs(secondary ? cancelActionLabel : primaryLabel)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="dialog-body-copy" id="fatal-alert-body">
          {message}
        </p>
        <div className="dialog-actions">
          {secondary ? (
            <button className="secondary-button" onClick={secondary.onClick} type="button">
              {secondary.label}
            </button>
          ) : null}
          <button className="primary-button" onClick={onConfirm ?? onDismiss} type="button">
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
