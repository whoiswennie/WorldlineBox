/** Package-owned invariant companion for the Worldline Run service seam. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: this package owns the wire vocabulary; the Worker
 * provider owns queue, transaction and process lifecycle observations.
 */
const install: InvariantInstaller = () => {}

export const name = 'worldline-runtime-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-runtime', install))
