import { COMPANION_OPTIONAL_DREAM_FAILURES } from '../../shared/companion-world';

const operationalCodes = new Set(['VCP_MEMORY_CLOSED', 'VCP_MEMORY_DERIVED_TIMEOUT', 'VCP_MEMORY_DERIVED_FAILED',
  'VCP_MEMORY_EMBEDDING_RESPONSE_INVALID', 'VCP_MEMORY_PACKAGE_MISSING', 'VCP_MEMORY_ERROR']);

/** Native authority/validation codes, unknown future codes and cancellation
 * never become availability failures. Uncoded Error is accepted only at the
 * narrowly wrapped runtime/get or native invocation boundary. */
export function isOptionalDreamOperationalFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') return false;
  return !('code' in error) || error.code === undefined || typeof error.code === 'string' && operationalCodes.has(error.code);
}

/** Only an operational boundary may create this error after checking that the
 * owner's actual source snapshot is still current. It never carries provider
 * response text, credentials, or a replacement maintenance decision. */
export class CompanionOptionalDreamError extends Error {
  constructor(readonly code: keyof typeof COMPANION_OPTIONAL_DREAM_FAILURES) {
    super(COMPANION_OPTIONAL_DREAM_FAILURES[code].message);
    this.name = 'CompanionOptionalDreamError';
  }
  get diagnostic() {
    return { code: this.code, ...COMPANION_OPTIONAL_DREAM_FAILURES[this.code] };
  }
}
