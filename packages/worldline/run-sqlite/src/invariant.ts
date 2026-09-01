/** Package-owned invariant companion for the Worldline Run SQLite store. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/**
 * No runtime invariant: single-writer ownership, transactions, WAL recovery
 * and append continuity are storage effects covered by package tests.
 */
const install: InvariantInstaller = () => {}

export const name = 'worldline-run-sqlite-invariant'
export const inject = ['invariants']
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-worldline-run-sqlite', install))
