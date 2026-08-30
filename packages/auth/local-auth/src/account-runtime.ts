/**
 * Shared account-runtime selection for the WebUI and Electron launchers.
 *
 * The authentication database remains global to the device, while settings,
 * credentials, sessions, plugins, and browser projections live below the
 * selected account's isolated runtime root.
 * @module @deepseek-ai/dsh-local-auth/account-runtime
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveWorldlineHome } from '@deepseek-ai/dsh-home-paths'

/** Exit code requesting an account-aware launcher to resolve the tenant again. */
export const ACCOUNT_RUNTIME_RESTART_EXIT_CODE = 75
/** Environment switch enabling the account boundary and restart handshake. */
export const WORLDLINE_ACCOUNT_MANAGED_ENV = 'WORLDLINE_ACCOUNT_MANAGED'
/** Selected local-account id exposed only to the managed Host process. */
export const WORLDLINE_ACCOUNT_ID_ENV = 'WORLDLINE_ACCOUNT_ID'
/** Global authentication root shared by every local client container. */
export const WORLDLINE_AUTH_HOME_ENV = 'WORLDLINE_AUTH_HOME'
/** Single-use launch proof exchanged for a container-local HttpOnly cookie. */
export const WORLDLINE_AUTH_BOOTSTRAP_TOKEN_ENV = 'WORLDLINE_AUTH_BOOTSTRAP_TOKEN'
/** URL-fragment key carrying the launch proof without sending it in the first GET. */
export const AUTH_BOOTSTRAP_FRAGMENT_KEY = 'worldline-auth-bootstrap'

/** One resolved account runtime and its per-launch authentication proof. */
export interface ManagedAccountLaunch {
  /** Environment applied to the child Host process. */
  environment: NodeJS.ProcessEnv
  /** Account-scoped runtime root selected for this generation. */
  accountHome: string
  /** Global authentication root shared by WebUI and Electron. */
  authHome: string
  /** Stable storage namespace injected into browser-side persisted stores. */
  tenant: string
  /** Active local account, absent for the signed-out quarantine runtime. */
  userId?: number
  /** Random single-use proof, present only when an active account exists. */
  bootstrapToken?: string
}

/**
 *  Read one valid positive account id from the device-global active marker.
 * @param authHome - auth home value.
 * @returns The resulting value.
 */
export async function readActiveAccountId(authHome: string): Promise<number | undefined> {
  try {
    const marker = JSON.parse(await readFile(join(authHome, 'active-account.json'), 'utf8')) as {
      userId?: unknown
    }
    if (Number.isSafeInteger(marker.userId) && Number(marker.userId) > 0) return Number(marker.userId)
  } catch {
    // Missing and malformed markers deliberately select the signed-out root.
  }
  return undefined
}

/** Read whether the active account opted into device-wide launcher handoff. */
async function autoLoginEnabled(authHome: string, userId: number): Promise<boolean> {
  try {
    const database = JSON.parse(await readFile(join(authHome, 'accounts.json'), 'utf8')) as {
      autoLoginUserIds?: unknown
    }
    // Older Worldline builds persisted the long-lived cookie but not the
    // preference bit. Preserve the already-active local account once during
    // migration; the Host writes an explicit list on its next initialization.
    if (database.autoLoginUserIds === undefined) return true
    return Array.isArray(database.autoLoginUserIds) && database.autoLoginUserIds.includes(userId)
  } catch {
    return false
  }
}

/**
 * Resolve one managed launch generation.
 *
 * Every call creates a fresh bootstrap token so a supervisor restart cannot
 * replay a proof captured from an earlier Host process.
 * @param baseHome - base home value.
 * @returns The resulting value.
 */
export async function createManagedAccountLaunch(
  baseHome = resolveWorldlineHome(),
): Promise<ManagedAccountLaunch> {
  const authHome = join(baseHome, 'auth')
  const userId = await readActiveAccountId(authHome)
  const tenant = userId === undefined ? 'signed-out' : `user-${userId}`
  const accountHome = join(baseHome, 'accounts', tenant)
  const bootstrapToken = userId !== undefined && await autoLoginEnabled(authHome, userId)
    ? randomBytes(32).toString('hex')
    : undefined
  return {
    accountHome,
    authHome,
    tenant,
    ...(userId === undefined ? {} : {
      userId,
      ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
    }),
    environment: {
      WORLDLINE_HOME: accountHome,
      WORLDLINE_AGENTS_HOME: join(accountHome, 'agents'),
      [WORLDLINE_AUTH_HOME_ENV]: authHome,
      [WORLDLINE_ACCOUNT_MANAGED_ENV]: '1',
      ...(userId === undefined ? {} : {
        [WORLDLINE_ACCOUNT_ID_ENV]: String(userId),
        ...(bootstrapToken === undefined ? {} : {
          [WORLDLINE_AUTH_BOOTSTRAP_TOKEN_ENV]: bootstrapToken,
        }),
      }),
    },
  }
}

/**
 *  Attach a launch proof as a fragment so it never reaches access logs or the initial GET.
 * @param url - url value.
 * @param token - token value.
 * @returns The resulting value.
 */
export function withAuthBootstrapFragment(url: string, token: string | undefined): string {
  if (token === undefined) return url
  const target = new URL(url)
  const fragment = new URLSearchParams(target.hash.slice(1))
  fragment.set(AUTH_BOOTSTRAP_FRAGMENT_KEY, token)
  target.hash = fragment.toString()
  return target.href
}
