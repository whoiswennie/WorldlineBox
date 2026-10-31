/** A completed domain check proved denial. Storage/transport failures must
 * retain their own errors and must never be converted to this type. */
export class CompanionPermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(message: string) { super(message); this.name = 'CompanionPermissionDeniedError'; }
}
