import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = process.platform === 'win32'
  ? [join(root, '.venv', 'Scripts', 'python.exe'), 'python']
  : [join(root, '.venv', 'bin', 'python'), 'python3', 'python'];
const configured = process.env.WORLDLINE_PYTHON;
const executable = configured
  ?? candidates.find(candidate => !candidate.includes(root) || existsSync(candidate));
if (executable === undefined) throw new Error('no Python interpreter available for SDK tests');

const result = spawnSync(executable, ['-m', 'pytest', 'python/sdk/tests', '-q'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
