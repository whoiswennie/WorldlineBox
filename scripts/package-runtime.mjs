import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const target = resolve(root, 'dist/runtime')
const deployWorkspaceFilter = './apps/cli'
if (!target.startsWith(`${root}${sep}`)) throw new Error('runtime target escaped the workspace')
const fsRetrySignal = new Int32Array(new SharedArrayBuffer(4))

function retryTransientWindows(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      const transient = process.platform === 'win32'
        && (error?.code === 'EPERM' || error?.code === 'EBUSY')
      if (!transient || attempt >= 7) throw error
      Atomics.wait(fsRetrySignal, 0, 0, Math.min(50 * 2 ** attempt, 1_000))
    }
  }
}

function removeRuntimeTarget() {
  retryTransientWindows(() => rmSync(target, { recursive: true, force: true }))
}

const pnpmEntry = process.env.npm_execpath
if (pnpmEntry === undefined || !existsSync(pnpmEntry)) {
  throw new Error('package-runtime must be invoked through pnpm')
}

function restoreWorkspaceInstall() {
  const restored = spawnSync(process.execPath, [
    pnpmEntry,
    '--config.confirmModulesPurge=false',
    'install', '--frozen-lockfile', '--reporter=silent',
  ], { cwd: root, stdio: 'inherit', env: process.env })
  if (restored.error !== undefined) throw restored.error
  if (restored.status !== 0) {
    throw new Error(`workspace install restoration failed with status ${restored.status ?? 'unknown'}`)
  }
}

let deployed
let deployTarget
for (let attempt = 0; attempt < 3; attempt += 1) {
  deployTarget = mkdtempSync(join(tmpdir(), 'worldline-runtime-deploy-'))
  deployed = spawnSync(process.execPath, [
    pnpmEntry,
    '--config.node-linker=hoisted',
    '--filter', deployWorkspaceFilter,
    'deploy', '--prod', '--legacy', '--reporter=silent', deployTarget,
  ], { cwd: root, stdio: 'inherit', env: process.env })
  if (deployed.error !== undefined) throw deployed.error
  if (deployed.status === 0) break
  // pnpm deploy occasionally reports either a regular failure or a negative
  // Windows errno while antivirus/indexing releases the just-replaced tree.
  // Retrying the clean, idempotent deploy keeps build-exe.bat deterministic.
  if (process.platform !== 'win32' || attempt === 2) break
  console.warn(`runtime deploy attempt ${attempt + 1} failed with status ${deployed.status}; retrying`)
  retryTransientWindows(() => rmSync(deployTarget, { recursive: true, force: true }))
  deployTarget = undefined
  Atomics.wait(fsRetrySignal, 0, 0, 200 * 2 ** attempt)
}
// Legacy deploy needs a hoisted production tree, but pnpm also applies that
// temporary linker state to the workspace metadata. Restore the locked
// development install before any subsequent pnpm command inspects it.
restoreWorkspaceInstall()
if (deployed?.status !== 0) {
  if (deployTarget !== undefined) {
    retryTransientWindows(() => rmSync(deployTarget, { recursive: true, force: true }))
  }
  throw new Error(`pnpm deploy failed after 3 attempts (status ${deployed?.status ?? 'unknown'})`)
}
const deployedNodeModules = join(deployTarget, 'node_modules')
if (!existsSync(deployedNodeModules)) {
  retryTransientWindows(() => rmSync(deployTarget, { recursive: true, force: true }))
  throw new Error(
    `pnpm deploy produced no node_modules for workspace filter ${deployWorkspaceFilter}`,
  )
}
try {
  removeRuntimeTarget()
  // pnpm's final atomic rename is frequently intercepted in watched workspace
  // folders on Windows. Deploy in the OS temp directory, then copy the verified
  // tree into dist without depending on that fragile cross-directory rename.
  retryTransientWindows(() => cpSync(deployTarget, target, { recursive: true, dereference: true }))
} finally {
  retryTransientWindows(() => rmSync(deployTarget, { recursive: true, force: true }))
}

