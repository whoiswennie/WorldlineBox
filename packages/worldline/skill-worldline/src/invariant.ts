import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const install: InvariantInstaller = () => {}

export const name = 'skill-worldline-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-skill-worldline', install))
