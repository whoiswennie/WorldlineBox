/** Shared Profile mutation helpers for explicit local CLI package operations. */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  profileBundlePatch,
  readProfileManifest,
  reconcileProfileBundles,
  resolveBundleDir,
  writeProfileManifest,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'

const NAME = 'worldline'
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

function exportsPatch(packageName: string, profileDir: string): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
  } catch {
    return false
  }
  return profileBundlePatch(readProfileManifest(NAME, dir)) !== undefined
}

/** Reconcile native and upstream bundle dependencies into the durable Profile. */
export function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const reconciled = reconcileProfileBundles(
    before,
    after,
    packageName => exportsPatch(packageName, profileDir),
  )
  for (const packageName of reconciled.addedPlainDependencies) {
    process.stderr.write(
      `${NAME}: warning: ${packageName} declares no dsh.bundle or dsh.bundle — installed as a plain dependency, not a profile layer `
      + '(a later update that gains one activates it automatically)\n',
    )
  }
  if (reconciled.changed) writeProfileManifest(profileDir, reconciled.manifest)
}

/** Anchor relative package specs to the directory from which the user invoked the operation. */
export function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${resolve(cwd, match.groups.path)}`
}
