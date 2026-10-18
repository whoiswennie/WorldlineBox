import { randomUUID } from 'node:crypto';
import type { ApplicationNetworkFailure } from '../shared/application-network';

/** Session-only request diagnostics. URL paths, queries and credentials are never stored. */
export class ApplicationNetworkDiagnostics {
  private failures: ApplicationNetworkFailure[] = [];
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly report: (failure: ApplicationNetworkFailure) => void = () => undefined) {}
  state(): ApplicationNetworkFailure[] { return structuredClone(this.failures); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  record(input: { url: string; error: string; resourceType: string; module?: ApplicationNetworkFailure['module'] }): void {
    if (input.error === 'net::ERR_ABORTED' || input.error === 'ERR_ABORTED') return;
    let origin: string;
    try { const url = new URL(input.url); if (!['http:', 'https:'].includes(url.protocol)) return; origin = url.origin; }
    catch { return; }
    if (origin.length > 2048) return;
    const error = input.error.slice(0, 200);
    const resourceType = input.resourceType.slice(0, 100);
    const previous = this.failures.find(row => row.origin === origin && row.error === error
      && row.resourceType === resourceType && row.module === input.module);
    const failure: ApplicationNetworkFailure = { id: previous?.id ?? randomUUID(), origin,
      error, resourceType, module: input.module,
      occurredAt: new Date().toISOString(), count: (previous?.count ?? 0) + 1 };
    this.failures = [failure, ...this.failures.filter(row => row !== previous)].slice(0, 40);
    if (!previous) this.report({ ...failure });
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; for (const listener of this.listeners) listener(); }, 250); this.timer.unref(); }
  }
  clear(): void { clearTimeout(this.timer); this.timer = undefined; this.failures = []; for (const listener of this.listeners) listener(); }
}
