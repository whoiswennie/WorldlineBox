import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Runs the operator-only palette benchmark against a directory of real images.
 * The directory is passed on the command line so the repository never stores a
 * local path:
 *
 *   npm run test:perf:palette -- <image-directory>
 */
const sourceDirectory = process.argv[2] ?? process.env.WORLDLINEBOX_PALETTE_BENCH_DIR;
if (!sourceDirectory) {
  console.error('Usage: npm run test:perf:palette -- <image-directory>');
  process.exit(2);
}
const resolvedSource = path.resolve(sourceDirectory);
if (!existsSync(resolvedSource) || !statSync(resolvedSource).isDirectory()) {
  console.error(`Not an existing directory: ${resolvedSource}`);
  process.exit(2);
}

const child = spawn(process.execPath, [
  'scripts/run-vitest-with-electron.mjs',
  'run',
  '--config',
  'vitest.config.ts',
  'tests/worker/palette-benchmark.test.ts',
  '--disableConsoleIntercept',
], {
  env: {
    ...process.env,
    WORLDLINEBOX_PALETTE_BENCH: '1',
    WORLDLINEBOX_PALETTE_BENCH_DIR: resolvedSource,
  },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error('Failed to run the palette benchmark.', error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
