import type { AppLocale } from "./i18n";
import { translateForLocale } from "./i18n";

export function shouldNotifyImportCompletion(value: { pasteAction?: 'copy' | 'move' | 'noop'; sourceRetainedCount?: number; skippedCount?: number }): boolean {
  return value.pasteAction !== 'noop' && (value.pasteAction !== 'move' || (value.sourceRetainedCount ?? 0) > 0 || (value.skippedCount ?? 0) > 0);
}

export function importSummaryMessage(
  value: {
    pasteAction?: 'copy' | 'move' | 'noop';
    sourceRetainedCount?: number;
    importedCount: number;
    /** Logical asset units: a detected image sequence counts as 1 (WorldlineBox-1y9r). */
    assetCount?: number;
    skippedCount: number;
    replacedCount: number;
  },
  locale: AppLocale,
): string {
  if (value.pasteAction === 'move' && value.skippedCount === 0) return value.sourceRetainedCount ? translateForLocale(locale, 'toast.clipboardSourceRetained', { count: value.sourceRetainedCount }) : '';
  if (value.pasteAction === 'noop') return '';
  const imported = value.assetCount ?? value.importedCount;
  return (
    translateForLocale(locale, "toast.importComplete", {
      imported,
      replaced: value.replacedCount
        ? translateForLocale(locale, "toast.importReplaced", {
            count: value.replacedCount,
          })
        : "",
    }) +
    (value.skippedCount
      ? translateForLocale(locale, "toast.skippedSuffix", {
          count: value.skippedCount,
        })
      : "") +
    translateForLocale(locale, "common.sentenceEnd") +
    (value.sourceRetainedCount ? translateForLocale(locale, 'toast.clipboardSourceRetained', { count: value.sourceRetainedCount }) : '')
  );
}
