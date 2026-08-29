/** Package-owned invariant companion for Agent Vault model tools. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-tool-agent-vault'
export const name = 'tool-agent-vault-invariant'
export const inject = ['invariants']
/** No runtime invariant: tool execution delegates all authority and commits to the Agent Vault service. */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
