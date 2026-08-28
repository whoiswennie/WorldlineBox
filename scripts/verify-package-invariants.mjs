import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function leafPackages() {
  const result = [];
  const packagesRoot = join(workspaceRoot, 'packages');
  for (const group of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupRoot = join(packagesRoot, group.name);
    for (const entry of await readdir(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageRoot = join(groupRoot, entry.name);
      if (existsSync(join(packageRoot, 'package.json'))) result.push(packageRoot);
    }
  }
  return result;
}

const failures = [];
const packages = await leafPackages();
for (const packageRoot of packages) {
  const packagePath = relative(workspaceRoot, packageRoot).split(sep).join('/');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const invariant = manifest.exports?.['./invariant'];
  if (!existsSync(join(packageRoot, 'src', 'invariant.ts'))) {
    failures.push(`${packagePath}: missing src/invariant.ts`);
  }
  if (typeof invariant !== 'object' || invariant === null
    || typeof invariant.types !== 'string' || typeof invariant.default !== 'string') {
    failures.push(`${packagePath}: missing typed ./invariant export`);
  }
  if (manifest.name !== '@deepseek-ai/dsh-invariants') {
    if (manifest.peerDependencies?.['@deepseek-ai/dsh-invariants'] === undefined) {
      failures.push(`${packagePath}: missing @deepseek-ai/dsh-invariants peer dependency`);
    }
    if (manifest.devDependencies?.['@deepseek-ai/dsh-invariants'] === undefined) {
      failures.push(`${packagePath}: missing @deepseek-ai/dsh-invariants development dependency`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`package invariant contract failed:\n${failures.join('\n')}`);
}
process.stdout.write(`package invariant contract passed for ${String(packages.length)} packages\n`);