const pruneStats = { files: 0, bytes: 0 }
const metadataPattern = /(?:\.map|\.pdb|\.d\.(?:ts|mts|cts)|\.tsbuildinfo)$/i
const testFilePattern = /(?:^|\.)(?:test|spec)\.(?:[cm]?[jt]sx?)$/i
const documentationPattern = /^(?:readme|changelog|history|security|contributing)(?:\..*)?$/i
const disposableDirectoryNames = new Set(['__tests__', 'test', 'tests', 'example', 'examples'])
function renameWithRetry(source, destination) {
  retryTransientWindows(() => renameSync(source, destination))
}

function account(path) {
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) account(join(path, entry))
  } else if (stat.isFile()) {
    pruneStats.files += 1
    pruneStats.bytes += stat.size
  }
}

function removeAccounted(path) {
  if (!existsSync(path)) return
  account(path)
  rmSync(path, { recursive: true, force: true })
}

function pruneTree(path, isPackageRoot = false) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      if (!isPackageRoot && disposableDirectoryNames.has(entry.name.toLowerCase())) {
        removeAccounted(entryPath)
      } else {
        pruneTree(entryPath)
      }
      continue
    }
    if (!entry.isFile()) continue
    if (metadataPattern.test(entry.name)
      || testFilePattern.test(entry.name)
      || documentationPattern.test(entry.name)) {
      removeAccounted(entryPath)
    }
  }
}

function materializeLinks(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      // pnpm may leave a .bin shim whose optional command package was omitted
      // from the production deploy. It is unusable by definition; removing it
      // keeps cross-platform materialization from trying to dereference ENOENT.
      if (!existsSync(entryPath)) {
        rmSync(entryPath, { force: true })
        continue
      }
      const materializedPath = `${entryPath}.worldline-materialized`
      rmSync(materializedPath, { recursive: true, force: true })
      cpSync(entryPath, materializedPath, { recursive: true, dereference: true })
      rmSync(entryPath, { recursive: true, force: true })
      renameWithRetry(materializedPath, entryPath)
    } else if (entry.isDirectory()) {
      materializeLinks(entryPath)
    }
  }
}

function pruneNodePty(runtimeRoot) {
  if (process.platform !== 'win32') return
  const packageRoots = []
  const hoistedPackage = join(runtimeRoot, 'node_modules', 'node-pty')
  if (existsSync(hoistedPackage)) packageRoots.push(hoistedPackage)
  const pnpmStore = join(runtimeRoot, 'node_modules', '.pnpm')
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('node-pty@')) continue
      packageRoots.push(join(pnpmStore, entry.name, 'node_modules', 'node-pty'))
    }
  }
  for (const packageRoot of new Set(packageRoots)) {
    const activePrebuild = `${process.platform}-${process.arch}`
    const activePrebuildPath = join(packageRoot, 'prebuilds', activePrebuild)
    if (!existsSync(activePrebuildPath)) continue
    for (const sourceEntry of ['build', 'deps', 'scripts', 'src', 'third_party', 'typings', 'binding.gyp']) {
      removeAccounted(join(packageRoot, sourceEntry))
    }
    const prebuilds = join(packageRoot, 'prebuilds')
    for (const prebuild of readdirSync(prebuilds, { withFileTypes: true })) {
      if (prebuild.isDirectory() && prebuild.name !== activePrebuild) {
        removeAccounted(join(prebuilds, prebuild.name))
      }
    }
  }
}

materializeLinks(join(target, 'node_modules'))
pruneTree(join(target, 'node_modules'), true)
pruneNodePty(target)
console.log(`runtime prune: ${pruneStats.files} files, ${(pruneStats.bytes / 1024 / 1024).toFixed(2)} MiB`)

const verified = spawnSync(process.execPath, [resolve(root, 'scripts/verify-deployed-runtime.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
if (verified.error !== undefined) throw verified.error
if (verified.status !== 0) process.exit(verified.status ?? 1)
