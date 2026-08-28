import { existsSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const clean = process.argv.includes('--clean');
const sourceRoots = ['apps', 'packages', 'vendor'].map(path => join(root, path));
const skipped = new Set(['node_modules', 'lib', 'dist', 'release', 'coverage', '.git']);

function sourceCandidate(path) {
  if (path.endsWith('.d.ts.map')) return path.slice(0, -9);
  if (path.endsWith('.d.ts')) return path.slice(0, -5);
  if (path.endsWith('.js.map')) return path.slice(0, -7);
  if (path.endsWith('.js')) return path.slice(0, -3);
  return undefined;
}

function hasTypeScriptSource(stem) {
  return ['.ts', '.tsx', '.mts', '.cts'].some(extension => existsSync(`${stem}${extension}`));
}

async function collect(directory, insideSource = false, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(path, insideSource || entry.name === 'src', result);
      continue;
    }
    if (!entry.isFile() || !insideSource) continue;
    const stem = sourceCandidate(path);
    if (stem !== undefined && hasTypeScriptSource(stem)) result.push(path);
  }
  return result;
}

const artifacts = [];
for (const directory of sourceRoots) {
  if (existsSync(directory)) await collect(directory, false, artifacts);
}
artifacts.sort();
if (clean) {
  await Promise.all(artifacts.map(path => unlink(path)));
  console.log(`source artifact cleanup: removed ${artifacts.length} emitted file(s)`);
} else if (artifacts.length > 0) {
  console.error('Generated JavaScript/declaration artifacts were found beside TypeScript source:');
  for (const path of artifacts) console.error(`- ${relative(root, path)}`);
  console.error('Run pnpm run clean:source-artifacts, then keep build output under lib/.');
  process.exitCode = 1;
} else {
  console.log('source artifact layering: clean');
}
