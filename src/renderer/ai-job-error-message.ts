import { catalogs } from "./i18n/catalogs";
import { DEFAULT_LOCALE } from "./i18n/locale-preferences";
import { lookupMessage, type AppLocale } from "./i18n/types";

/** Map jobs.error_code / analyze-unsupported reason to localized text. */
export function messageForAiErrorCode(
  code: string,
  locale: AppLocale = DEFAULT_LOCALE,
): string {
  const lookup = (key: string) =>
    lookupMessage(catalogs[locale], key) ??
    (locale !== DEFAULT_LOCALE
      ? lookupMessage(catalogs[DEFAULT_LOCALE], key)
      : undefined);
  // jobs.error_code can hold a public error code (for example when the Worker
  // refuses a thumbnail for an unsupported media type), which has no
  // error.reason.* entry — fall back to the code's own copy instead of showing
  // the bare identifier.
  return lookup(`error.reason.${code}`) ?? lookup(`error.code.${code}`) ?? code;
}

/** User-facing line for an AI job row. Prefer the mapped reason, not the diagnostic dump. */
export function displayAiJobFailure(
  errorCode: string | null | undefined,
  errorDetail: string | null | undefined,
  locale: AppLocale = DEFAULT_LOCALE,
): string {
  if (errorCode) {
    const localized = messageForAiErrorCode(errorCode, locale);
    if (localized !== errorCode) return localized;
  }
  const detail = errorDetail?.trim();
  if (detail) return detail;
  return errorCode ?? "";
}

export function summarizeAiFailureCodes(
  codes: readonly string[],
  locale: AppLocale,
): string {
  if (codes.length === 0) return "";
  return codes.map((code) => messageForAiErrorCode(code, locale)).join("；");
}
