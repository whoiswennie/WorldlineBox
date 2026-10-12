export type ImageSequenceConfirmPurpose = "import" | "create";

export function shouldShowApplyToRest(
  sequenceIndex: number,
  sequenceCount: number,
): boolean {
  return sequenceCount > 1 && sequenceIndex >= 0 && sequenceIndex < sequenceCount - 1;
}

/**
 * Manual create reuses the import confirm form. Copy keys stay create-specific
 * so the panel is not titled as an import of files already in the library.
 */
export function imageSequenceConfirmTitleKey(
  purpose: ImageSequenceConfirmPurpose,
  grouping: boolean,
):
  | "dialog.imageSequence.title"
  | "dialog.imageSequenceImport.title"
  | "dialog.imageSequenceImport.groupTitle" {
  if (purpose === "create") return "dialog.imageSequence.title";
  return grouping
    ? "dialog.imageSequenceImport.groupTitle"
    : "dialog.imageSequenceImport.title";
}

export function imageSequenceConfirmSummaryKey(
  purpose: ImageSequenceConfirmPurpose,
  grouping: boolean,
):
  | "dialog.imageSequence.detail"
  | "dialog.imageSequenceImport.summary"
  | "dialog.imageSequenceImport.groupSummary" {
  if (purpose === "create") return "dialog.imageSequence.detail";
  return grouping
    ? "dialog.imageSequenceImport.groupSummary"
    : "dialog.imageSequenceImport.summary";
}

export function imageSequenceConfirmPrimaryKey(
  purpose: ImageSequenceConfirmPurpose,
  grouping: boolean,
  submitting: boolean,
):
  | "dialog.imageSequence.create"
  | "dialog.imageSequence.creating"
  | "dialog.imageSequenceImport.importSequence"
  | "dialog.imageSequenceImport.importing"
  | "dialog.imageSequenceImport.makeSequence"
  | "dialog.imageSequenceImport.grouping" {
  if (purpose === "create") {
    return submitting
      ? "dialog.imageSequence.creating"
      : "dialog.imageSequence.create";
  }
  if (submitting) {
    return grouping
      ? "dialog.imageSequenceImport.grouping"
      : "dialog.imageSequenceImport.importing";
  }
  return grouping
    ? "dialog.imageSequenceImport.makeSequence"
    : "dialog.imageSequenceImport.importSequence";
}
