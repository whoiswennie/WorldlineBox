export type DshHostUnavailableReason = 'configuration' | 'stopped' | 'startup' | 'closing';

/** No native admission was attempted by the operation that raised this error.
 * This describes Host availability, never the outcome of earlier native work. */
export class DshHostUnavailableError extends Error {
  readonly code = 'DSH_HOST_UNAVAILABLE';
  constructor(readonly reason: DshHostUnavailableReason, message: string, readonly instanceId?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function isDshHostUnavailableError(value: unknown): value is DshHostUnavailableError {
  return value instanceof DshHostUnavailableError;
}
