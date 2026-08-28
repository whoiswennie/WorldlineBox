/** Package-owned invariant companion for the deterministic LLM replay adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-replay'

export const name = 'llm-replay-invariant'
export const inject = ['invariants']

// Replay consumes a fixed script. Stream grammar belongs to the LLM seam and
// fixture derivation belongs to the snapshot harness.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
