/**
 * Profile discovery, initialization, and patch-layer composition for the
 * `worldline --profile` launcher family.
 *
 * A profile is a directory under `$WORLDLINE_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * the `dsh.bundle.patch` field; the tree is
 * composed by applying each bundle's patch list in `dsh.profile.bundles` order over
 * an empty entry list, then the profile's own patches, then any launcher
 * layers (`--patch` files and flag-derived patches).
 *
 * Module resolution is two-anchor by construction: a bundle name resolves
 * first from the worldline installation (the launcher's own package), then from the
 * profile directory. The Loader's `baseUrl` is the profile directory, whose
 * `node_modules` pnpm manages for out-of-tree plugins, while the maintained
 * flat fallback directory `$WORLDLINE_HOME/profiles/node_modules` (one symlink per
 * package the installation's app and bundles depend on) makes every in-box
 * plugin Node-resolvable from any profile through the ordinary parent-walk.
 * @module @deepseek-ai/dsh-app-boot/profile
 */

import { createRequire } from 'node:module'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveWorldlineHome } from '@deepseek-ai/dsh-home-paths'
import { loadOverlayPatches } from './index.ts'

/** Directory under the Worldline runtime home holding every profile. */
export const PROFILES_DIR = 'profiles'

/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The bundle half of the `dsh` manifest section: what a bundle package exports. */
export interface WorldlineBundleManifest {
  /** The patch layer this bundle exports, relative to its package root. */
  patch: string
}

/** The profile half of the `dsh` manifest section: what a profile directory composes. */
export interface WorldlineProfileManifest {
  /** Ordered bundle layer list (package names). */
  bundles?: string[]
  /** Installed Bundle dependencies intentionally excluded from composition. */
  disabledBundles?: string[]
  /** Whether profile and home patch files reload while this profile is active. */
  patchReload?: ProfilePatchReload
}

/** User patch-file lifecycle selected by a profile. */
export type ProfilePatchReload = 'live' | 'startup'

/** The DSH package.json section shared with the inherited Harness architecture. */
export interface DshManifestSection {
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: WorldlineBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: WorldlineProfileManifest
}

/** The slice of package.json both profiles and bundles use. */
export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: DshManifestSection
  /** Deprecated persisted profile metadata, consumed only by the one-way migration below. */
  worldline?: DshManifestSection
}

/** Result of reconciling dependency-managed Bundles after a package mutation. */
export interface ProfileBundleReconciliation {
  readonly manifest: ProfileManifest
  readonly changed: boolean
  readonly addedBundles: readonly string[]
  readonly removedBundles: readonly string[]
  readonly addedPlainDependencies: readonly string[]
  readonly addedDisabledBundles: readonly string[]
  readonly removedDisabledBundles: readonly string[]
}

/** Validated active and intentionally disabled Bundle composition. */
export interface ProfileBundleState {
  readonly bundles: readonly string[]
  readonly disabledBundles: readonly string[]
}

/**
 * Read the patch declaration from the DSH bundle protocol.
 * @param manifest - candidate bundle manifest.
 * @returns the declared patch path when the package exports a bundle.
 */
export function profileBundlePatch(manifest: ProfileManifest): string | undefined {
  return manifest.dsh?.bundle?.patch
}

/** One resolved bundle layer of a profile. */
export interface ProfileLayer {
  /** The bundle's package name, as listed in `dsh.profile.bundles`. */
  packageName: string
  /** Absolute directory of the resolved bundle package. */
  packageDir: string
  /** Absolute path of the bundle's patch file. */
  patchPath: string
  /** The parsed patch list. */
  patches: PatchOptions[]
}

/** A loaded profile: resolved bundle layers plus the user's own patch layer. */
export interface Profile {
  /** The profile name (its directory basename). */
  name: string
  /** Absolute profile directory. */
  dir: string
  /** Bundle layers in `dsh.profile.bundles` order. */
  layers: ProfileLayer[]
  /** Absolute path of the profile's own patch file. */
  patchPath: string
  /** The profile's own patches; empty when the file is absent. */
  patches: PatchOptions[]
  /** Whether the launcher watches user patch files after boot. */
  patchReload: ProfilePatchReload
}

