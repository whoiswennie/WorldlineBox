/** Public account fields safe to retain in the browser authentication store. */
export interface AuthUser {
  id: number
  username: string
  createdAt: number
  lastLoginAt: number | null
  displayName: string
  avatar: string
  bio: string
}

/**
 * Replace the active account and matching saved-account row.
 * @param user - authoritative account snapshot returned by the Host.
 */
export function replaceAuthUser(user: AuthUser): void {
  setAuthSnapshot({
    ...snapshot,
    user,
    savedAccounts: snapshot.savedAccounts.map(account => account.id === user.id ? user : account),
    error: '',
  })
}

/** Complete observable authentication state for the current browser surface. */
export interface AuthSnapshot {
  loading: boolean
  user: AuthUser | null
  savedAccounts: AuthUser[]
  error: string
}

let snapshot: AuthSnapshot = { loading: true, user: null, savedAccounts: [], error: '' }
const listeners = new Set<() => void>()

/**
 * Read the authentication state used by React external-store consumers.
 * @returns the current immutable-by-convention authentication snapshot.
 */
export function getAuthSnapshot(): AuthSnapshot { return snapshot }
/**
 * Subscribe to authentication snapshot replacement.
 * @param listener - synchronous invalidation callback.
 * @returns the disposer removing the listener.
 */
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
/**
 * Publish one complete authentication snapshot.
 * @param next - replacement snapshot.
 */
export function setAuthSnapshot(next: AuthSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

export interface ApiResponse {
  ok: boolean
  user?: AuthUser | null
  savedAccounts?: AuthUser[]
  error?: string
  /** Managed Host is switching its account runtime after this response flushes. */
  restart?: boolean
}

const AUTH_BOOTSTRAP_FRAGMENT_KEY = 'worldline-auth-bootstrap'

/**
 * Call one same-origin local-auth endpoint and validate its common envelope.
 * @param path - endpoint suffix below `/worldline-auth/`.
 * @param body - optional JSON request body.
 * @returns the successful response envelope.
 */
export async function authRequest(path: string, body?: Record<string, unknown>): Promise<ApiResponse> {
  const response = await fetch(`/worldline-auth/${path}`, body === undefined ? undefined : {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json() as ApiResponse
  if (!response.ok || !data.ok) throw new Error(data.error ?? '账号请求失败')
  return data
}

/** Remove and return the launch proof before any navigation or diagnostic can retain it. */
export function consumeAuthBootstrapToken(): string | undefined {
  if (typeof location === 'undefined' || typeof history === 'undefined') return undefined
  const fragment = new URLSearchParams(location.hash.slice(1))
  const token = fragment.get(AUTH_BOOTSTRAP_FRAGMENT_KEY) ?? undefined
  if (token === undefined) return undefined
  fragment.delete(AUTH_BOOTSTRAP_FRAGMENT_KEY)
  const suffix = fragment.size === 0 ? '' : `#${fragment.toString()}`
  history.replaceState(history.state, '', `${location.pathname}${location.search}${suffix}`)
  return /^[a-f\d]{64}$/u.test(token) ? token : undefined
}

/** Exchange an optional launcher proof, then load the authoritative Host snapshot. */
export async function initializeAuth(): Promise<void> {
  const token = consumeAuthBootstrapToken()
  let bootstrapError = ''
  if (token !== undefined) {
    try {
      await authRequest('bootstrap', { token })
    } catch (error) {
      bootstrapError = error instanceof Error ? error.message : String(error)
    }
  }
  await refreshAuth()
  if (bootstrapError !== '' && snapshot.user === null) {
    setAuthSnapshot({ ...snapshot, error: bootstrapError })
  }
}

/** Options injectable by focused tests around the managed-runtime reconnect loop. */
export interface ManagedRestartOptions {
  attempts?: number
  initialDelayMs?: number
  retryDelayMs?: number
  request?: typeof fetch
  wait?: (milliseconds: number) => Promise<void>
  reload?: () => void
}

/** Wait for the replacement Host generation before reloading the current client container. */
export async function reloadAfterManagedRestart(options: ManagedRestartOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 80
  const request = options.request ?? fetch
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  await wait(options.initialDelayMs ?? 500)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await request('/worldline-auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (response.ok) {
        const reload = options.reload ?? (() => { location.reload() })
        reload()
        return
      }
    } catch {
      // The old generation is down; continue until the supervisor rebinds.
    }
    await wait(options.retryDelayMs ?? 250)
  }
  throw new Error('账户运行时重启超时，请重新启动世界线。')
}

/** Refresh the complete authentication state while containing transport errors in the store. */
export async function refreshAuth(): Promise<void> {
  try {
    const data = await authRequest('session')
    setAuthSnapshot({ loading: false, user: data.user ?? null, savedAccounts: data.savedAccounts ?? [], error: '' })
  } catch (error) {
    setAuthSnapshot({ loading: false, user: null, savedAccounts: [], error: error instanceof Error ? error.message : String(error) })
  }
}
