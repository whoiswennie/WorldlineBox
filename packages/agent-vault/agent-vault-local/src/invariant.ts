/** Package-owned invariant companion for the local Agent Vault provider. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-agent-vault-local'
export const name = 'agent-vault-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: filesystem commits and index derivation are verified by provider tests. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
