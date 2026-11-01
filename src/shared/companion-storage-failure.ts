import { z } from 'zod';

/** Private Worker transport classification. It is never a domain result or
 * authority supplied by a renderer, model, source body or error message. */
export const companionStorageFailureSchema = z.strictObject({ kind: z.literal('unavailable') });
type CompanionStorageFailure = z.infer<typeof companionStorageFailureSchema>;

function unavailable(error: unknown): boolean {
  const seen = new Set<unknown>(); let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 12 && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === 'EXECUTION_VALIDATION_UNAVAILABLE'
      || typeof value.code === 'string' && /^SQLITE_(?:BUSY|LOCKED|IOERR)(?:_|$)/u.test(value.code)) return true;
    current = value.cause;
  }
  return false;
}

/** Preserve an existing optional/missing-object projection, while refusing to
 * turn a coded infrastructure failure into proof that the object is absent. */
export function rethrowCompanionStorageUnavailable(error: unknown): void {
  if (unavailable(error)) throw error;
}

/** Ordinary not-found, authorization and integrity denials retain their exact
 * ok:false result. Only coded host availability failures reject in Main. */
export function companionStorageBusinessFailure(error: unknown): {
  response: { ok: false; error: string }; storageFailure?: CompanionStorageFailure;
} {
  return { response: { ok: false, error: error instanceof Error ? error.message : '伙伴记录操作失败。' },
    ...(unavailable(error) ? { storageFailure: { kind: 'unavailable' as const } } : {}) };
}
