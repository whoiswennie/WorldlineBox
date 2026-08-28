import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'docs/README.md',
  'docs/architecture.md',
  'docs/cordis-primer.md',
  'docs/capability-seams.md',
  'docs/profiles-and-bundles.md',
  'docs/host-client-boundary.md',
  'docs/session-turn-lifecycle.md',
  'docs/defensive-patterns.md',
  'docs/testing-and-quality.md',
  'packages/README.md',
];
const missing = required.filter(path => !existsSync(join(root, path)));
if (missing.length > 0) throw new Error(`knowledge-base files missing:\n${missing.join('\n')}`);

const index = readFileSync(join(root, 'docs', 'README.md'), 'utf8');
const unindexed = required
  .filter(path => path.startsWith('docs/') && path !== 'docs/README.md')
  .filter(path => !index.includes(`(${path.slice('docs/'.length)})`));
if (unindexed.length > 0) throw new Error(`knowledge-base pages absent from index:\n${unindexed.join('\n')}`);

process.stdout.write(`knowledge-base contract passed for ${String(required.length)} required artifacts\n`);
