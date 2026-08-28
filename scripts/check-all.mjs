import { spawnSync } from 'node:child_process';

const pnpmEntry = process.env.npm_execpath;
if (pnpmEntry === undefined) throw new Error('check:all must be invoked through pnpm');

const scripts = [
  'check:architecture',
  'build',
  'verify:built-package-invariants',
  'publint',
  'docs:build',
  'test:runtime',
  'test:scripts',
  'test:client',
  'test:cli',
  'test:desktop',
  ...(process.env.WORLDLINE_SKIP_PYTHON === '1' ? [] : ['test:python']),
];
for (const script of scripts) {
  process.stdout.write(`\n[worldline-check] ${script}\n`);
  const result = spawnSync(process.execPath, [pnpmEntry, 'run', script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
