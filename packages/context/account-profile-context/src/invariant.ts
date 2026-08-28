/** Package-owned invariant companion for account profile context. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-account-profile-context'
export const name = 'account-profile-context-invariant'
export const inject = ['invariants']

/** No runtime invariant: the prompt registry owns scoped registration and disposal. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
