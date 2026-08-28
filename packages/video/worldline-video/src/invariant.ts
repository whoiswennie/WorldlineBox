import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-worldline-video'

export const name = 'worldline-video-invariant'
export const inject = ['invariants']

/** No runtime invariant: registrations are effect-scoped and own no durable runtime state. */
const install: InvariantInstaller = () => {}

/** Reserve invariant ownership for the package's effect-scoped registrations. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
