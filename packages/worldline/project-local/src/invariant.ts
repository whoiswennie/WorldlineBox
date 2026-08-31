/** Package-owned invariant companion for the local Worldline project provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: traversal containment, optimistic revisions, durable
 * writes and archive safety are IO effects covered by provider tests.
 */
const install: InvariantInstaller = () => {}

export const name = 'worldline-project-local-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-project-local', install))
