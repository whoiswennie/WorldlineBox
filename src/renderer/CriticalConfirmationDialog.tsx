import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import type {
  CriticalConfirmationDecision,
  CriticalConfirmationPrompt,
} from "../shared/critical-confirmation";
import { DialogShell } from "./ui/patterns";

export function CriticalConfirmationDialog({
  request,
  onDecide,
}: {
  request: CriticalConfirmationPrompt | null;
  onDecide: (decision: CriticalConfirmationDecision) => void;
}) {
  if (!request) return null;
  const confirmIsDefault = request.initialFocus === "confirm";
  return (
    <div className="dialog-backdrop" role="presentation">
      <DialogShell
        className="create-dialog"
        description={request.message}
        dialogId="critical-confirmation-dialog"
        headerActions={(
          <button
            className="dialog-close"
            onClick={() => onDecide("cancel")}
            type="button"
            {...iconActionAttrs(request.cancelLabel)}
          >
            <Icon name="close" size={16} />
          </button>
        )}
        onRequestClose={() => onDecide("cancel")}
        style={{ padding: 0 }}
        title={request.heading}
      >
        <p className="dialog-body-copy">{request.detail}</p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            onClick={() => onDecide("cancel")}
            type="button"
            {...(confirmIsDefault ? {} : { "data-dialog-initial-focus": "true" })}
          >
            {request.cancelLabel}
          </button>
          <button
            className="ui-button ui-button--danger"
            onClick={() => onDecide("confirm")}
            type="button"
            {...(confirmIsDefault
              ? {
                  "data-dialog-default-action": "true",
                  "data-dialog-initial-focus": "true",
                }
              : {})}
          >
            {request.confirmLabel}
          </button>
        </div>
      </DialogShell>
    </div>
  );
}
