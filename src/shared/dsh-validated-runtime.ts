/** Releases covered by real native save, writer lease, account and settings probes. */
export const VERIFIED_SHARED_DATA_RUNTIME_VERSIONS = ['0.2.0-rc.2', '0.2.1-alpha.2'] as const;
export function supportsSharedDataRuntime(version: string): boolean {
  return (VERIFIED_SHARED_DATA_RUNTIME_VERSIONS as readonly string[]).includes(version);
}
