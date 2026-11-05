'use strict';
const { setTimeout: pause } = require('node:timers/promises');

// IngestionPipeline owns retries, including its >= 1s vector-repair delay.
// A caller may kick new work once, then only observe its durable receipts.
// Repeated explicit _flushBatch calls would bypass that retry policy.
async function waitForIndex({ kick, ready, timeoutMs = 30000, signal, isClosed, message }) {
  const started = Date.now(), deadline = started + timeoutMs;
  let probes = 0, waitMs = 50;
  const failure = () => Object.assign(new Error(message), { code: 'MEMORY_SYNC_TIMEOUT',
    diagnostics: { pending: true, waitMs: Date.now() - started, probes, forcedFlushes: 1, retryOwner: 'upstream-ingestion' } });
  const expiry = new AbortController(), boundedSignal = signal ? AbortSignal.any([signal, expiry.signal]) : expiry.signal;
  const timer = setTimeout(() => expiry.abort(failure()), Math.max(1, timeoutMs));
  const bounded = operation => new Promise((resolve, reject) => {
    const abort = () => reject(boundedSignal.reason);
    boundedSignal.addEventListener('abort', abort, { once: true });
    if (boundedSignal.aborted) abort();
    Promise.resolve(operation).then(resolve, reject).finally(() => boundedSignal.removeEventListener('abort', abort));
  });
  const check = () => {
    boundedSignal.throwIfAborted();
    if (isClosed?.()) throw Object.assign(new Error('Memory runtime closed while indexing remains pending'), { code: 'MEMORY_CLOSED' });
    if (Date.now() > deadline) throw Object.assign(new Error(message), { code: 'MEMORY_SYNC_TIMEOUT',
      diagnostics: { pending: true, waitMs: Date.now() - started, probes, forcedFlushes: 1, retryOwner: 'upstream-ingestion' } });
  };
  try {
  check(); await bounded(kick());
  while (true) {
    check(); probes++;
    if (await bounded(ready())) return;
    const remaining = deadline - Date.now();
    await pause(Math.max(1, Math.min(waitMs, remaining + 1)), undefined, { signal: boundedSignal });
    waitMs = Math.min(1000, waitMs * 2);
  }
  } catch (error) { if (expiry.signal.aborted) throw expiry.signal.reason; throw error; }
  finally { clearTimeout(timer); }
}
module.exports = { waitForIndex };
