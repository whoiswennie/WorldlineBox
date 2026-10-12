import type { ReactNode } from "react";

import type { ImportProgressEvent } from "../shared/protocol/responses";
import { BlockingProgressOverlay } from "./BlockingProgressOverlay";
import { formatBytes } from "./format-file-meta";
import { useT } from "./i18n";
import {
  importOverlayDetail,
  importOverlayTitle,
} from "./import-progress-copy";
import {
  isLibraryOpenTransferKind,
  type LibraryTransferKind,
} from "./library-transfer-progress";

export type ImportProgressOverlayProps = {
  readonly transferKind: LibraryTransferKind;
  readonly transferName: string;
  readonly progress: ImportProgressEvent | null;
  readonly onCancel: () => void;
  readonly onStop?: () => void;
  readonly onDismiss?: () => void;
  readonly actionsDisabled?: boolean;
};

export function ImportProgressOverlay({
  transferKind,
  transferName,
  progress,
  onCancel,
  onStop,
  onDismiss,
  actionsDisabled = false,
}: ImportProgressOverlayProps): ReactNode {
  const t = useT();
  const titleSpec = importOverlayTitle(transferKind);
  const title = titleSpec.name
    ? t(titleSpec.key, { name: transferName })
    : t(titleSpec.key);
  const detail = importOverlayDetail(progress, formatBytes);
  const detailText = detail.params ? t(detail.key, detail.params) : t(detail.key);
  const determinate = (progress?.totalFiles ?? 0) > 0;
  const cancelable = Boolean(progress?.importId) && progress?.cancelable !== false;
  const libraryOpen = isLibraryOpenTransferKind(transferKind);
  const cancelLabel = libraryOpen
    ? t("progress.cancelOpen")
    : t("progress.cancelImport");
  const stopLabel = libraryOpen ? undefined : t("progress.stopImport");
  const dismissable = !cancelable && !libraryOpen && Boolean(onDismiss);

  return (
    <BlockingProgressOverlay
      actionsDisabled={actionsDisabled}
      cancelLabel={cancelable ? cancelLabel : dismissable ? t("progress.hideImport") : undefined}
      cancelTip={
        cancelable && !libraryOpen
          ? t("progress.cancelImportHint")
          : dismissable
            ? t("progress.hideImportHint")
            : undefined
      }
      detail={detailText}
      indeterminate={!determinate}
      kind="import"
      max={determinate ? progress?.totalFiles : undefined}
      onCancel={cancelable ? onCancel : dismissable ? onDismiss : undefined}
      onStop={cancelable && !libraryOpen ? onStop : undefined}
      stopLabel={cancelable && !libraryOpen ? stopLabel : undefined}
      stopTip={
        cancelable && !libraryOpen ? t("progress.stopImportHint") : undefined
      }
      title={title}
      value={determinate ? progress?.filesProcessed : undefined}
    />
  );
}
