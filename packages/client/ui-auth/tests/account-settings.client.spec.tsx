// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AccountSettings } from '../src/client/AccountSettings.tsx'
import { getAuthSnapshot, setAuthSnapshot } from '../src/client/auth-store.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const user = {
  id: 7,
  username: 'tenant-seven',
  createdAt: 1_700_000_000_000,
  lastLoginAt: 1_700_000_100_000,
  displayName: '七号用户',
  avatar: '',
  bio: '原始资料',
}

describe('account settings', () => {
  it('renders the isolated account and updates its profile through the auth boundary', async () => {
    setAuthSnapshot({ loading: false, user, savedAccounts: [user], error: '' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      user: { ...user, displayName: '新的名称', bio: '新的资料' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    render(<AccountSettings {...({} as ComponentProps<typeof AccountSettings>)} />)

    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '新的名称' } })
    fireEvent.change(screen.getByLabelText('个人信息'), { target: { value: '新的资料' } })
    fireEvent.click(screen.getByRole('button', { name: '保存资料' }))

    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('已保存') })
    expect(fetchMock).toHaveBeenCalledWith('/worldline-auth/profile', expect.objectContaining({ method: 'POST' }))
    expect(getAuthSnapshot().user).toMatchObject({ id: 7, displayName: '新的名称', bio: '新的资料' })
  })

  it('logs out to the authentication surface', async () => {
    setAuthSnapshot({ loading: false, user, savedAccounts: [user], error: '' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    render(<AccountSettings {...({} as ComponentProps<typeof AccountSettings>)} />)
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => { expect(getAuthSnapshot().user).toBeNull() })
  })
})
