/** Package-owned invariant companion for the portable Worldline World Standard. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: WWS values are immutable portable data and their
 * relations are checked by the exported deterministic validators.
 */
const install: InvariantInstaller = () => {}

export const name = 'worldline-standard-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-standard', install))
