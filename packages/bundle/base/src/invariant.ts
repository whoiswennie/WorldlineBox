/** Package-owned invariant companion for the static base Bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-base'

export const name = 'base-bundle-invariant'
export const inject = ['invariants']

// The package only carries a static patch list. Every mounted row is validated
// by the invariant companion of the package that owns that row.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
