import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountProfile } from '@deepseek-ai/dsh-account-profile'
import { worldlineHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ACCOUNT_RUNTIME_RESTART_EXIT_CODE,
  WORLDLINE_ACCOUNT_ID_ENV,
  WORLDLINE_ACCOUNT_MANAGED_ENV,
  WORLDLINE_AUTH_BOOTSTRAP_TOKEN_ENV,
  WORLDLINE_AUTH_HOME_ENV,
} from './account-runtime.ts'

export {
  ACCOUNT_RUNTIME_RESTART_EXIT_CODE,
  AUTH_BOOTSTRAP_FRAGMENT_KEY,
  createManagedAccountLaunch,
  readActiveAccountId,
  withAuthBootstrapFragment,
  WORLDLINE_ACCOUNT_ID_ENV,
  WORLDLINE_ACCOUNT_MANAGED_ENV,
  WORLDLINE_AUTH_BOOTSTRAP_TOKEN_ENV,
  WORLDLINE_AUTH_HOME_ENV,
} from './account-runtime.ts'
export type { ManagedAccountLaunch } from './account-runtime.ts'

export const name = 'worldline-local-auth'
export const inject = ['webServer']

const scrypt = promisify(scryptCallback)
const PASSWORD_PREFIX = 'scrypt-v1'
const PASSWORD_BYTES = 64
const SESSION_COOKIE = 'worldline_session'
const SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const BODY_LIMIT = 3 * 1_024 * 1_024
const AVATAR_LIMIT = 2 * 1_024 * 1_024
const ACTIVE_ACCOUNT_FILE = 'active-account.json'
const MAX_SESSIONS_PER_ACCOUNT = 16

/** Storage roots and legacy migration controls for local authentication. */
export interface Config {
  /** Authentication data directory. Defaults to the Worldline home directory. */
  root?: string
  /** Explicit legacy SQLite path, false to disable migration, or undefined for auto-discovery. */
  legacyDatabasePath?: string | false
}

interface AccountRecord {
  id: number
  username: string
  usernameKey: string
  passwordHash: string
  createdAt: number
  lastLoginAt: number | null
  displayName?: string
  avatar?: string
  bio?: string
}

interface SessionRecord {
  tokenHash: string
  userId: number
  expiresAt: number
}

interface AuthDatabase {
  version: 1
  nextUserId: number
  accounts: AccountRecord[]
  savedUserIds: number[]
  autoLoginUserIds: number[]
  sessions: SessionRecord[]
}

/** Account projection safe to expose to the authenticated local browser. */
export interface PublicUser {
  id: number
  username: string
  createdAt: number
  lastLoginAt: number | null
  displayName: string
  avatar: string
  bio: string
}

/** Current account plus remembered accounts for the login surface. */
export interface AuthSnapshot {
  user: PublicUser | null
  savedAccounts: PublicUser[]
}

const emptyDatabase = (): AuthDatabase => ({
  version: 1,
  nextUserId: 1,
  accounts: [],
  savedUserIds: [],
  autoLoginUserIds: [],
  sessions: [],
})

class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

function publicUser(account: AccountRecord): PublicUser {
  return {
    id: account.id,
    username: account.username,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
    displayName: account.displayName?.trim() || account.username,
    avatar: account.avatar ?? '',
    bio: account.bio ?? '',
  }
}

function normalizedUsername(value: unknown): { display: string; key: string } {
  const display = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (display.length < 3 || display.length > 32) throw new AuthError('用户名长度应为 3 到 32 个字符')
  if (/[\u0000-\u001f\u007f]/u.test(display)) throw new AuthError('用户名包含不可用字符')
  return { display, key: display.toLocaleLowerCase('zh-CN') }
}

function validatedPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new AuthError('密码不能为空且不能超过 256 个字符')
  }
  return value
}

