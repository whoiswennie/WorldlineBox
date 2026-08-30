/**
 * Shared profile boot for every `worldline` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  reapplyBootPatches,
  PROFILE_PATCH_FILENAME,
  watchUserPatches,
  type Profile,
  type LocalExtensionState,
} from '@deepseek-ai/dsh-app-boot'
import { resolveWorldlineHome } from '@deepseek-ai/dsh-home-paths'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { WORLDLINE_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'worldline'

/** Gate stdio EOF shutdown until the complete Worldline profile boot commits. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

// Cordis exposes FiberState as a const enum, so source-mode execution has no
// runtime object to import. Keep the single value this launcher needs as an
// inlining-safe mirror (the same boundary used by app-boot).
const FIBER_ACTIVE = 2 as FiberState.ACTIVE

/**
 * The home-level user patch layer (`$WORLDLINE_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$WORLDLINE_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveWorldlineHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this worldline installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the WORLDLINE_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The community browser provider row whose optional Host seam Desktop binds. */
const DESKTOP_BROWSER_PROVIDER_ROW_ID = 'browser-electron'
const DESKTOP_BROWSER_PROVIDER_NAME = 'dsh-builtin-browser/browser-electron'
const DESKTOP_BROWSER_HOST_SERVICE = 'electronViewHost'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# worldline profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'
/** Local-only management state; it is separate from hand-authored Cordis patches. */
export const LOCAL_EXTENSIONS_FILENAME = 'local-extensions.json'

const EMPTY_LOCAL_EXTENSIONS: LocalExtensionState = {
  disabledPlugins: [],
  removedPlugins: [],
  disabledSkills: [],
}
// Loader descendants are addressed as colon-delimited entry paths
// (`include:gal-view`, `include:agent-presets:tool-goal`). Each segment keeps
// the same conservative local-id alphabet; separators cannot form paths.
const LOCAL_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u

function uniqueLocalIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && LOCAL_ID.test(item)))].sort()
    : []
}

