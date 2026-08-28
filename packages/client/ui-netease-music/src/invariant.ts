/** Package-owned invariant companion for the NetEase playlist surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-netease-music'
export const name = 'client-ui-netease-music-invariant'
export const inject = ['invariants']

/** No runtime invariant: the slot registry owns the root-scoped contribution and its disposal. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
