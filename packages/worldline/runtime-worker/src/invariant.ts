/** Package-owned invariant companion for the Worker-thread Worldline Runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: queue order, single-writer ownership, event validity,
 * replay and recovery are asserted inside the Worker and by integration tests.
 */
const install: InvariantInstaller = () => {}

export const name = 'worldline-runtime-worker-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-runtime-worker', install))
