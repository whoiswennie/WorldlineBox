/** Package-owned invariant companion for the Worldline compiler. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: compilation is snapshot-pure and freeze eligibility
 * is recalculated before every immutable build commit.
 */
const install: InvariantInstaller = () => {}

export const name = 'worldline-compiler-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-compiler', install))
