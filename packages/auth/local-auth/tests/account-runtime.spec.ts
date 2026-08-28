import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedAccountLaunch,
  withAuthBootstrapFragment,
} from '../src/account-runtime.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'worldline-account-runtime-'))
  roots.push(value)
  await mkdir(join(value, 'auth'), { recursive: true })
  return value
}

describe('managed account runtime selection', () => {
  it('uses the signed-out quarantine when no active marker exists', async () => {
    const base = await root()
    const launch = await createManagedAccountLaunch(base)
    expect(launch).toMatchObject({
      tenant: 'signed-out',
      accountHome: join(base, 'accounts', 'signed-out'),
      authHome: join(base, 'auth'),
    })
    expect(launch.bootstrapToken).toBeUndefined()
    expect(launch.environment).not.toHaveProperty('WORLDLINE_ACCOUNT_ID')
  })

  it('selects the same account root and creates a proof only for cross-entry auto-login', async () => {
    const base = await root()
    const auth = join(base, 'auth')
    await writeFile(join(auth, 'active-account.json'), '{"userId":7}\n')
    await writeFile(join(auth, 'accounts.json'), '{"autoLoginUserIds":[7]}\n')
    const launch = await createManagedAccountLaunch(base)
    expect(launch.tenant).toBe('user-7')
    expect(launch.environment.WORLDLINE_HOME).toBe(join(base, 'accounts', 'user-7'))
    expect(launch.environment.WORLDLINE_AUTH_HOME).toBe(auth)
    expect(launch.environment.WORLDLINE_ACCOUNT_ID).toBe('7')
    expect(launch.bootstrapToken).toMatch(/^[a-f\d]{64}$/u)

    await writeFile(join(auth, 'accounts.json'), '{"autoLoginUserIds":[]}\n')
    const manual = await createManagedAccountLaunch(base)
    expect(manual.userId).toBe(7)
    expect(manual.bootstrapToken).toBeUndefined()
  })

  it('keeps the clean URL printable and carries the proof only in its fragment', () => {
    const token = 'ab'.repeat(32)
    const result = withAuthBootstrapFragment('http://127.0.0.1:3080/', token)
    expect(result).toBe(`http://127.0.0.1:3080/#worldline-auth-bootstrap=${token}`)
    expect(withAuthBootstrapFragment('http://127.0.0.1:3080/', undefined))
      .toBe('http://127.0.0.1:3080/')
  })
})
