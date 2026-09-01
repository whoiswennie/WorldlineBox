/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-worldline/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-worldline'
export const name = 'client-ui-worldline-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
