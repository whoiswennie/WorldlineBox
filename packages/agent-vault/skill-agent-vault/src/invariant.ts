/** Package-owned invariant companion for Agent Vault methodology skills. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-skill-agent-vault'
export const name = 'skill-agent-vault-invariant'
export const inject = ['invariants']
/** No runtime invariant: the provider is immutable and the skill registry owns lifecycle disposal. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
