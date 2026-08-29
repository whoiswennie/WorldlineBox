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

const self = { agentId: yachiyo.id, compiled: '', revision: 'self-1', modules: [{
  id: 'emotion', title: '近期情绪', enabled: true, autonomous: true, locked: false,
  stability: 'dynamic', summary: '平静而期待创作', details: ['最近完成了一次愉快的合作'],
  updatedAt: 1, revision: 'emotion-1',
}] } as const
const policy = { aiWriteMode: 'autonomous', domains: { self: 'proposal', memory: 'autonomous',
  procedure: 'proposal', resource: 'autonomous' }, userEditable: true, fullyFrozen: false } as const

function apiFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    let value: unknown = { companions: [yachiyo], rooms: {} }
    if (url.endsWith('/vault/self')) value = self
    else if (url.endsWith('/vault/policy')) value = policy
    else if (url.endsWith('/vault/self/update')) {
      const body = JSON.parse(String(init?.body)) as { module: typeof self.modules[number] }
      value = body.module
    } else if (url.endsWith('/vault/policy/set')) {
      const body = JSON.parse(String(init?.body)) as { policy: typeof policy }
      value = body.policy
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  })
}

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
    vi.stubGlobal('fetch', apiFetch())
    const launch = vi.fn(() => Promise.resolve())
    render(<VirtualCompanionPage {...props({ launch })} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    expect(screen.getByAltText('月见八千代').getAttribute('src'))
      .toBe('/worldline-experience/companion.png')
    expect(screen.getByText(/不会读取其他伙伴的私有认知/u)).toBeTruthy()
    await waitFor(() => { expect(screen.getByText('平静而期待创作')).toBeTruthy() })
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
    const fetch = apiFetch()
    vi.stubGlobal('fetch', fetch)
    render(<VirtualCompanionPage {...props()} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    expect(screen.getByText(/记忆、能力、资源和印象卡统一打包迁移/u)).toBeTruthy()
    expect(screen.queryByText('查看官方角色资料')).toBeNull()
    expect(screen.queryByRole('button', { name: /公共记忆与知识库/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '已启用 · 点击停用' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '已停用 · 点击启用' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '冻结为只读' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '解除知识冻结' })).toBeTruthy() })
    expect(fetch).toHaveBeenCalledWith('/api/virtual-companions/vault/policy/set', expect.objectContaining({
      method: 'POST', body: expect.stringContaining('"fullyFrozen":true'),
    }))
  })

  it('restores a built-in companion through an in-app non-blocking confirmation dialog', async () => {
    const fetch = apiFetch()
    vi.stubGlobal('fetch', fetch)
    const blockingConfirm = vi.spyOn(window, 'confirm')
    render(<VirtualCompanionPage {...props()} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByRole('button', { name: '恢复原版' }))
    const dialog = screen.getByRole('dialog', { name: '恢复内置伙伴原版' })
    expect(within(dialog).getByText(/私有 Agent Vault 全部恢复/u)).toBeTruthy()
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
