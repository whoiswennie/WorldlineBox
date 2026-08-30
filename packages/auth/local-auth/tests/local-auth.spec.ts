import { readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalAuthHandler, LocalAuthStore } from '../src/index.js'

describe('local authentication HTTP boundary', () => {
  let root: string
  let server: Server
  let baseUrl: string
  let store: LocalAuthStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'worldline-auth-test-'))
    store = new LocalAuthStore(new Context().logger, { root, legacyDatabasePath: false })
    await store.ready
    const handler = createLocalAuthHandler(store)
    server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () =>{  resolve() })
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() =>{  resolve() }))
    await rm(root, { recursive: true, force: true })
  })

  async function post(pathname: string, body: Record<string, unknown>, options: { cookie?: string; origin?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.cookie !== undefined) headers.cookie = options.cookie
    if (options.origin !== undefined) headers.origin = options.origin
    return fetch(`${baseUrl}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  function cookieOf(response: Response): string {
    const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0]
    if (cookie === undefined) throw new Error('authentication response did not set a cookie')
    return cookie
  }

  it('registers, persists a hashed password, restores a session and logs out', async () => {
    const registration = await post('/worldline-auth/register', {
      username: '世界线用户',
      password: 'correct horse battery staple',
      remember: true,
      autoLogin: true,
    })
    expect(registration.status).toBe(200)
    expect(await registration.json()).toMatchObject({ ok: true, user: { username: '世界线用户' } })
    const setCookie = registration.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('worldline_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Max-Age=')
    const cookie = cookieOf(registration)

    expect(JSON.parse(await readFile(join(root, 'active-account.json'), 'utf8'))).toEqual({ userId: 1 })

    const session = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie } })
    expect(await session.json()).toMatchObject({
      ok: true,
      user: { username: '世界线用户' },
      savedAccounts: [{ username: '世界线用户' }],
    })

    const file = await readFile(join(root, 'accounts.json'), 'utf8')
    expect(file).not.toContain('correct horse battery staple')
    expect(file).toContain('scrypt-v1$')

    const logout = await post('/worldline-auth/logout', {}, { cookie })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    const expired = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie } })
    expect(await expired.json()).toMatchObject({ ok: true, user: null })
    await expect(readFile(join(root, 'active-account.json'), 'utf8')).rejects.toThrow()
  })

  it('updates only the authenticated account profile and returns crop-ready avatar data', async () => {
    const first = await post('/worldline-auth/register', { username: 'profile-one', password: 'password-1234' })
    const firstCookie = cookieOf(first)
    const avatar = `data:image/webp;base64,${Buffer.from('cropped-avatar').toString('base64')}`
    const updated = await post('/worldline-auth/profile', { displayName: '世界线旅人', bio: '独立资料', avatar }, { cookie: firstCookie })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ user: { username: 'profile-one', displayName: '世界线旅人', bio: '独立资料', avatar } })
    expect(store.profile(1)).toMatchObject({
      username: 'profile-one', displayName: '世界线旅人', bio: '独立资料', avatar,
    })
    expect(store.profile(1)).not.toHaveProperty('passwordHash')
    expect(store.profile(1)).not.toHaveProperty('sessions')

    const second = await post('/worldline-auth/register', { username: 'profile-two', password: 'password-5678' })
    const secondCookie = cookieOf(second)
    const secondSnapshot = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie: secondCookie } })
    expect(await secondSnapshot.json()).toMatchObject({ user: { displayName: 'profile-two', bio: '', avatar: '' } })
    const firstSnapshot = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie: firstCookie } })
    expect(await firstSnapshot.json()).toMatchObject({ user: { displayName: '世界线旅人', bio: '独立资料', avatar } })
  })

  it('materializes only the active tenant avatar as a Host-readable image path', async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    const profileRoot = join(root, 'tenant-profile')
    store = new LocalAuthStore(new Context().logger, { root, legacyDatabasePath: false }, {
      activeUserId: 1,
      profileAssetRoot: profileRoot,
    })
    await store.ready
    const handler = createLocalAuthHandler(store)
    server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { resolve() })
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const registration = await post('/worldline-auth/register', {
      username: 'avatar-owner', password: 'password-1234',
    })
    const cookie = cookieOf(registration)
    const bytes = Buffer.from('materialized-avatar')
    const avatar = `data:image/png;base64,${bytes.toString('base64')}`
    expect((await post('/worldline-auth/profile', {
      displayName: 'Avatar Owner', bio: '', avatar,
    }, { cookie })).status).toBe(200)
    const avatarPath = join(profileRoot, 'avatar.png')
    expect(store.profileAvatarPath(1)).toBe(avatarPath)
    expect(await readFile(avatarPath)).toEqual(bytes)
    expect(JSON.stringify(await (await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie } })).json()))
      .not.toContain(avatarPath)

    expect((await post('/worldline-auth/profile', {
      displayName: 'Avatar Owner', bio: '', avatar: '',
    }, { cookie })).status).toBe(200)
    expect(store.profileAvatarPath(1)).toBeUndefined()
    await expect(readFile(avatarPath)).rejects.toThrow()
  })

  it('keeps WebUI and Electron sessions valid together and revokes both on device logout', async () => {
    const input = {
      username: 'shared-containers',
      password: 'password-1234',
      remember: true,
      autoLogin: true,
    }
    const webCookie = cookieOf(await post('/worldline-auth/register', input))
    const electronCookie = cookieOf(await post('/worldline-auth/login', input))
    const webSession = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie: webCookie } })
    const electronSession = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie: electronCookie } })
    expect(await webSession.json()).toMatchObject({ user: { username: input.username } })
    expect(await electronSession.json()).toMatchObject({ user: { username: input.username } })

    expect((await post('/worldline-auth/logout', {}, { cookie: webCookie })).status).toBe(200)
    const siblingAfterLogout = await fetch(`${baseUrl}/worldline-auth/session`, {
      headers: { cookie: electronCookie },
    })
    expect(await siblingAfterLogout.json()).toMatchObject({ user: null })
  })

  it('exchanges one launcher proof once without exposing or reusing the account password', async () => {
    const registration = await post('/worldline-auth/register', {
      username: 'bootstrap-user',
      password: 'password-1234',
      remember: true,
      autoLogin: true,
    })
    const payload = await registration.json() as { user: { id: number } }
    await new Promise<void>(resolve => server.close(() => { resolve() }))
    const proof = 'ef'.repeat(32)
    const handler = createLocalAuthHandler(store, {
      desktopManaged: true,
      activeUserId: payload.user.id,
      bootstrapToken: proof,
    })
    server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { resolve() })
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const bootstrap = await post('/worldline-auth/bootstrap', { token: proof })
    expect(bootstrap.status).toBe(200)
    const cookie = cookieOf(bootstrap)
    const snapshot = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie } })
    expect(await snapshot.json()).toMatchObject({ user: { username: 'bootstrap-user' } })
    expect((await post('/worldline-auth/bootstrap', { token: proof })).status).toBe(401)
    expect(await readFile(join(root, 'accounts.json'), 'utf8')).not.toContain(proof)
  })

  it('repairs a missing desktop active-account marker from the authenticated session', async () => {
    const registration = await post('/worldline-auth/register', {
      username: 'desktop-recovery',
      password: 'password-1234',
    })
    const cookie = cookieOf(registration)
    await rm(join(root, 'active-account.json'), { force: true })

    await new Promise<void>(resolve => server.close(() =>{  resolve() }))
    let restartedFor: number | null | undefined
    const handler = createLocalAuthHandler(store, {
      desktopManaged: true,
      onAccountChanged: (userId) => { restartedFor = userId },
    })
    server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () =>{  resolve() })
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const recovered = await fetch(`${baseUrl}/worldline-auth/session`, { headers: { cookie } })
    expect(await recovered.json()).toMatchObject({ ok: true, user: { id: 1 } })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(restartedFor).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'active-account.json'), 'utf8'))).toEqual({ userId: 1 })
  })

  it('returns precise status codes for invalid credentials, duplicates and cross-origin writes', async () => {
    const input = { username: 'tester', password: 'password-1234' }
    expect((await post('/worldline-auth/register', input)).status).toBe(200)
    expect((await post('/worldline-auth/register', input)).status).toBe(409)
    expect((await post('/worldline-auth/login', { ...input, password: 'wrong-password' })).status).toBe(401)
    expect((await post('/worldline-auth/login', input, { origin: 'http://attacker.invalid' })).status).toBe(403)
    const shortName = await post('/worldline-auth/register', { username: 'ab', password: 'password-1234' })
    expect(shortName.status).toBe(400)
    expect(await shortName.json()).toMatchObject({ error: '账号长度应为 3 到 32 个字符' })
  })

  it('accepts non-empty local passwords without a minimum length', async () => {
    const input = { username: 'short-password', password: '1' }
    const registration = await post('/worldline-auth/register', input)
    expect(registration.status).toBe(200)

    const login = await post('/worldline-auth/login', input)
    expect(login.status).toBe(200)
    expect(await login.json()).toMatchObject({ ok: true, user: { username: input.username } })

    const empty = await post('/worldline-auth/register', { username: 'empty-password', password: '' })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ error: '密码不能为空且不能超过 256 个字符' })
  })

  it('serializes concurrent registrations and keeps one canonical username', async () => {
    const input = { username: 'ParallelUser', password: 'password-1234' }
    const responses = await Promise.all([
      post('/worldline-auth/register', input),
      post('/worldline-auth/register', { ...input, username: 'paralleluser' }),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const data = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')) as { accounts: unknown[] }
    expect(data.accounts).toHaveLength(1)
  })

  it('removes only the saved-account shortcut without deleting the account', async () => {
    const registration = await post('/worldline-auth/register', {
      username: 'remembered',
      password: 'password-1234',
      remember: true,
    })
    const payload = await registration.json() as { user: { id: number } }
    expect((await post('/worldline-auth/saved/remove', { userId: payload.user.id })).status).toBe(200)
    const snapshot = await fetch(`${baseUrl}/worldline-auth/session`)
    expect(await snapshot.json()).toMatchObject({ ok: true, savedAccounts: [] })
    expect((await post('/worldline-auth/login', { username: 'remembered', password: 'password-1234' })).status).toBe(200)
  })
})