/**
 * Resolve a profile's directory under the Worldline runtime home.
 * @param name - the profile name (`worldline --profile <name>`).
 * @param home - the Worldline runtime home; defaults to {@link resolveWorldlineHome}.
 * @returns the absolute profile directory (which may not exist yet).
 */
export function resolveProfileDir(name: string, home: string = resolveWorldlineHome()): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
    // The launcher-maintained flat module fallback lives at this sibling path.
    || name === 'node_modules') {
    throw new Error(`worldline: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
}

/** Shipped automation profiles freeze their patch stack after startup; Web remains live. */
export const PROFILE_PATCH_RELOAD: Readonly<Record<string, ProfilePatchReload>> = Object.freeze({
  acp: 'startup',
  web: 'live',
  headless: 'startup',
  sdk: 'startup',
  'sdk-minimal': 'startup',
})

/** Custom profiles retain Worldline's historical live patch behavior. */
export const DEFAULT_PROFILE_PATCH_RELOAD: ProfilePatchReload = 'live'

/** Installation-owned bundle tuples normalized to the shipped template. */
const INSTALLATION_OWNED_PROFILE_TUPLES: Record<string, readonly string[]> = {
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'],
}

/** The bundle list a `worldline plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this worldline profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// The hoisted linker gives out-of-tree plugins a flat node_modules whose
// missing peers (cordis and friends) fall through to the healed
// profiles/node_modules installation fallback, so every plugin shares the
// installation's single cordis instance instead of a duplicate. pnpm ≥10
// reads its settings from pnpm-workspace.yaml, not .npmrc.
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
* Initialize a profile directory: manifest, empty user patch layer, and the
* pnpm settings out-of-tree plugins need. Existing files are never touched,
* so re-running is a no-op on an initialized profile.
* @param dir - the profile directory from {@link resolveProfileDir}.
* @param bundles - the initial `dsh.profile.bundles` layer list.
* @param patchReload - user patch-file lifecycle; custom profiles default to live reload.
*/
export function initProfile(
  dir: string,
  bundles: readonly string[],
  patchReload: ProfilePatchReload = DEFAULT_PROFILE_PATCH_RELOAD,
): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest & { private: boolean } = {
      name: `worldline-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles], patchReload } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

/** Ensure `link` is a symlink to `target`, replacing a wrong or dangling link; a real directory throws. */
function ensureSymlink(link: string, target: string): void {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    // Missing link (first run) — created below. Any other lstat failure on a
    // path we just created the parent of would resurface on symlinkSync.
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`worldline: ${link} exists and is not a symlink; remove it so worldline can manage the installation fallback`)
    }
    if (readlinkSync(link) === target) return
    // unlink deletes the reparse point itself on Windows too; rmSync treats a
    // junction as a directory and throws EISDIR unless recursive.
    unlinkSync(link)
  }
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    // Concurrent launches heal the same fallback; losing the race to a
    // process writing the identical link is success, anything else is not.
    // The window between the lstat miss above and this write cannot be
    // staged deterministically from the public API.
    /* v8 ignore next 4 */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) {
      throw error
    }
  }
}

/**
 * Maintain the flat module fallback `$WORLDLINE_HOME/profiles/node_modules`: one
 * symlink per package in the worldline app's resolvable dependency CLOSURE (BFS
 * over `dependencies` from the app manifest), each resolved from its own
 * real location. Node's parent-directory walk from any profile finds this
 * directory after the profile's own `node_modules`, so every in-box plugin
 * resolves without pnpm ever managing it — the exact "bundles come from the
 * installation" contract. The closure (not just direct dependencies) is
 * required for out-of-tree plugins: their peer dependencies name Service
 * Definition packages (`worldline-compaction`, `worldline-invariants`, ...) that the app
 * reaches only through its Service Provider packages. Symlinked packages
 * resolve their own dependencies from their real directories (Node's default
 * symlink-following), so each package needs only its one flat link.
 * Idempotent: correct links are kept and moved installations are
 * re-pointed; a stale link to a vanished package stays until its name is
 * reused (dangling links are invisible to resolution).
 * @param installAnchor - absolute path of the worldline app's package.json.
 * @param home - the Worldline runtime home; defaults to {@link resolveWorldlineHome}.
 */
export function healProfilesModuleFallback(installAnchor: string, home: string = resolveWorldlineHome()): void {
  const profilesDir = join(home, PROFILES_DIR)
  const modulesDir = join(profilesDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const appManifest = JSON.parse(readFileSync(installAnchor, 'utf8')) as ProfileManifest
  const links = new Map<string, string>()
  /* v8 ignore next -- a real app manifest always declares its name */
  if (appManifest.name !== undefined) links.set(appManifest.name, dirname(installAnchor))
  // BFS over the resolvable dependency graph; the visited set is the link
  // map itself (first resolution wins, matching Node's own nearest-wins).
  const queue: { anchor: string; manifest: ProfileManifest }[] = [{ anchor: installAnchor, manifest: appManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    // Peer dependencies participate: Service Definition packages (worldline-subprocess,
    // worldline-compaction, ...) are peers of their implementations, never plain
    // dependencies, yet out-of-tree plugins import them directly.
    /* v8 ignore next -- a real app manifest always declares dependencies */
    for (const dep of [...Object.keys(next.manifest.dependencies ?? {}), ...Object.keys(next.manifest.peerDependencies ?? {})]) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      // A declared-but-uninstalled dependency cannot be a loader-visible
      // plugin; skip it rather than fail the whole boot.
      if (dir === undefined) continue
      links.set(dep, dir)
      const manifestPath = join(dir, 'package.json')
      queue.push({ anchor: manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest })
    }
  }
  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureSymlink(link, target)
  }
}

/**
 * Read a profile's manifest.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param dir - the profile directory.
 * @returns the parsed manifest.
 */
export function readProfileManifest(binName: string, dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`)
  }
  // The field checks below validate the file data before trusting the parse type.
  const parsed = JSON.parse(raw) as ProfileManifest | null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`)
  }
  return parsed
}

/**
 * Write a profile's manifest back (2-space JSON, trailing newline).
 * @param dir - the profile directory.
 * @param manifest - the manifest value to persist.
 */
export function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
}

function profileManifestSection(manifest: ProfileManifest): WorldlineProfileManifest | undefined {
  return manifest.dsh?.profile
}

function withProfileBundleState(
  manifest: ProfileManifest,
  bundles: readonly string[],
  disabledBundles: readonly string[],
): ProfileManifest {
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: [...bundles], disabledBundles: [...disabledBundles] },
    },
  }
}

/**
 * Read active and disabled Bundle lists and reject ambiguous composition state.
 * @param manifest - profile manifest to validate.
 * @returns detached active and disabled bundle lists.
 */
export function readProfileBundleState(manifest: ProfileManifest): ProfileBundleState {
  const profile = profileManifestSection(manifest)
  const bundles = [...profile?.bundles ?? []]
  const disabledBundles = [...profile?.disabledBundles ?? []]
  for (const [label, values] of [['bundles', bundles], ['disabledBundles', disabledBundles]] as const) {
    if (values.some(value => typeof value !== 'string' || value.length === 0)) {
      throw new Error(`worldline: dsh.profile.${label} must contain non-empty package names`)
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`worldline: dsh.profile.${label} must not contain duplicates`)
    }
  }
  const disabled = new Set(disabledBundles)
  const overlap = bundles.find(packageName => disabled.has(packageName))
  if (overlap !== undefined) {
    throw new Error(`worldline: profile Bundle ${JSON.stringify(overlap)} cannot be both active and disabled`)
  }
  return { bundles, disabledBundles }
}

/**
 * Express active/disabled intent immutably without changing package installation.
 * @param manifest - current profile manifest.
 * @param packageName - installed bundle whose activation state changes.
 * @param enabled - whether the bundle belongs in the active list.
 * @returns the updated manifest, or the original object when already in that state.
 */
export function setProfileBundleEnabled(
  manifest: ProfileManifest,
  packageName: string,
  enabled: boolean,
): ProfileManifest {
  if (!(packageName in (manifest.dependencies ?? {}))) {
    throw new Error(`worldline: cannot change uninstalled Profile Bundle ${JSON.stringify(packageName)}`)
  }
  const state = readProfileBundleState(manifest)
  if (!state.bundles.includes(packageName) && !state.disabledBundles.includes(packageName)) {
    throw new Error(`worldline: dependency ${JSON.stringify(packageName)} is not a Profile Bundle`)
  }
  if (enabled === state.bundles.includes(packageName)) return manifest
  const bundles = state.bundles.filter(value => value !== packageName)
  const disabledBundles = state.disabledBundles.filter(value => value !== packageName)
  if (enabled) bundles.push(packageName)
  else disabledBundles.push(packageName)
  return withProfileBundleState(manifest, bundles, disabledBundles)
}

/**
 * Reconcile dependency-managed Bundles after a successful package-manager mutation.
 * @param before - manifest before the package-manager operation.
 * @param after - manifest after the package-manager operation.
 * @param exportsBundle - package inspection callback for bundle capability.
 * @returns updated manifest plus an exact reconciliation summary.
 */
export function reconcileProfileBundles(
  before: ProfileManifest,
  after: ProfileManifest,
  exportsBundle: (packageName: string) => boolean,
): ProfileBundleReconciliation {
  const beforeDependencies = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const dependencySet = new Set(dependencies)
  const bundleStatus = new Map(dependencies.map(packageName => [packageName, exportsBundle(packageName)]))
  const beforeState = readProfileBundleState(before)
  const afterState = readProfileBundleState(after)
  const bundles = [...afterState.bundles]
  const disabledBundles = [...afterState.disabledBundles]
  const addedBundles: string[] = []
  const removedBundles: string[] = []
  const addedPlainDependencies: string[] = []
  const addedDisabledBundles: string[] = []
  const removedDisabledBundles: string[] = []

  for (const packageName of beforeState.disabledBundles) {
    if (dependencySet.has(packageName) && bundleStatus.get(packageName) === true
      && !disabledBundles.includes(packageName)) {
      disabledBundles.push(packageName)
      addedDisabledBundles.push(packageName)
      const activeIndex = bundles.indexOf(packageName)
      if (activeIndex !== -1) bundles.splice(activeIndex, 1)
    }
  }
  for (const packageName of dependencies) {
    if (bundleStatus.get(packageName) === true) {
      const newlyInstalled = !beforeDependencies.has(packageName)
      const intentionallyDisabled = !newlyInstalled && disabledBundles.includes(packageName)
      if (newlyInstalled && disabledBundles.includes(packageName)) {
        disabledBundles.splice(disabledBundles.indexOf(packageName), 1)
        removedDisabledBundles.push(packageName)
      }
      if (!intentionallyDisabled && !bundles.includes(packageName)) {
        bundles.push(packageName)
        addedBundles.push(packageName)
      }
    } else if (!beforeDependencies.has(packageName)) {
      addedPlainDependencies.push(packageName)
    }
  }

  const reconciledBundles = bundles.filter((packageName) => {
    const dependencyManaged = beforeDependencies.has(packageName) || dependencySet.has(packageName)
    const remainsBundle = dependencySet.has(packageName) && bundleStatus.get(packageName) === true
    if (!dependencyManaged || remainsBundle) return true
    removedBundles.push(packageName)
    return false
  })
  const reconciledDisabled = disabledBundles.filter((packageName) => {
    const remainsBundle = dependencySet.has(packageName) && bundleStatus.get(packageName) === true
    if (remainsBundle) return true
    removedDisabledBundles.push(packageName)
    return false
  })
  const active = new Set(reconciledBundles)
  const overlapping = reconciledDisabled.find(packageName => active.has(packageName))
  if (overlapping !== undefined) {
    throw new Error(`worldline: profile Bundle ${JSON.stringify(overlapping)} cannot be both active and disabled`)
  }
  const changed = !sameBundles(afterState.bundles, reconciledBundles)
    || !sameBundles(afterState.disabledBundles, reconciledDisabled)
  return {
    manifest: changed ? withProfileBundleState(after, reconciledBundles, reconciledDisabled) : after,
    changed,
    addedBundles,
    removedBundles,
    addedPlainDependencies,
    addedDisabledBundles,
    removedDisabledBundles,
  }
}

/** Return whether two bundle lists have the same values in the same order. */
function sameBundles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const LEGACY_PACKAGE_SCOPE = '@worldline/'
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh-'

function migratePackageName(packageName: string): string {
  if (!packageName.startsWith(LEGACY_PACKAGE_SCOPE)) return packageName
  return `${DSH_PACKAGE_PREFIX}${packageName.slice(LEGACY_PACKAGE_SCOPE.length)}`
}

function migrateDependencyMap(
  dependencies: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (dependencies === undefined) return undefined
  const migrated: Record<string, string> = {}
  for (const [packageName, range] of Object.entries(dependencies)) {
    const currentName = migratePackageName(packageName)
    // A profile that already names the current coordinate owns that range.
    if (currentName in dependencies && currentName !== packageName) continue
    migrated[currentName] = range
  }
  return migrated
}

/**
 * Upgrade persisted pre-DSH profiles once, preserving third-party bundles and
 * dependency ranges. This is deliberately not a module-resolution alias:
 * after the atomic manifest rewrite, only `dsh.profile` and current package
 * coordinates participate in every subsequent boot.
 */
function migratePersistedProfile(dir: string, manifest: ProfileManifest): ProfileManifest {
  const legacyProfile = manifest.worldline?.profile
  const currentProfile = manifest.dsh?.profile
  const dependencies = migrateDependencyMap(manifest.dependencies)
  const peerDependencies = migrateDependencyMap(manifest.peerDependencies)
  const sourceProfile = currentProfile ?? legacyProfile
  const profile = sourceProfile === undefined ? undefined : {
    ...sourceProfile,
    ...(sourceProfile.bundles === undefined
      ? {}
      : { bundles: sourceProfile.bundles.map(migratePackageName) }),
    ...(sourceProfile.disabledBundles === undefined
      ? {}
      : { disabledBundles: sourceProfile.disabledBundles.map(migratePackageName) }),
  }
  const changed = manifest.worldline !== undefined
    || (dependencies !== manifest.dependencies
      && JSON.stringify(dependencies) !== JSON.stringify(manifest.dependencies))
    || (peerDependencies !== manifest.peerDependencies
      && JSON.stringify(peerDependencies) !== JSON.stringify(manifest.peerDependencies))
    || (profile !== undefined && JSON.stringify(profile) !== JSON.stringify(currentProfile))
  if (!changed) return manifest
  const { worldline: _legacy, ...rest } = manifest
  const migrated: ProfileManifest = {
    ...rest,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(profile === undefined ? {} : { dsh: { ...manifest.dsh, profile } }),
  }
  writeProfileManifest(dir, migrated)
  return migrated
}

/**
 * Normalize an exact installation-owned bundle tuple to its shipped template
 * while preserving every other manifest field. Any other list is user-owned.
 */
function normalizeShippedProfile(name: string, dir: string, manifest: ProfileManifest): ProfileManifest {
  const installationOwned = INSTALLATION_OWNED_PROFILE_TUPLES[name]
  const current = PROFILE_TEMPLATES[name]
  const bundles = profileManifestSection(manifest)?.bundles
  if (installationOwned === undefined || current === undefined || bundles === undefined
    || !sameBundles(bundles, installationOwned)) return manifest
  const normalized = withProfileBundleState(
    manifest,
    current,
    profileManifestSection(manifest)?.disabledBundles ?? [],
  )
  writeProfileManifest(dir, normalized)
  return normalized
}

/**
 * Resolve a package's root directory from one anchor without depending on the
 * package exporting `./package.json` (`require.resolve` would need that):
 * probe the require resolution paths for a directory holding the named
 * manifest. This is Node's own node_modules lookup order, so the result
 * matches what the Loader would import from the same anchor, and
 * `existsSync` follows the symlinks pnpm's isolated layout uses.
 */
function packageDirFromAnchor(anchor: string, packageName: string): string | undefined {
  // resolve.paths returns null only for builtins, which no bundle name is.
  /* v8 ignore next */
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Resolve one bundle package's directory: installation anchor first, then the
 * profile directory. The installation-first order is the contract that
 * `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from
 * the same installation as the running worldline, never from a profile-local copy.
 * Resolution does not require the package to export `./package.json`.
 * @param binName - the diagnostic prefix on the thrown error.
 * @param packageName - the bundle's package name from `dsh.profile.bundles`.
 * @param installAnchor - absolute path of a file inside the worldline app package (its package.json).
 * @param profileDir - the profile directory (second anchor).
 * @returns the bundle package's absolute directory.
 */
export function resolveBundleDir(
  binName: string, packageName: string, installAnchor: string, profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the worldline installation or ${profileDir}; `
    + `run 'worldline plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}

/**
 * Load a profile: resolve every `dsh.profile.bundles` entry to its patch
 * layer and parse the profile's own patch file. A listed bundle without a
 * `dsh.bundle` manifest fails loud — naming a bundle-less package as a layer
 * is a misconfiguration, not "no patches".
 * @param binName - the diagnostic prefix on thrown errors.
 * @param name - the profile name.
 * @param installAnchor - absolute path of the worldline app's package.json (first resolution anchor).
 * @param home - the Worldline runtime home; defaults to {@link resolveWorldlineHome}.
 * @param options - `userLayer: false` skips reading `cordis.patch.yml`, so a
 * bundles-only consumer (`--dump-default-config`, a recovery diagnostic)
 * cannot fail on a broken user layer.
 * @returns the loaded profile (empty `patches` when the user layer is skipped).
 */
export function loadProfile(
  binName: string, name: string, installAnchor: string, home: string = resolveWorldlineHome(),
  options: { userLayer?: boolean } = {},
): Profile {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[name]
    if (template === undefined) {
      throw new Error(
        `${binName}: profile ${JSON.stringify(name)} does not exist; create it with 'worldline plugin --profile ${name} add <package>'`,
      )
    }
    initProfile(dir, template, PROFILE_PATCH_RELOAD[name] ?? DEFAULT_PROFILE_PATCH_RELOAD)
  }
  const migrated = migratePersistedProfile(dir, readProfileManifest(binName, dir))
  const manifest = normalizeShippedProfile(name, dir, migrated)
  const profileManifest = profileManifestSection(manifest)
  const bundles = profileManifest?.bundles ?? []
  const patchReload = profileManifest?.patchReload ?? DEFAULT_PROFILE_PATCH_RELOAD
  const layers = bundles.map((packageName): ProfileLayer => {
    const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
    const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ProfileManifest
    const declared = profileBundlePatch(bundleManifest)
    if (declared === undefined) {
      throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
    }
    const patchPath = join(packageDir, declared)
    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
  })
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patches = options.userLayer !== false && existsSync(patchPath)
    ? loadOverlayPatches(binName, patchPath)
    : []
  return { name, dir, layers, patchPath, patches, patchReload }
}

/**
 * Compose patch layers into the effective entry list over an empty root —
 * the same single `applyEntryPatches` call the boot include makes, so flag
 * derivation and config dumps see exactly what mounts.
 * @param layers - patch lists in application order.
 * @param warn - sink for skipped-patch diagnostics; defaults to silent (boot repeats them).
 * @returns the composed entry list.
 */
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