function validatedProfile(body: Record<string, unknown>): Pick<AccountRecord, 'displayName' | 'avatar' | 'bio'> {
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim().replace(/\s+/g, ' ') : ''
  if (displayName.length < 1 || displayName.length > 80) throw new AuthError('显示名称长度应为 1 到 80 个字符')
  if (/[\u0000-\u001f\u007f]/u.test(displayName)) throw new AuthError('显示名称包含不可用字符')
  const bio = typeof body.bio === 'string' ? body.bio.trim() : ''
  if (bio.length > 2_000) throw new AuthError('个人信息不能超过 2,000 个字符')
  const avatar = typeof body.avatar === 'string' ? body.avatar : ''
  if (avatar !== '') {
    if (!/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/]+=*$/iu.test(avatar)) throw new AuthError('头像格式无效')
    if (Buffer.byteLength(avatar, 'utf8') > AVATAR_LIMIT) throw new AuthError('裁剪后的头像不能超过 2 MB')
  }
  return { displayName, avatar, bio }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32)
  const hash = await scrypt(password, salt, PASSWORD_BYTES) as Buffer
  return `${PASSWORD_PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`
}

async function verifyPassword(password: string, record: string): Promise<boolean> {
  const [prefix, saltHex, hashHex] = record.split('$')
  if (prefix !== PASSWORD_PREFIX || !/^[a-f\d]{64}$/iu.test(saltHex ?? '') || !/^[a-f\d]{128}$/iu.test(hashHex ?? '')) return false
  const expected = Buffer.from(hashHex ?? '', 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex ?? '', 'hex'), expected.length) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Compare one fixed-width hexadecimal launch proof without a timing oracle. */
function matchesBootstrapToken(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string' || !/^[a-f\d]{64}$/u.test(candidate) || !/^[a-f\d]{64}$/u.test(expected)) {
    return false
  }
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'))
}

function cookieToken(req: IncomingMessage): string | undefined {
  const match = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`))
  if (match === undefined) return undefined
  const token = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1))
  return /^[a-f\d]{64}$/u.test(token) ? token : undefined
}

function setSessionCookie(res: ServerResponse, token: string, persistent: boolean): void {
  const age = persistent ? `; Max-Age=${Math.floor(SESSION_AGE_MS / 1_000)}` : ''
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${age}`)
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
}

function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined || host === undefined) return
  if (new URL(origin).host !== host) throw new AuthError('请求来源校验失败', 403)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    if (length > BODY_LIMIT) throw new AuthError('请求内容过大', 413)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AuthError('请求格式无效')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuthError('请求格式无效')
  return parsed as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  })
  res.end(JSON.stringify(value))
}

function legacyPath(config: Config): string | undefined {
  if (config.legacyDatabasePath === false) return undefined
  if (typeof config.legacyDatabasePath === 'string') return config.legacyDatabasePath
  const appData = process.env.APPDATA
  return appData === undefined ? undefined : join(appData, 'WorldlineFantasy', '.worldline-fantasy-data', 'database.sqlite')
}

/** Serialized file-backed account, credential, and session store. */
export class LocalAuthStore {
  private readonly directory: string
  private readonly file: string
  private readonly legacyFile: string | undefined
  private readonly activeAccountFile: string
  private data = emptyDatabase()
  private mutation = Promise.resolve()
  /** Initialization barrier covering load, legacy migration, and first save. */
  readonly ready: Promise<void>

