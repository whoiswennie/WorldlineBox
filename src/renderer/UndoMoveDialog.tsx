import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";
import { DialogShell } from "./ui/patterns";
import { Select } from "./ui/primitives";

export interface UndoMoveDialogProps {
  open: boolean;
  conflictStrategy: "keep-both" | "replace" | "skip";
  onConflictStrategyChange: (
    strategy: "keep-both" | "replace" | "skip",
  ) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UndoMoveDialog({
  open,
  conflictStrategy,
  onConflictStrategyChange,
  onConfirm,
  onCancel,
}: UndoMoveDialogProps) {
  const t = useT();
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <DialogShell
        className="create-dialog"
        dialogId="undo-move-dialog"
        headerActions={
          <button
            className="dialog-close"
            onClick={onCancel}
            type="button"
            {...iconActionAttrs(t("dialog.undoMove.cancelAria"))}
          >
            <Icon name="close" size={16} />
          </button>
        }
        onRequestClose={onCancel}
        title={t("dialog.undoMove.title")}
      >
        <p className="field-help">{t("dialog.undoMove.help")}</p>
        <label className="field-label" htmlFor="undo-move-conflict">
          {t("dialog.undoMove.conflictLabel")}
        </label>
        <Select
          className="text-field"
          id="undo-move-conflict"
          onValueChange={(value) =>
            onConflictStrategyChange(value as "keep-both" | "replace" | "skip")
          }
          options={[
            { value: "keep-both", label: t("dialog.undoMove.keepBoth") },
            { value: "replace", label: t("dialog.undoMove.replace") },
            { value: "skip", label: t("dialog.undoMove.skip") },
          ]}
          value={conflictStrategy}
        />
        <div className="dialog-actions">
          <button
            className="secondary-button"
            onClick={onCancel}
            type="button"
          >
            {t("common.cancel")}
          </button>
          <button
            className="primary-button"
            onClick={onConfirm}
            type="button"
          >
            {t("dialog.undoMove.submit")}
          </button>
        </div>
      </DialogShell>
    </div>
  );
}
