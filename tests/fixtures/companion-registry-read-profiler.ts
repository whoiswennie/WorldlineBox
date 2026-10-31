import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

interface Storage { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }
interface Row { phase: string; mode: 'id' | 'path' | 'batch'; functions: string[]; calls: number; metadataItems: number; totalMs: number; maxMs: number }

/** Optional diagnostic only. Aggregate actual registry IPC callers without
 * collecting arguments, IDs, paths, source text or model/provider bodies. */
export function installCompanionRegistryReadProfiler(storage: Storage, options: { phase(): string; enabled?: boolean }) {
  const rows = new Map<string, Row>(), original = storage.request;
  const enabled = options.enabled ?? process.env.WORLDLINEBOX_RESPOND_REGISTRY_PROFILE === '1';
  async function profiled(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    if (command.type !== 'cognition.registry.read') return original.call(storage, command);
    const priorLimit = Error.stackTraceLimit, error = new Error();
    try { Error.stackTraceLimit = 24; Error.captureStackTrace(error, profiled); }
    finally { Error.stackTraceLimit = priorLimit; }
    const functions = (error.stack?.split('\n').slice(1) ?? []).map(line => {
      const frame = /^\s*at\s+(?:async\s+)?([^\s(]+)(?:\s+\(|$)/u.exec(line)?.[1];
      // Location-only frames are deliberately discarded instead of recording
      // a local filesystem path or anonymous source position.
      return frame && !frame.includes(':') && !frame.includes('/') && !frame.includes('\\') ? frame : '<anonymous>';
    }).slice(0, 20);
    const phase = options.phase(), mode = command.artifactIds ? 'batch' : command.relativePath ? 'path' : 'id';
    const key = JSON.stringify([phase, mode, functions]);
    const row = rows.get(key) ?? { phase, mode, functions, calls: 0, metadataItems: 0, totalMs: 0, maxMs: 0 };
    row.calls++; row.metadataItems += command.artifactIds?.length ?? 1; rows.set(key, row);
    const started = performance.now();
    try { return await original.call(storage, command); }
    finally { const elapsed = performance.now() - started; row.totalMs += elapsed; row.maxMs = Math.max(row.maxMs, elapsed); }
  }
  if (enabled) storage.request = profiled;
  return {
    snapshot(): Row[] { return [...rows.values()].map(row => ({ ...row, functions: [...row.functions] })).sort((a, b) => b.calls - a.calls); },
    restore(): void { if (storage.request === profiled) storage.request = original; },
  };
}