  constructor(private readonly logger: Context['logger'], config: Config = {}) {
    this.directory = config.root ?? process.env[WORLDLINE_AUTH_HOME_ENV] ?? worldlineHomePath('auth')
    this.file = join(this.directory, 'accounts.json')
    this.activeAccountFile = join(this.directory, ACTIVE_ACCOUNT_FILE)
    this.legacyFile = legacyPath(config)
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    try {
      const candidate = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AuthDatabase>
      if (
        candidate.version !== 1
        || !Array.isArray(candidate.accounts)
        || !Array.isArray(candidate.savedUserIds)
        || !Array.isArray(candidate.sessions)
      ) {
        throw new Error('账户数据库结构无效')
      }
      let autoLoginUserIds: number[]
      if (Array.isArray(candidate.autoLoginUserIds)) {
        autoLoginUserIds = candidate.autoLoginUserIds.filter(Number.isSafeInteger)
      } else {
        // Compatibility with builds that persisted a long-lived cookie but not
        // its preference bit: retain only the currently active local account.
        try {
          const marker = JSON.parse(await readFile(this.activeAccountFile, 'utf8')) as { userId?: unknown }
          autoLoginUserIds = Number.isSafeInteger(marker.userId) ? [Number(marker.userId)] : []
        } catch {
          autoLoginUserIds = []
        }
      }
      this.data = {
        version: 1,
        nextUserId: Number.isSafeInteger(candidate.nextUserId) ? Number(candidate.nextUserId) : 1,
        accounts: candidate.accounts,
        savedUserIds: candidate.savedUserIds,
        autoLoginUserIds,
        sessions: candidate.sessions,
      }
    } catch {
      this.data = emptyDatabase()
    }
    this.data.sessions = this.data.sessions.filter(session => session.expiresAt > Date.now())
    if (this.data.accounts.length === 0) await this.migrateLegacyAccounts()
    await this.save()
  }

