import { useState } from "react";
import { Icon } from "./Icons";
import { iconActionAttrs } from "./icon-action-attrs";
import { useT } from "./i18n";
import type { LinkedFolderRule } from "../shared/asset-types";
import { DialogShell } from "./ui/patterns";
import { Select } from "./ui/primitives";

export interface LinkedRulesDialogProps {
  name: string;
  initialRules: LinkedFolderRule[];
  onClose: () => void;
  onSave: (rules: LinkedFolderRule[]) => void;
}

export function LinkedRulesDialog({
  name,
  initialRules,
  onClose,
  onSave,
}: LinkedRulesDialogProps) {
  const t = useT();
  const [rules, setRules] = useState<LinkedFolderRule[]>(initialRules);

  return (
    <div className="dialog-backdrop" role="presentation">
      <DialogShell
        className="create-dialog create-dialog-wider"
        dialogId="linked-rules-dialog"
        headerActions={
          <button
            className="dialog-close"
            onClick={onClose}
            type="button"
            {...iconActionAttrs(t("common.cancel"))}
          >
            <Icon name="close" size={16} />
          </button>
        }
        style={{ padding: 0 }}
        title={t("dialog.linkedRules.title", { name })}
        description={<span className="field-help">{t("dialog.linkedRules.help")}</span>}
      >
        {rules.map((rule, index) => (
          <div
            key={rule.ruleId}
            style={{
              display: "grid",
              gridTemplateColumns: "22px 82px 82px 1fr 28px",
              gap: 6,
              marginTop: 6,
            }}
          >
            <input
              aria-label={t("dialog.linkedRules.enableRule", {
                index: index + 1,
              })}
              checked={rule.enabled}
              onChange={(event) =>
                setRules((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, enabled: event.target.checked }
                      : item,
                  ),
                )
              }
              type="checkbox"
            />
            <Select
              className="text-field"
              onValueChange={(value) =>
                setRules((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, action: value as LinkedFolderRule["action"] }
                      : item,
                  ),
                )
              }
              options={[
                { value: "exclude", label: t("dialog.linkedRules.exclude") },
                { value: "include", label: t("dialog.linkedRules.include") },
              ]}
              value={rule.action}
            />
            <Select
              className="text-field"
              onValueChange={(value) =>
                setRules((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, target: value as LinkedFolderRule["target"] }
                      : item,
                  ),
                )
              }
              options={[
                { value: "folder", label: t("dialog.linkedRules.folder") },
                { value: "filename", label: t("dialog.linkedRules.filename") },
                { value: "extension", label: t("dialog.linkedRules.extension") },
                { value: "path", label: t("dialog.linkedRules.path") },
              ]}
              value={rule.target}
            />
            <input
              className="text-field"
              maxLength={512}
              onChange={(event) =>
                setRules((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, pattern: event.target.value }
                      : item,
                  ),
                )
              }
              value={rule.pattern}
            />
            <button
              className="dialog-close"
              onClick={() =>
                setRules((current) =>
                  current.filter((_, i) => i !== index),
                )
              }
              type="button"
              {...iconActionAttrs(
                t("dialog.linkedRules.deleteRule", {
                  index: index + 1,
                }),
              )}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
        <div className="dialog-actions">
          <button
            className="secondary-button"
            onClick={() =>
              setRules((current) => [
                ...current,
                {
                  ruleId: crypto.randomUUID(),
                  action: "exclude",
                  target: "extension",
                  pattern: "tmp",
                  enabled: true,
                },
              ])
            }
            type="button"
          >
            {t("dialog.linkedRules.add")}
          </button>
          <button
            className="secondary-button"
            onClick={onClose}
            type="button"
          >
            {t("common.cancel")}
          </button>
          <button
            className="primary-button"
            disabled={rules.some((rule) => !rule.pattern.trim())}
            onClick={() => onSave(rules)}
            type="button"
          >
            {t("dialog.linkedRules.save")}
          </button>
        </div>
      </DialogShell>
    </div>
  );
}
