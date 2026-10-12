import type { ImportProgressEvent } from "../shared/protocol/responses";
import {
  isLibraryOpenTransferKind,
  libraryTransferHeadlineKey,
  type LibraryTransferKind,
} from "./library-transfer-progress";

export {
  isActiveImportProgress,
  isBlockingImportOverlayVisible,
  isTerminalImportProgressPhase,
  shouldApplyImportProgressEvent,
} from "./import-progress-session";
export type {
  ImportOverlaySession,
  ImportProgressApplySession,
} from "./import-progress-session";

export function isImportAwaitingUserDecision(input: {
  hasConflicts: boolean;
  hasSequenceOffer: boolean;
}): boolean {
  return input.hasConflicts || input.hasSequenceOffer;
}

export type ImportOverlayTitle = ReturnType<typeof libraryTransferHeadlineKey> | {
  key: "progress.importingAssets";
  name?: false;
};

export function importOverlayTitle(
  transferKind: LibraryTransferKind,
): ImportOverlayTitle {
  if (isLibraryOpenTransferKind(transferKind)) {
    return libraryTransferHeadlineKey(transferKind);
  }
  return { key: "progress.importingAssets" };
}

export type ImportOverlayDetail = {
  key:
    | "progress.readingSourceItems"
    | "progress.validating"
    | "progress.copyingFiles"
    | "progress.copying"
    | "progress.processingFiles"
    | "progress.processing"
    | "progress.extractingFiles"
    | "progress.extracting"
    | "progress.verifyingFiles"
    | "progress.verifying"
    | "progress.opening"
    | "progress.importingStarted";
  params?: Record<string, string | number>;
};

export function importOverlayDetail(
  progress: ImportProgressEvent | null,
  formatBytes: (bytes: number) => string,
): ImportOverlayDetail {
  if (!progress) return { key: "progress.importingStarted" };
  switch (progress.phase) {
    case "validate":
      return progress.totalFiles > 0
        ? {
            key: "progress.readingSourceItems",
            params: {
              processed: progress.filesProcessed,
              total: progress.totalFiles,
            },
          }
        : { key: "progress.validating" };
    case "copy": {
      const processing = progress.copiesFiles === false;
      return progress.totalFiles > 0
        ? {
            key: processing ? "progress.processingFiles" : "progress.copyingFiles",
            params: {
              processed: progress.filesProcessed,
              total: progress.totalFiles,
              bytesProcessed: formatBytes(progress.bytesProcessed),
              bytesTotal: formatBytes(progress.totalBytes),
            },
          }
        : { key: processing ? "progress.processing" : "progress.copying" };
    }
    case "extract":
      return progress.totalFiles > 0
        ? {
            key: "progress.extractingFiles",
            params: {
              processed: progress.filesProcessed,
              total: progress.totalFiles,
            },
          }
        : { key: "progress.extracting" };
    case "verify":
      return progress.totalFiles > 0
        ? {
            key: "progress.verifyingFiles",
            params: {
              processed: progress.filesProcessed,
              total: progress.totalFiles,
            },
          }
        : { key: "progress.verifying" };
    case "open":
      return { key: "progress.opening" };
    default:
      return { key: "progress.importingStarted" };
  }
}
