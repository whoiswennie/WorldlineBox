/* eslint-disable @typescript-eslint/no-require-imports -- Node --require profiling preload must use CommonJS. */
/* global require, process */
'use strict';

// Explicit profiling preload only: wrap the real worker without changing vendor
// bytes, arguments, ranking or results. Never send text, paths or credentials.
const { performance } = require('node:perf_hooks');
const { VcpMemoryRuntime } = require('../../src/main/vcp-memory/runtime.cjs');
function observe(target, name, label = name) {
  const original = target[name];
  if (typeof original !== 'function') return;
  target[name] = async function (...args) {
    const started = performance.now();
    let result;
    try { result = await original.apply(this, args); return result; }
    finally { process.send?.({ type: 'latency-observation', operation: label, elapsedMs: performance.now() - started,
      ...(Array.isArray(result?.results) ? { count: result.results.length } : {}) }); }
  };
}
const initialize = VcpMemoryRuntime.prototype.initialize;
VcpMemoryRuntime.prototype.initialize = async function (...args) {
  const started = performance.now();
  try {
    const result = await initialize.apply(this, args);
    observe(this.kb, 'executeNativeRiverQuery', 'river_query_without_embedding');
    observe(this.kb, 'executeLightMemoQuery', 'light_query_without_embedding');
    const load = this.peripherals.load;
    this.peripherals.load = async function (name) {
      const started = performance.now();
      try { return await load.call(this, name); }
      finally { process.send?.({ type: 'latency-observation', operation: `load_${name}`, elapsedMs: performance.now() - started }); }
    };
    return result;
  } finally { process.send?.({ type: 'latency-observation', operation: 'initialize', elapsedMs: performance.now() - started }); }
};
for (const name of ['replace', 'remember', 'ensureArtifacts', 'queryEmbedding', 'search']) observe(VcpMemoryRuntime.prototype, name);
