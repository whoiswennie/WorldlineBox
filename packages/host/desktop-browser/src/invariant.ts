/** Package-owned invariant companion for the desktop browser Host adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const install: InvariantInstaller = () => {}
export const name = 'host-desktop-browser-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-host-desktop-browser', install))
