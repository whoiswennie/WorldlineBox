import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import process from 'node:process';

import { build } from 'vite';

const require = createRequire(import.meta.url);
const playwrightPackage = require('@playwright/test/package.json');
const playwrightBin =
  typeof playwrightPackage.bin === 'string'
    ? playwrightPackage.bin
    : playwrightPackage.bin?.playwright;

if (typeof playwrightBin !== 'string') {
  throw new TypeError('The local Playwright package does not expose its CLI entry point.');
}

const projectRoot = path.resolve(process.cwd());
const isolatedBuild = process.env.WORLDLINEBOX_E2E_ISOLATED_BUILD === '1';
const applicationRoot = isolatedBuild ? path.join(projectRoot, '.tools', 'e2e-app') : projectRoot;
const buildRoot = path.join(applicationRoot, '.vite');
const mainBuildDirectory = path.join(buildRoot, 'build');
const electronExternals = [
  'electron',
  'electron/common',
  'electron/main',
  'electron/renderer',
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
];
const nodeResolve = {
  conditions: ['node'],
  mainFields: ['module', 'jsnext:main', 'jsnext'],
};

function requireContainedPath(root, target) {
  const relative = path.relative(root, target);
  if (!path.isAbsolute(root) || !path.isAbsolute(target) || !relative
    || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`E2E build path must stay inside its expected root: ${target}`);
  }
}

async function existingStats(target) {
  try { return await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function ensureOwnedDirectory(parent, directory) {
  requireContainedPath(parent, directory);
  const stats = await existingStats(directory);
  if (stats?.isSymbolicLink() || (stats && !stats.isDirectory())) {
    throw new Error(`Refusing an E2E build directory that is a link or non-directory: ${directory}`);
  }
  if (!stats) await mkdir(directory);
  if (path.relative(await realpath(parent), path.dirname(await realpath(directory))) !== '') {
    throw new Error(`E2E build directory resolves outside its expected parent: ${directory}`);
  }
}

async function ensureStaticDirectoryLink(name) {
  const target = path.join(projectRoot, name);
  const link = path.join(applicationRoot, name);
  requireContainedPath(projectRoot, target);
  requireContainedPath(applicationRoot, link);
  const targetStats = await lstat(target);
  const resolvedTarget = await realpath(target);
  requireContainedPath(await realpath(projectRoot), resolvedTarget);
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error(`Expected a trusted project static directory: ${target}`);
  }
  const linkStats = await existingStats(link);
  if (linkStats) {
    if (!linkStats.isSymbolicLink() || path.relative(resolvedTarget, await realpath(link)) !== '') {
      throw new Error(`Existing E2E static directory link points to an unexpected target: ${link}`);
    }
    return;
  }
  // Never remove these links recursively: their targets are the user's assets.
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

if (isolatedBuild) {
  const toolsRoot = path.join(projectRoot, '.tools');
  await ensureOwnedDirectory(projectRoot, toolsRoot);
  await ensureOwnedDirectory(toolsRoot, applicationRoot);
  const packagePath = path.join(applicationRoot, 'package.json');
  if ((await existingStats(packagePath))?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite a linked E2E package manifest: ${packagePath}`);
  }
  const sourcePackage = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  await writeFile(packagePath, `${JSON.stringify({
    name: sourcePackage.name,
    productName: sourcePackage.productName,
    version: sourcePackage.version,
    main: '.vite/build/main.js',
  }, null, 2)}\n`);
  await ensureStaticDirectoryLink('assets');
  await ensureStaticDirectoryLink('resources');
}

// Check the final absolute deletion target and its real parent first. In
// isolated mode only .tools/e2e-app/.vite is cleared; the dev .vite is untouched.
requireContainedPath(applicationRoot, buildRoot);
const buildStats = await existingStats(buildRoot);
if (buildStats?.isSymbolicLink() || (buildStats && !buildStats.isDirectory())
  || path.relative(await realpath(applicationRoot), await realpath(path.dirname(buildRoot))) !== '') {
  throw new Error(`Refusing to clear an unexpected E2E build target: ${buildRoot}`);
}
await rm(buildRoot, { force: true, recursive: true });

// E2E launches Electron itself, so build a production-like file:// application.
// This avoids coupling the tests to a Vite process or a dev-server URL baked by
// a previous `electron-forge start` invocation.
await build({
  configFile: path.join(projectRoot, 'vite.main.config.ts'),
  define: {
    MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
    MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
  },
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

await build({
  configFile: path.join(projectRoot, 'vite.preload.config.ts'),
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.join(projectRoot, 'src/preload/index.ts'),
      fileName: () => 'index.js',
      formats: ['cjs'],
    },
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

// The hidden model-thumbnail BrowserWindow has its own preload bridge. Forge
// builds it through the Vite plugin, but this production-like E2E entrypoint
// assembles the build graph manually and must emit the same bundle.
await build({
  configFile: path.join(projectRoot, 'vite.offscreen-preload.config.ts'),
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.join(projectRoot, 'src/preload/offscreen.ts'),
      fileName: () => 'offscreen.js',
      formats: ['cjs'],
    },
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

// Critical confirmation child windows use a separate, narrow preload bridge;
// keep the production-like E2E build graph in lockstep with Forge.
await build({
  configFile: path.join(projectRoot, 'vite.critical-confirmation-preload.config.ts'),
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.join(projectRoot, 'src/preload/critical-confirmation.ts'),
      fileName: () => 'critical-confirmation.js',
      formats: ['cjs'],
    },
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

await build({
  configFile: path.join(projectRoot, 'vite.worker.config.ts'),
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

// Desktop Console scripts now execute in a separate UtilityProcess. The E2E
// application uses a `.vite/build` layout like Forge, so this entry must be
// rebuilt alongside Main/Preload/Library Worker; otherwise an old
// runtime artifact could make a current Console test exercise stale code.
await build({
  configFile: path.join(projectRoot, 'vite.script-runtime.config.ts'),
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

await build({
  configFile: path.join(projectRoot, 'vite.plugin-runtime.config.ts'),
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

await build({
  configFile: path.join(projectRoot, 'vite.plugin-trusted-runtime.config.ts'),
  resolve: nodeResolve,
  build: {
    emptyOutDir: false,
    outDir: mainBuildDirectory,
    rollupOptions: {
      external: electronExternals,
    },
  },
});

await build({
  base: './',
  configFile: path.join(projectRoot, 'vite.renderer.config.ts'),
  build: {
    emptyOutDir: true,
    outDir: path.join(buildRoot, 'renderer/main_window'),
  },
});

const playwrightPath = require.resolve('@playwright/test/cli');
// Cursor/agent shells often inherit ELECTRON_RUN_AS_NODE=1 so Electron behaves
// like plain Node and rejects Playwright's --remote-debugging-port. Strip it
// for the Playwright child and every Electron process it launches.
const playwrightEnv = { ...process.env };
delete playwrightEnv.ELECTRON_RUN_AS_NODE;
if (isolatedBuild) playwrightEnv.WORLDLINEBOX_E2E_APP_PATH = applicationRoot;
const child = spawn(process.execPath, [playwrightPath, 'test', ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: playwrightEnv,
  stdio: 'inherit',
});

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
