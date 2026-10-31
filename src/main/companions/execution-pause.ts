/** A controlled lifecycle pause must not be reported as a failed service
 * initialization. It does not authorize replaying any interrupted work. */
export class CompanionExecutionPausedError extends Error {
  constructor(message: string) { super(message); this.name = 'CompanionExecutionPausedError'; }
}
