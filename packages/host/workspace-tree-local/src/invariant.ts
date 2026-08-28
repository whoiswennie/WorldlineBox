/** Package-owned invariant companion for the local Workspace Tree Provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: traversal limits are enforced synchronously per
 * request and watcher lifecycle is owned by Cordis effects in the Provider.
 */
const install: InvariantInstaller = () => {}
export const name = 'host-workspace-tree-local-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-host-workspace-tree-local', install))
