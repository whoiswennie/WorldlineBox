import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const overlaySource = readFileSync(
  fileURLToPath(new URL('../src/client/AuthOverlay.tsx', import.meta.url)),
  'utf8',
)
const accountSettingsSource = readFileSync(
  fileURLToPath(new URL('../src/client/AccountSettings.tsx', import.meta.url)),
  'utf8',
)

describe('account terminology', () => {
  it('uses 账号 consistently across the profile, login, and registration surfaces', () => {
    expect(overlaySource).toContain('<span>账号</span>')
    expect(overlaySource).toContain('登录本地账号')
    expect(overlaySource).toContain('注册本地账号')
    expect(accountSettingsSource).toContain('aria-label="账号"')

    expect(`${overlaySource}\n${accountSettingsSource}`).not.toMatch(
      /登录用户名|<span>用户名<\/span>|本地账户|已保存账户|使用其他账户/,
    )
  })
})
