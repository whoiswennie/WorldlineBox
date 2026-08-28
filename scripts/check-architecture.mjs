import { spawnSync } from 'node:child_process';

const pnpmEntry = process.env.npm_execpath;
if (pnpmEntry === undefined) throw new Error('check:architecture must be invoked through pnpm');

for (const script of [
  'verify:package-invariants',
  'verify:knowledge-base',
  'verify:markdown-links',
  'verify:runtime-brand',
  'verify:source-artifacts',
  'constraints',
  'verify:dsh-package-licenses',
  'verify:cordis-config',
  'verify:node-next-types',
  'verify:runtime-closure',
  'verify:vendored-links',
  'verify:client-domain-graph',
  'build:types:host',
  'build:types:client',
  'lint:contracts-ready',
]) {
  const result = spawnSync(process.execPath, [pnpmEntry, 'run', script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
