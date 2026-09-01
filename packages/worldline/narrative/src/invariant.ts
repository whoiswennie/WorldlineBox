/** Package-owned invariant companion for Worldline narrative projection. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** No runtime invariant: beat commits verify their exact source records and model invocation. */
const install: InvariantInstaller = () => {}

export const name = 'worldline-narrative-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-narrative', install))
