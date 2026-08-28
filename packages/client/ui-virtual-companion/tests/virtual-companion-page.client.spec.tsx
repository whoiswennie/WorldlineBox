// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { VirtualCompanionPage, type VirtualCompanionPageProps } from '../src/client/VirtualCompanionPage.tsx'
import { zh } from '../src/client/locales.ts'

const yachiyo = {
  id: 'yachiyo-runami', name: '月见八千代', handle: 'YACHIYO RUNAMI · 月读管理者',
  avatar: '/worldline-experience/companion.png', portrait: '/worldline-experience/companion.png',
  status: '今天也在守望每个人自由创作的空间。', description: '伙伴资料', persona: '核心身份',
  style: '温柔包容', speakingStyle: '自然温暖', behaviorLogic: '先倾听', builtIn: true,
  createdAt: 1, updatedAt: 1,
} as const

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function props(overrides: Partial<VirtualCompanionPageProps> = {}): VirtualCompanionPageProps {
  return {
    activePage: 'virtual-companions',
    useSessions: (() => { throw new Error('unused') }),
    useWorkspaces: selector => selector({
      items: [{ workspaceId: 'workspace' as never, path: '/workspace' } as never],
      recentWorkspaceId: 'workspace' as never,
    } as never),
    t: key => (zh as Record<string, string>)[key] ?? key,
    launch: () => Promise.resolve(),
    ...overrides,
  }
}

describe('VirtualCompanionPage', () => {
  it('renders Yachiyo from the bundled portrait and launches her preset flow', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true, value: { companions: [yachiyo], rooms: {} },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    const launch = vi.fn(() => Promise.resolve())
    render(<VirtualCompanionPage {...props({ launch })} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    expect(screen.getByAltText('月见八千代').getAttribute('src'))
      .toBe('/worldline-experience/companion.png')
    expect(screen.getByText(/密码或凭据永不注入/u)).toBeTruthy()
    expect(screen.queryByText('查看官方角色资料')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '和月见八千代聊天' }))
    await waitFor(() => { expect(launch).toHaveBeenCalledWith('yachiyo-runami') })
  })

  it('does not launch without a workspace', () => {
    render(<VirtualCompanionPage {...props({
      useWorkspaces: selector => selector({ items: [] } as never),
    })} />)

    expect(screen.getByRole('button', { name: '和月见八千代聊天' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/请先创建一个工作区/u)).toBeTruthy()
  })

  it('keeps knowledge management out of the profile card and removes the external profile link', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true, value: { companions: [yachiyo], rooms: {} },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    render(<VirtualCompanionPage {...props()} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    expect(screen.getByText(/知识与引用资料统一在左侧“知识库”中维护/u)).toBeTruthy()
    expect(screen.queryByText('查看官方角色资料')).toBeNull()
    expect(screen.queryByRole('button', { name: /公共记忆与知识库/u })).toBeNull()
  })

  it('restores a built-in companion through an in-app non-blocking confirmation dialog', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true, value: { companions: [yachiyo], rooms: {} },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetch)
    const blockingConfirm = vi.spyOn(window, 'confirm')
    render(<VirtualCompanionPage {...props()} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('button', { name: '恢复原版' }))
    const dialog = screen.getByRole('dialog', { name: '恢复内置伙伴原版' })
    expect(within(dialog).getByText(/私有知识库和私有引用库全部恢复/u)).toBeTruthy()
    expect(blockingConfirm).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复原版' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/virtual-companions/restore', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ id: yachiyo.id }),
      }))
    })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})
