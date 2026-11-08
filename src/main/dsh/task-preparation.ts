/** Only launcher-owned diagnostics may cross the task preparation boundary. */
export interface DshTaskPreparationDiagnostic {
  kind: 'files-changed' | 'manifest' | 'storage' | 'unstable' | 'timeout' | 'verification';
  runtimeId?: string;
  differences?: { added: number; missing: number; changed: number; paths: Array<{ kind: 'added' | 'missing' | 'changed'; path: string }> };
}
export class DshTaskPreparationError extends Error {
  readonly diagnostic?: DshTaskPreparationDiagnostic;
  constructor(readonly code: 'selection' | 'integrity' | 'profile' | 'context', message: string, options?: ErrorOptions & { diagnostic?: DshTaskPreparationDiagnostic }) {
    super(message, options); this.name = 'DshTaskPreparationError'; this.diagnostic = options?.diagnostic;
  }
}
