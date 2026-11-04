'use strict';
const { setTimeout: pause } = require('node:timers/promises');

// IngestionPipeline owns retries, including its >= 1s vector-repair delay.
// A caller may kick new work once, then only observe its durable receipts.
// Repeated explicit _flushBatch calls would bypass that retry policy.
async function waitForIndex({ kick, ready, timeoutMs, signal, isClosed, message }) {
  const started = Date.now(), deadline = started + timeoutMs;
  let probes = 0, waitMs = 50;
  const check = () => {
    signal?.throwIfAborted();
    if (isClosed?.()) throw Object.assign(new Error('Memory runtime closed while indexing remains pending'), { code: 'MEMORY_CLOSED' });
    if (Date.now() > deadline) throw Object.assign(new Error(message), { code: 'MEMORY_SYNC_TIMEOUT',
      diagnostics: { pending: true, waitMs: Date.now() - started, probes, forcedFlushes: 1, retryOwner: 'upstream-ingestion' } });
  };
  check(); await kick();
  while (true) {
    check(); probes++;
    if (await ready()) return;
    const remaining = deadline - Date.now();
    await pause(Math.max(1, Math.min(waitMs, remaining + 1)), undefined, { signal });
    waitMs = Math.min(1000, waitMs * 2);
  }
}
module.exports = { waitForIndex };
