/** Package-owned invariant companion for the optional workspace tool adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-workspace'

/** Cordis companion plugin name. */
export const name = 'tool-workspace-invariant'
/** Service required before the package can reserve its invariant ownership. */
export const inject = ['invariants']

/**
 * No independent runtime invariant: tool schema, execution, and disposal
 * relationships are enforced by the shared ToolRuntime registry.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
