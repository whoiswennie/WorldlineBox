/** Only launcher-owned diagnostics may cross the task preparation boundary. */
export class DshTaskPreparationError extends Error {
  constructor(readonly code: 'selection' | 'compatibility' | 'integrity' | 'profile' | 'context', message: string) {
    super(message); this.name = 'DshTaskPreparationError';
  }
}