  private async migrateLegacyAccounts(): Promise<void> {
    if (this.legacyFile === undefined) return
    try {
      if (!(await stat(this.legacyFile)).isFile()) return
      const sqlite = await import('node:sqlite')
      const database = new sqlite.DatabaseSync(this.legacyFile, { readOnly: true })
      try {
        const rows = database.prepare('SELECT id, username, username_key, password_hash, created_at, last_login_at FROM local_users ORDER BY id').all() as Array<Record<string, unknown>>
        const saved = database.prepare('SELECT user_id FROM saved_local_accounts ORDER BY last_used_at DESC').all() as Array<Record<string, unknown>>
        this.data.accounts = rows.map(row => ({
          id: Number(row.id),
          username: String(row.username),
          usernameKey: String(row.username_key),
          passwordHash: String(row.password_hash),
          createdAt: Number(row.created_at),
          lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
        }))
        this.data.savedUserIds = saved.map(row => Number(row.user_id)).filter(Number.isSafeInteger)
        this.data.nextUserId = Math.max(0, ...this.data.accounts.map(account => account.id)) + 1
        if (rows.length > 0) this.logger.info(`已迁移 ${rows.length} 个本地账户`)
      } finally {
        database.close()
      }
    } catch (error) {
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async save(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.file)
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutation.then(operation, operation)
    this.mutation = pending.then(() => undefined, () => undefined)
    return pending
  }

  private accountBySession(req: IncomingMessage): AccountRecord | undefined {
    const token = cookieToken(req)
    if (token === undefined) return undefined
    const hash = tokenHash(token)
    const session = this.data.sessions.find(candidate => candidate.tokenHash === hash && candidate.expiresAt > Date.now())
    return session === undefined ? undefined : this.data.accounts.find(account => account.id === session.userId)
  }

  /**
   * Authenticate an API/upgrade request against the active desktop tenant.
   * @param req - incoming request carrying the HttpOnly session cookie.
   * @param expectedUserId - optional desktop tenant identity that must match.
   * @returns the public account projection, or undefined when authentication fails.
   */
  authenticatedUser(req: IncomingMessage, expectedUserId?: number): PublicUser | undefined {
    const account = this.accountBySession(req)
    if (account === undefined || (expectedUserId !== undefined && account.id !== expectedUserId)) return undefined
    return publicUser(account)
  }

  /**
   * Read one public profile without exposing credentials or browser sessions.
   * The store starts empty and becomes available after its initialization read.
   * @param userId - local account identifier to look up.
   * @returns the browser-safe public profile, or undefined when it is unavailable.
   */
  profile(userId: number): PublicUser | undefined {
    const account = this.data.accounts.find(candidate => candidate.id === userId)
    return account === undefined ? undefined : publicUser(account)
  }

  private async setActiveAccount(userId: number | null): Promise<void> {
    if (userId === null) {
      await rm(this.activeAccountFile, { force: true })
      return
    }
    const temporary = `${this.activeAccountFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify({ userId })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.activeAccountFile)
  }

  /**
   * Read the current and remembered accounts for one browser session.
   * @param req - incoming request carrying the optional session cookie.
   * @returns the browser-safe authentication snapshot.
   */
  async snapshot(req: IncomingMessage): Promise<AuthSnapshot> {
    await this.ready
    const account = this.accountBySession(req)
    return {
      user: account === undefined ? null : publicUser(account),
      savedAccounts: this.data.savedUserIds
        .map(id => this.data.accounts.find(accountRecord => accountRecord.id === id))
        .filter((value): value is AccountRecord => value !== undefined)
        .map(publicUser),
    }
  }

  /**
   * Repair a missing or stale desktop active-account marker from the
   * authenticated browser session. The API guard remains closed until the
   * supervisor restarts into the repaired tenant, so recovery never serves
   * account data from the signed-out or wrong-account runtime root.
   * @param req - authenticated browser request.
   * @param expectedUserId - tenant currently serving this desktop process.
   * @returns the repaired account id, or undefined when no repair is needed.
   */
  async synchronizeActiveAccount(req: IncomingMessage, expectedUserId?: number): Promise<number | undefined> {
    await this.ready
    return this.exclusive(async () => {
      const account = this.accountBySession(req)
      if (account === undefined || account.id === expectedUserId) return undefined
      await this.setActiveAccount(account.id)
      return account.id
    })
  }

  private async createSession(account: AccountRecord, remember: boolean, autoLogin: boolean, res: ServerResponse): Promise<void> {
    const token = randomBytes(32).toString('hex')
    this.data.sessions = this.data.sessions.filter(session => session.expiresAt > Date.now())
    const accountSessions = this.data.sessions
      .filter(session => session.userId === account.id)
      .sort((left, right) => right.expiresAt - left.expiresAt)
    const retained = new Set(accountSessions.slice(0, MAX_SESSIONS_PER_ACCOUNT - 1))
    this.data.sessions = this.data.sessions.filter(session => session.userId !== account.id || retained.has(session))
    this.data.sessions.push({ tokenHash: tokenHash(token), userId: account.id, expiresAt: Date.now() + SESSION_AGE_MS })
    if (remember && !this.data.savedUserIds.includes(account.id)) this.data.savedUserIds.unshift(account.id)
    this.data.autoLoginUserIds = this.data.autoLoginUserIds.filter(id => id !== account.id)
    if (remember && autoLogin) this.data.autoLoginUserIds.unshift(account.id)
    setSessionCookie(res, token, remember && autoLogin)
    await this.save()
  }

  /**
   * Create an account, its first session, and the desktop tenant marker.
   * @param body - untrusted registration fields.
   * @param res - response receiving the session cookie.
   * @returns the newly created public account.
   */
  async register(body: Record<string, unknown>, res: ServerResponse): Promise<PublicUser> {
    await this.ready
    return this.exclusive(async () => {
      const username = normalizedUsername(body.username)
      const password = validatedPassword(body.password)
      if (this.data.accounts.some(account => account.usernameKey === username.key)) throw new AuthError('该用户名已被注册', 409)
      const now = Date.now()
      const account: AccountRecord = {
        id: this.data.nextUserId++,
        username: username.display,
        usernameKey: username.key,
        passwordHash: await hashPassword(password),
        createdAt: now,
        lastLoginAt: now,
      }
      this.data.accounts.push(account)
      await this.createSession(account, body.remember === true, body.autoLogin === true, res)
      await this.setActiveAccount(account.id)
      return publicUser(account)
    })
  }

  /**
   * Verify credentials and create a fresh account session.
   * @param body - untrusted login fields.
   * @param res - response receiving the session cookie.
   * @returns the authenticated public account.
   */
  async login(body: Record<string, unknown>, res: ServerResponse): Promise<PublicUser> {
    await this.ready
    return this.exclusive(async () => {
      const username = normalizedUsername(body.username)
      const password = validatedPassword(body.password)
      const account = this.data.accounts.find(candidate => candidate.usernameKey === username.key)
      const dummy = `${PASSWORD_PREFIX}$${'00'.repeat(32)}$${'00'.repeat(PASSWORD_BYTES)}`
      const matches = await verifyPassword(password, account?.passwordHash ?? dummy)
      if (account === undefined || !matches) throw new AuthError('用户名或密码错误', 401)
      account.lastLoginAt = Date.now()
      await this.createSession(account, body.remember === true, body.autoLogin === true, res)
      await this.setActiveAccount(account.id)
      return publicUser(account)
    })
  }

  /** Exchange a trusted single-use launcher proof for this container's own session cookie. */
  async bootstrap(userId: number, res: ServerResponse): Promise<PublicUser> {
    await this.ready
    return this.exclusive(async () => {
      const account = this.data.accounts.find(candidate => candidate.id === userId)
      if (account === undefined) throw new AuthError('启动授权对应的本地账户不存在', 401)
      await this.createSession(account, true, true, res)
      return publicUser(account)
    })
  }

  /**
   * Revoke the current cookie session and clear the desktop tenant marker.
   * @param req - request carrying the session to revoke.
   * @param res - response receiving the expired cookie.
   */
  async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.ready
    await this.exclusive(async () => {
      const account = this.accountBySession(req)
      const token = cookieToken(req)
      if (account !== undefined) {
        // The active-account marker is device-global, so logout is device-global
        // too; leaving sibling container sessions alive would immediately repair
        // the marker and silently sign the user back in.
        this.data.sessions = this.data.sessions.filter(session => session.userId !== account.id)
      } else if (token !== undefined) {
        this.data.sessions = this.data.sessions.filter(session => session.tokenHash !== tokenHash(token))
      }
      clearSessionCookie(res)
      await this.save()
      if (account !== undefined) await this.setActiveAccount(null)
    })
  }

  /**
   * Replace the authenticated account's public profile fields.
   * @param req - authenticated request.
   * @param body - untrusted display name, avatar, and biography fields.
   * @returns the updated public account.
   */
  async updateProfile(req: IncomingMessage, body: Record<string, unknown>): Promise<PublicUser> {
    await this.ready
    return this.exclusive(async () => {
      const account = this.accountBySession(req)
      if (account === undefined) throw new AuthError('请先登录账号', 401)
      Object.assign(account, validatedProfile(body))
      await this.save()
      return publicUser(account)
    })
  }

  /**
   * Remove one account from the remembered-login chooser.
   * @param body - request carrying the numeric user id.
   */
  async removeSaved(body: Record<string, unknown>): Promise<void> {
    await this.ready
    await this.exclusive(async () => {
      const userId = Number(body.userId)
      if (!Number.isSafeInteger(userId)) throw new AuthError('账户标识无效')
      this.data.savedUserIds = this.data.savedUserIds.filter(id => id !== userId)
      await this.save()
    })
  }
}

/** Desktop-supervisor integration for the local-auth HTTP handler. */
export interface LocalAuthHandlerOptions {
  /** Desktop supervisor hook: restart the runtime after the response flushes so WORLDLINE_HOME can switch tenants. */
  onAccountChanged?: (userId: number | null) => void
  /** Enables repair of a missing/stale active-account marker from an authenticated session. */
  desktopManaged?: boolean
  /** Account id whose isolated runtime root is currently serving this process. */
  activeUserId?: number
  /** Single-use proof generated by the account-aware launcher for this Host generation. */
  bootstrapToken?: string
}

/**
 * Create the prefix HTTP handler for account session and profile operations.
 * @param store - initialized account store.
 * @param options - optional desktop tenant restart integration.
 * @returns a WebServer route handler that contains authentication errors as JSON responses.
 */
export function createLocalAuthHandler(
  store: LocalAuthStore,
  options: LocalAuthHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let bootstrapToken = options.bootstrapToken
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://worldline.local').pathname
      if (req.method === 'GET' && pathname === '/worldline-auth/session') {
        const snapshot = await store.snapshot(req)
        if (options.desktopManaged === true && snapshot.user !== null) {
          const repaired = await store.synchronizeActiveAccount(req, options.activeUserId)
          if (repaired !== undefined) {
            res.once('finish', () => { options.onAccountChanged?.(repaired) })
          }
        }
        sendJson(res, 200, { ok: true, ...snapshot })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '请求方法不受支持' })
        return
      }
      assertSameOrigin(req)
      const body = await readJsonBody(req)
      if (pathname === '/worldline-auth/bootstrap') {
        const expected = bootstrapToken
        if (expected === undefined || options.activeUserId === undefined
          || !matchesBootstrapToken(body.token, expected)) {
          throw new AuthError('启动授权无效或已失效', 401)
        }
        // Consume before the asynchronous store mutation so two concurrent
        // requests cannot exchange one proof twice.
        bootstrapToken = undefined
        const user = await store.bootstrap(options.activeUserId, res)
        sendJson(res, 200, { ok: true, user })
      } else if (pathname === '/worldline-auth/register') {
        const user = await store.register(body, res)
        res.once('finish', () => { options.onAccountChanged?.(user.id) })
        sendJson(res, 200, { ok: true, user, restart: options.desktopManaged === true })
      } else if (pathname === '/worldline-auth/login') {
        const user = await store.login(body, res)
        res.once('finish', () => { options.onAccountChanged?.(user.id) })
        sendJson(res, 200, { ok: true, user, restart: options.desktopManaged === true })
      } else if (pathname === '/worldline-auth/logout') {
        await store.logout(req, res)
        res.once('finish', () => { options.onAccountChanged?.(null) })
        sendJson(res, 200, { ok: true, restart: options.desktopManaged === true })
      } else if (pathname === '/worldline-auth/profile') {
        sendJson(res, 200, { ok: true, user: await store.updateProfile(req, body) })
      } else if (pathname === '/worldline-auth/saved/remove') {
        await store.removeSaved(body)
        sendJson(res, 200, { ok: true })
      } else {
        sendJson(res, 404, { ok: false, error: '接口不存在' })
      }
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 400
      sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new LocalAuthStore(ctx.logger, config)
  const managed = process.env[WORLDLINE_ACCOUNT_MANAGED_ENV] === '1'
    || process.env.WORLDLINE_DESKTOP_MANAGED === '1'
  const rawAccountId = process.env[WORLDLINE_ACCOUNT_ID_ENV]
  const expected = rawAccountId !== undefined && /^[1-9]\d*$/u.test(rawAccountId)
    ? Number(rawAccountId)
    : undefined
  ctx.provide('localAccountProfile', {
    current: () => expected === undefined ? undefined : store.profile(expected),
  } satisfies AccountProfile)
  const handler = createLocalAuthHandler(store, managed
    ? {
      desktopManaged: true,
      ...(expected === undefined ? {} : { activeUserId: expected }),
      ...(process.env[WORLDLINE_AUTH_BOOTSTRAP_TOKEN_ENV] === undefined
        ? {}
        : { bootstrapToken: process.env[WORLDLINE_AUTH_BOOTSTRAP_TOKEN_ENV] }),
      onAccountChanged: () => { setTimeout(() => process.exit(ACCOUNT_RUNTIME_RESTART_EXIT_CODE), 150) },
    }
    : {})
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/worldline-auth', handler }), 'local-auth: routes')
  if (managed) {
    ctx.effect(() => ctx.webServer.registerAccessGuard({
      path: '/api',
      authorize: req => expected !== undefined && store.authenticatedUser(req, expected) !== undefined,
    }), 'local-auth: account API boundary')
  }
}
