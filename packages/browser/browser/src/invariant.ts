/** Package-owned invariant companion for `@deepseek-ai/dsh-browser`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-browser'

export const name = 'browser-invariant'
export const inject = ['invariants']

/** No runtime invariant: this package declares a provider-owned capability only. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
