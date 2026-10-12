import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Runs the navigation benchmark (WorldlineBox-217028) against real libraries.
 *
 *   npm run test:perf:navigation -- <library> [second-library]
 *
 * Paths are passed on the command line so the repository never stores a local
 * path, library name or asset name. The report is written outside the repo
 * (override with WORLDLINEBOX_NAV_BENCH_OUT).
 *
 * Destructive operations stay opt-in: set WORLDLINEBOX_NAV_BENCH_WRITE_LIBRARY to a
 * disposable copy and WORLDLINEBOX_NAV_BENCH_WRITE_CONFIRM=1 to include them.
 */
const library = process.argv[2] ?? process.env.WORLDLINEBOX_NAV_BENCH_LIBRARY;
const secondLibrary = process.argv[3] ?? process.env.WORLDLINEBOX_NAV_BENCH_LIBRARY_B;

if (!library) {
  console.error('Usage: npm run test:perf:navigation -- <library> [second-library]');
  process.exit(2);
}

for (const [label, candidate] of [['library', library], ['second-library', secondLibrary]]) {
  if (!candidate) continue;
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    console.error(`Not an existing directory (${label}): ${resolved}`);
    process.exit(2);
  }
}

const reportPath = process.env.WORLDLINEBOX_NAV_BENCH_OUT
  ?? path.join(tmpdir(), `worldlinebox-nav-bench-${Date.now()}.json`);

const child = spawn(process.execPath, [
  'scripts/run-e2e.mjs',
  'tests/e2e/navigation-perf-benchmark.test.ts',
], {
  env: {
    ...process.env,
    WORLDLINEBOX_NAV_BENCH_LIBRARY: path.resolve(library),
    ...(secondLibrary ? { WORLDLINEBOX_NAV_BENCH_LIBRARY_B: path.resolve(secondLibrary) } : {}),
    WORLDLINEBOX_NAV_BENCH_OUT: reportPath,
  },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error('Failed to run the navigation benchmark.', error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  console.log(`navigation benchmark report: ${reportPath}`);
  process.exitCode = code ?? 1;
});
