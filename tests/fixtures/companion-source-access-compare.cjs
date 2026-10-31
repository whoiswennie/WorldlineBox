/** Two actual Stores, same readonly-source backup, alternating warm CPU samples. */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Electron Node controller. */
/* global require, process, console */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const root = process.env.WORLDLINEBOX_SOURCE_QUEUE_ROOT;
if (!path.isAbsolute(root) || !path.basename(root).startsWith('wlb-source-queue-')) throw new Error('Owned comparison root missing.');
process.env.WORLDLINEBOX_SOURCE_ACCESS_CONTROLLED = '1';
const stores = {};
for (const variant of ['baseline', 'indexed']) {
  process.env.WORLDLINEBOX_SOURCE_QUEUE_VARIANT = variant;
  stores[variant] = require(path.join(root, 'access-' + variant + '-build', 'profile.cjs'));
}
const results = [], performanceSamples = { baseline: [], indexed: [] };
const baseline = stores.baseline, indexed = stores.indexed;
function compareCases(suffix = '') {
  for (let index = 0; index < baseline.controlledCaseCounts.length; index++) {
    const a = baseline.controlledResolve(index), b = indexed.controlledResolve(index);
    const oldHash = baseline.controlledHash(a), newHash = indexed.controlledHash(b);
    results.push({ case: baseline.controlledCaseCounts[index].name + suffix, proofs: a.length, equivalent: oldHash === newHash,
      baselineProofHash: oldHash, indexedProofHash: newHash });
    if (oldHash !== newHash) throw new Error('Actual complete proof/root associations diverged.');
  }
}
try {
  compareCases();
  for (let index = 0; index < 3; index++) { baseline.controlledResolve(0); indexed.controlledResolve(0); }
  for (let iteration = 0; iteration < 10; iteration++) {
    for (const variant of iteration % 2 ? ['indexed', 'baseline'] : ['baseline', 'indexed']) {
      const cpu = process.cpuUsage(), started = performance.now();
      stores[variant].controlledResolve(0);
      const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
      performanceSamples[variant].push({ iteration, elapsedMs, cpuMs: (used.user + used.system) / 1000 });
    }
  }
  const reference = baseline.controlledResolve(0).find(proof => proof.kind === 'message' && proof.executionReadset && !proof.invalidated && proof.companionId !== 'user');
  if (!reference) throw new Error('No actual derived source to withdraw.');
  baseline.controlledWithdraw(reference); indexed.controlledWithdraw(reference); compareCases('-after-real-withdrawal');
  const result = { actualStores: true, modelCalls: 0, isMainOrProviderLatency: false, alternatingOrder: true,
    equivalent: results.every(value => value.equivalent), cases: results, performanceSamples };
  fs.writeFileSync(path.join(root, 'source-access-result.json'), JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally { baseline.controlledClose(); indexed.controlledClose(); }
