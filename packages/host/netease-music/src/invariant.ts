/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-netease-music/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-netease-music'
export const name = 'host-netease-music-invariant'
export const inject = ['invariants']

/** No runtime invariant: the Remote service owns only a short-lived upstream response cache. */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
