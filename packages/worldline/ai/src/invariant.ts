/** Package-owned invariant companion for bounded Worldline AI calls. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** No runtime invariant: every call validates its routed model capacity immediately before IO. */
const install: InvariantInstaller = () => {}

export const name = 'worldline-ai-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-ai', install))
