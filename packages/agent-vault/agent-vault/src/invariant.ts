/** Package-owned invariant companion for Agent Vault. @module @deepseek-ai/dsh-agent-vault/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-vault'
export const name = 'agent-vault-invariant'
export const inject = ['invariants']
/** No runtime invariant: providers enforce revision, domain, and permission decisions at commit time. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