/** Read and validate one Profile's local extension preferences. */
export function readLocalExtensionState(profileDirectory: string): LocalExtensionState {
  try {
    const value = JSON.parse(readFileSync(join(profileDirectory, LOCAL_EXTENSIONS_FILENAME), 'utf8')) as Record<string, unknown>
    return normalizeLocalExtensionState(value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return EMPTY_LOCAL_EXTENSIONS
    throw new Error(`worldline: failed to read local extension state: ${String(error)}`)
  }
}

/** Normalize renderer-independent local management state. */
export function normalizeLocalExtensionState(value: Partial<LocalExtensionState>): LocalExtensionState {
  const removedPlugins = uniqueLocalIds(value.removedPlugins)
  const removed = new Set(removedPlugins)
  return {
    disabledPlugins: uniqueLocalIds(value.disabledPlugins).filter(id => !removed.has(id)),
    removedPlugins,
    disabledSkills: uniqueLocalIds(value.disabledSkills),
  }
}

/** Convert local plugin preferences into the final composition layer. */
export function localExtensionPatches(state: LocalExtensionState): PatchOptions[] {
  const patchId = (runtimeId: string): string => runtimeId.startsWith('include:')
    ? runtimeId.slice('include:'.length)
    : runtimeId
  return [
    ...state.disabledPlugins.map(id => ({ id: patchId(id), disabled: true })),
    ...state.removedPlugins.map(id => ({ id: patchId(id), removed: true })),
  ]
}

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `WORLDLINE_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Make the community browser provider wait for Desktop's embedded view Host.
 *
 * The provider deliberately treats a missing `viewHost` as permission to
 * launch its own Electron window. Loader rows mount concurrently, so its
 * optional `ctx.get('electronViewHost')` expression can otherwise run before
 * the project's Host adapter publishes that service. This launch-only patch
 * turns the optional seam into a hard ordering edge in Desktop while leaving
 * ordinary Web profiles (where the provider's own-window fallback is useful)
 * unchanged.
 *
 * This is a composition overlay: it neither edits nor forks the installed
 * community package.
 */
export function resolveDesktopBrowserHostPatch(
  environment: LaunchEnvironmentSnapshot,
  row: EntryOptions | undefined,
): PatchOptions | undefined {
  const url = environment.get('WORLDLINE_DESKTOP_BROWSER_BRIDGE_URL')?.value
  const token = environment.get('WORLDLINE_DESKTOP_BROWSER_BRIDGE_TOKEN')?.value
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(url ?? '') || (token?.length ?? 0) < 32) return undefined
  // Keep the target patch in the Desktop composition even before the package
  // is installed. Profile reconciliation reuses launch overlays, so a later
  // later explicit local package install receives the same ordering edge on its first mount.
  // An already-present row must still be the provider we explicitly support.
  if (row !== undefined && row.name !== DESKTOP_BROWSER_PROVIDER_NAME) return undefined
  const current: string[] = []
  if (Array.isArray(row?.inject)) {
    for (const name of row.inject) {
      if (typeof name === 'string') current.push(name)
    }
  }
  return {
    id: DESKTOP_BROWSER_PROVIDER_ROW_ID,
    inject: [...new Set([...current, DESKTOP_BROWSER_HOST_SERVICE])],
  }
}

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$WORLDLINE_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Machine-local extension enablement/removal layer. */
  localExtensions: LocalExtensionState
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
  /**
   * id → row of the composed tree (bundles + user layers + overlays), for the
   * launcher's own row checks.
   */
  rows: ReadonlyMap<string, EntryOptions>
}

/** The full patch stack of one composed profile, in application order. */
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...localExtensionPatches(composed.localExtensions),
    ...composed.overlays,
  ]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$WORLDLINE_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 */
function composeProfile(
  name: string,
  patchFiles: readonly string[],
  environment: LaunchEnvironmentSnapshot,
): ComposedProfile {
  const profile = prepareProfile(name)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const localExtensions = readLocalExtensionState(profile.dir)
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  // The SHIPPED root is the part of the roster only this app can resolve: it
  // sits beside this app's own config, in both the source and built layouts.
  // The writable root the roster appends is `worldline-agent-presets`' own, so a
  // launcher that never reaches this patch still finds a person's presets.
  if (rows.has('agent-presets')) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const desktopBrowserHostPatch = resolveDesktopBrowserHostPatch(
    environment,
    rows.get(DESKTOP_BROWSER_PROVIDER_ROW_ID),
  )
  if (desktopBrowserHostPatch !== undefined) composedOverlays.push(desktopBrowserHostPatch)
  const telemetryPatch = resolveTelemetryPatch(process.env.WORLDLINE_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return { profile, bundlePatches, homePatches, localExtensions, overlays: composedOverlays, rows }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FIBER_ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const composed = composeProfile(options.profile, options.patchFiles, options.environment)
  let liveBundlePatches = composed.bundlePatches
  let runningBundles = composed.profile.layers.map(layer => layer.packageName)
  const app: { current?: Context } = {}
  const appReady = createAppReady()
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // Recomposition for the live user layers: bundle layers below, overlays
  // above, so a user edit can never displace them. Parsed app arguments are
  // not in here at all — they live in app-provided services that survive a
  // recomposition. BOTH
  // user files are re-read per generation (the HMR watcher hands us only the
  // changed file's patches, which one of the reads duplicates — fresh reads
  // keep the two watchers from stitching in each other's stale copy).
  // Fresh clones per generation: the include pushes `insert` rows into the
  // mounted tree BY REFERENCE and later id-targeted patches mutate those
  // objects in place. Reusing one parsed patch object across applications
  // would bake a user override into the bundle's in-memory insert row, so
  // removing the override could never revert the row to the bundle default.
  const composeLive = (): PatchOptions[] => structuredClone([
    ...liveBundlePatches,
    ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
    ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
    ...localExtensionPatches(readLocalExtensionState(composed.profile.dir)),
    ...composed.overlays,
  ])
  // Cloned for the same insert-aliasing reason as composeLive: the boot
  // application must not mutate the objects later reloads recompose from.
  const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), (hostCtx) => {
    app.current = hostCtx
    // Before any config-tree entry mounts, so plugins resolve all launch-time
    // environment values from the same immutable provenance snapshot.
    hostCtx.provide(WORLDLINE_LAUNCH_ENVIRONMENT_KEY, options.environment)
    // The command line and bounded exit request are launcher facts available
    // to every app plugin that injects the argument snapshot.
    provideCmdline(hostCtx, {
      args: options.args,
      exit: code => void shutdown.shutdown(code),
      ready: appReady.service,
    })
    let reconciliation = Promise.resolve<readonly string[]>(runningBundles)
    let extensionUpdate = Promise.resolve()
    hostCtx.provide('profileRuntime', {
      bundles: () => [...runningBundles],
      localExtensions: () => structuredClone(composed.localExtensions),
      updateLocalExtensions: (state: LocalExtensionState) => {
        extensionUpdate = extensionUpdate.then(async () => {
          const normalized = normalizeLocalExtensionState(state)
          await writeFileAtomic(
            join(composed.profile.dir, LOCAL_EXTENSIONS_FILENAME),
            `${JSON.stringify(normalized, null, 2)}\n`,
            { mode: 0o600, dirMode: 0o700 },
          )
          composed.localExtensions = normalized
          await reapplyBootPatches(hostCtx, composeLive())
        })
        return extensionUpdate
      },
      reconcile: () => {
        const next = reconciliation.then(async () => {
          // Re-resolve from the Profile directory after pnpm and the manifest
          // transaction have settled. The Include update owns Cordis disposal,
          // replacement, injection ordering, and rollback on a failed candidate.
          const profile = loadProfile(NAME, options.profile, INSTALL_ANCHOR)
          const bundlePatches = profile.layers.flatMap(layer => layer.patches)
          await reapplyBootPatches(hostCtx, [
            ...bundlePatches,
            ...loadOptionalPatches(NAME, profile.patchPath) ?? [],
            ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
            ...localExtensionPatches(readLocalExtensionState(composed.profile.dir)),
            ...composed.overlays,
          ])
          liveBundlePatches = bundlePatches
          runningBundles = profile.layers.map(layer => layer.packageName)
          return [...runningBundles]
        })
        // A rejected generation must not poison later repair attempts.
        reconciliation = next.catch(() => [...runningBundles])
        return next
      },
    })
  })
  app.current = ctx
  // A surface can dispose the whole tree while boot or this post-boot watcher
  // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
  // presence and fiber state own liveness; the initial check skips a tree
  // that already exited, and the catch below re-checks for an exit that
  // landed mid-setup. Watching is unconditional: a one-shot surface exits
  // through its bounded shutdown, which disposes the watchers before the
  // loop drains.
  if (composed.profile.patchReload === 'live'
    && !signalShutdown.signal.aborted
    && ctx.fiber.state === FIBER_ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: the web bundle
      // disables the shared module-reload `hmr` row (its reload lifecycle is
      // untested), so when the composition leaves no HMR service, mount a
      // watch-only instance with no module roots — cordis.patch.yml edits stay
      // live on every long-lived surface. A silent skip would break the
      // documented hot-reload contract. HMR injects the timer service, which a
      // bare custom profile may not mount either.
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: composed.profile.patchPath,
        compose: composeLive,
      })
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        compose: composeLive,
      })
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FIBER_ACTIVE
    && ctx.get('loader') !== undefined) {
    appReady.commit()
  }
  return { ctx, shutdown }
}
