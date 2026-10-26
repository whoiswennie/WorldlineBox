import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Forge's Vite prePackage hook removes its entire .vite directory after the
// configured prePackage hook. Extra resources must survive outside that tree.
const releaseRoot = path.join(projectRoot, '.tools', 'vcp-memory-release');
const stageRoot = path.join(releaseRoot, 'vcp-memory');
const hostRoot = path.join(releaseRoot, 'vcp-memory-host');
const physicalProjectRoot = await realpath(projectRoot);
async function assertStagePath(output) {
  let ancestor = projectRoot;
  for (const segment of path.relative(projectRoot, output).split(path.sep)) {
    ancestor = path.join(ancestor, segment);
    let info;
    try { info = await lstat(ancestor); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe VCP staging ancestor: ${ancestor}`);
    const relative = path.relative(physicalProjectRoot, await realpath(ancestor));
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`VCP staging ancestor escapes the workspace: ${ancestor}`);
    }
  }
}
const verified = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/vendor-vcp-memory.mjs'), '--verify'], { stdio: 'inherit' });
if (verified.status !== 0) throw new Error('VCP vendor verification failed.');
for (const output of [stageRoot, hostRoot]) {
  if (path.dirname(output) !== releaseRoot || !['vcp-memory', 'vcp-memory-host'].includes(path.basename(output))) throw new Error('Unsafe VCP staging path.');
  await assertStagePath(output);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
}
await cp(path.join(projectRoot, 'vendor/vcp-memory'), stageRoot, { recursive: true, dereference: true,
  filter: source => path.basename(source) !== 'node_modules' });
for (const file of ['runtime.cjs', 'worker.cjs', 'peripherals.cjs', 'prepared-focus.cjs', 'record-catalog.cjs', 'cold-runtime.cjs', 'cold-worker.cjs', 'dream-runtime.cjs']) await cp(path.join(projectRoot, 'src/main/vcp-memory', file), path.join(hostRoot, file));

const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
const stagedPackages = [];
const moduleRoot = await realpath(path.join(projectRoot, 'node_modules'));
const stagedSources = new Set();
const dependencyBindings = [];
async function packageRoot(name, anchor) {
  const resolver = createRequire(path.join(anchor, 'package.json'));
  let file;
  try { file = resolver.resolve(`${name}/package.json`); }
  catch { file = resolver.resolve(name); }
  let directory = path.dirname(file);
  for (;;) {
    try {
      const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (candidate.name === name) return { directory, metadata: candidate };
    } catch { /* Continue to the package boundary. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Could not locate package metadata for ${name}.`);
    directory = parent;
  }
}
async function stagePackage(name, anchor, optional = false) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)) throw new Error(`Unsafe npm package name: ${name}`);
  let resolved;
  try { resolved = await packageRoot(name, anchor); }
  catch (error) {
    // Only the optional package itself may be absent. A missing mandatory
    // dependency inside an installed optional package must still fail staging.
    if (optional && error.code === 'MODULE_NOT_FOUND') return;
    throw error;
  }
  const { directory, metadata } = resolved;
  const source = await realpath(directory), relative = path.relative(moduleRoot, source);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`VCP dependency resolves outside project node_modules: ${name}`), { code: 'VCP_STAGE_EXTERNAL_PACKAGE' });
  }
  dependencyBindings.push({ name, anchor: anchor === projectRoot ? null : path.relative(moduleRoot, anchor), expected: relative });
  if (stagedSources.has(source)) return;
  stagedSources.add(source);
  // Preserve npm's real hoisted layout, including legitimate nested versions.
  // Inventing another node_modules at every edge inflated 220 copies and broke
  // Inno's Windows path limit despite a much smaller actual dependency closure.
  const target = path.join(stageRoot, 'node_modules', relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: true,
    filter: source => path.basename(source) !== 'node_modules' && path.basename(source) !== '.git' });
  stagedPackages.push({ name: metadata.name, version: metadata.version, path: path.relative(stageRoot, target).replaceAll('\\', '/') });
  const dependencies = { ...metadata.dependencies, ...metadata.optionalDependencies };
  for (const dependency of Object.keys(dependencies)) {
    await stagePackage(dependency, source, dependency in (metadata.optionalDependencies || {}));
  }
}
const peripheralManifest = JSON.parse(await readFile(path.join(projectRoot, 'vendor/vcp-memory/peripheral-manifest.json'), 'utf8'));
const runtimePackages = peripheralManifest.runtimePackages;
for (const name of runtimePackages) {
  projectRequire.resolve(name);
  await stagePackage(name, projectRoot);
}
// Verify every successful edge, including differently nested versions. A stage
// under this checkout could otherwise accidentally resolve a missing dependency
// from the checkout's own node_modules and appear complete during development.
const stagedModuleRoot = await realpath(path.join(stageRoot, 'node_modules'));
for (const binding of dependencyBindings) {
  const anchor = binding.anchor === null ? stageRoot : path.join(stagedModuleRoot, binding.anchor);
  const resolved = await realpath((await packageRoot(binding.name, anchor)).directory);
  if (resolved !== path.join(stagedModuleRoot, binding.expected)) {
    throw new Error(`VCP staged dependency binding changed: ${binding.name} from ${binding.anchor ?? '<runtime>'}.`);
  }
}
await writeFile(path.join(stageRoot, 'runtime-packages.json'), JSON.stringify(stagedPackages, null, 2) + '\n');
const packagedRoot = path.join(projectRoot, 'out', `WorldlineBox-${process.platform}-${process.arch}`, 'resources', 'vcp-memory');
let longest = '', files = 0;
const pending = [stageRoot];
while (pending.length) {
  const directory = pending.pop();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) pending.push(file);
    else {
      const projected = path.join(packagedRoot, path.relative(stageRoot, file));
      files++;
      if (projected.length > longest.length) longest = projected;
    }
  }
}
if (process.platform === 'win32' && longest.length > 259) throw new Error(`VCP package input exceeds Inno's Windows path limit (${longest.length}): ${longest}`);
await writeFile(path.join(stageRoot, 'runtime-layout.json'), JSON.stringify({ schema: 'worldlinebox.vcp-runtime-layout',
  uniquePackages: stagedPackages.length, dependencyBindings: dependencyBindings.length, files,
  longestProjectedPackagePath: longest, longestProjectedPackagePathLength: longest.length }, null, 2) + '\n');
console.log(`Staged VCP vendor and ${stagedPackages.length} production packages at ${stageRoot}; host at ${hostRoot}.`);
console.log(`Verified ${dependencyBindings.length} dependency bindings against the source npm layout.`);
console.log(`Longest VCP Inno package input: ${longest.length} characters.`);
