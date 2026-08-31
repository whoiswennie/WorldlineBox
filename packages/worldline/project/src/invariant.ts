/** Package-owned invariant companion for the Worldline project capability seam. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: this package owns only the stateless service and wire
 * vocabulary; storage providers own filesystem state and mutation ordering.
 */
const install: InvariantInstaller = () => {}

export const name = 'worldline-project-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-project', install))
