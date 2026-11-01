import type { CompanionModelConfig, CompanionTransportAttempt } from './model';

export type CompanionReplyPreflightTiming = (operation: string, durationMs: number) => void;

/** Observe one call without changing its return/error or turning a synchronous
 * host failure into an asynchronous one. Diagnostics never control admission. */
export function timeCompanionReplyPreflight<T>(operation: string, run: () => Promise<T> | T, report: CompanionReplyPreflightTiming): Promise<T> {
  const started = performance.now();
  const finish = () => { try { report(operation, performance.now() - started); } catch { /* Observation only. */ } };
  try { return Promise.resolve(run()).finally(finish); }
  catch (error) { finish(); throw error; }
}

/** A per-invocation facade. Keep nonenumerable/symbol configuration fields;
 * callbacks run on their original host objects and return the original context
 * (including its private/nonenumerable frame) without any projection. */
export function observeCompanionReplyPreflight(config: CompanionModelConfig, report: CompanionReplyPreflightTiming): CompanionModelConfig {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(config);
  const replace = (key: keyof CompanionModelConfig, value: unknown) => {
    descriptors[key] = { configurable: true, enumerable: descriptors[key]?.enumerable ?? true, writable: true, value };
  };
  // These ports are not timed, but a per-call facade must still preserve their
  // original receiver (including a host adapter's private instance state).
  if (config.trackOperation) replace('trackOperation', (...args: Parameters<NonNullable<CompanionModelConfig['trackOperation']>>) => config.trackOperation!(...args));
  if (config.resolveStructuredRepairConfig) replace('resolveStructuredRepairConfig', () => config.resolveStructuredRepairConfig!());
  if (config.resolveNativeLifecycle) replace('resolveNativeLifecycle', (...args: Parameters<NonNullable<CompanionModelConfig['resolveNativeLifecycle']>>) => config.resolveNativeLifecycle!(...args));
  if (config.resolveAssetContext) replace('resolveAssetContext', (...args: Parameters<NonNullable<CompanionModelConfig['resolveAssetContext']>>) =>
    timeCompanionReplyPreflight('reply.preflight.resolve_assets', () => config.resolveAssetContext!(...args), report));
  const lifecycle = config.providerLifecycle;
  if (lifecycle) replace('providerLifecycle', { beforeDispatch: () =>
    timeCompanionReplyPreflight('reply.preflight.provider_admission', () => lifecycle.beforeDispatch(), report) });
  const observer = config.transportObserver;
  if (observer) replace('transportObserver', { prepareAttempt: (input: Parameters<typeof observer.prepareAttempt>[0]) =>
    timeCompanionReplyPreflight('reply.preflight.prepare_attempt', () => observer.prepareAttempt(input), report).then(attempt => {
      // Forward to the actual attempt, preserving private receiver state and
      // the single durable dispatched/complete promises owned by that attempt.
      const fields = Object.getOwnPropertyDescriptors(attempt);
      const methods: CompanionTransportAttempt = {
        beforeDispatch: () => timeCompanionReplyPreflight('reply.preflight.attempt_before_dispatch', () => attempt.beforeDispatch(), report),
        dispatched: () => attempt.dispatched(), complete: (...args) => attempt.complete(...args),
      };
      for (const [key, value] of Object.entries(methods)) fields[key] = { configurable: true, enumerable: fields[key]?.enumerable ?? true, writable: true, value };
      return Object.create(Object.getPrototypeOf(attempt), fields) as CompanionTransportAttempt;
    }) });
  return Object.create(Object.getPrototypeOf(config), descriptors) as CompanionModelConfig;
}
