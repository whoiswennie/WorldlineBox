/** Closing/cancellation is temporary loss of a validation service, never
 * evidence that the user's stored source or permission was withdrawn. */
export class CompanionValidationUnavailableError extends Error {
  readonly code = 'EXECUTION_VALIDATION_UNAVAILABLE';
}

export function companionValidationUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 12 && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as { name?: unknown; code?: unknown; reason?: unknown; cause?: unknown };
    if (value.name === 'AbortError' || ['EXECUTION_VALIDATION_UNAVAILABLE', 'ABORT_ERR', 'CANCELLED',
      'MEMORY_FILES_PENDING', 'MEMORY_INDEX_PENDING', 'NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'SQLITE_BUSY', 'SQLITE_LOCKED',
      'EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM'].includes(String(value.code)) || value.reason === 'files_pending') return true;
    current = value.cause;
  }
  return false;
}

/** Boolean validity ports may reject genuine integrity/authority failures.
 * They must propagate lifecycle and unavailable-I/O failures to their caller. */
export function rethrowCompanionValidationUnavailable(error: unknown): void {
  if (companionValidationUnavailable(error)) throw error;
}

/** Only trusted host infrastructure refusals are deferrable after a paid
 * proposal. Provider NETWORK/429/TIMEOUT errors do not carry this authority. */
export function companionHostValidationUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>(); let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 12 && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === 'EXECUTION_VALIDATION_UNAVAILABLE') return true;
    current = value.cause;
  }
  return false;
}
