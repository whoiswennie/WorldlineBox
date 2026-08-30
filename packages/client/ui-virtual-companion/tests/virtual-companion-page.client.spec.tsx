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

function apiFetch() {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    let value: unknown = { companions: [yachiyo], rooms: {} }
    if (url.endsWith('/vault/self')) value = self
    else if (url.endsWith('/vault/policy')) value = policy
    else if (url.endsWith('/vault/self/update')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as {
        module: typeof self.modules[number]
      }
      value = body.module
    } else if (url.endsWith('/vault/policy/set')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { policy: typeof policy }
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
    openKnowledgeDocument: () => undefined,
    ...overrides,
  }
}

describe('VirtualCompanionPage', () => {
  it('renders Yachiyo from the bundled portrait and launches her preset flow', async () => {
    vi.stubGlobal('fetch', apiFetch())
    const launch = vi.fn(() => Promise.resolve())
    render(<VirtualCompanionPage {...props({ launch })} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    await waitFor(() => {
      expect(screen.getByAltText('月见八千代').getAttribute('src'))
        .toBe('/worldline-experience/companion.png')
    })
    expect(screen.getByText(/伙伴只读取公共 Vault 与自己的私有 Vault/u)).toBeTruthy()
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

  it('previews the portrait and opens the matching self Markdown document', async () => {
    vi.stubGlobal('fetch', apiFetch())
    const openKnowledgeDocument = vi.fn()
    render(<VirtualCompanionPage {...props({ openKnowledgeDocument })} />)

    await screen.findByRole('button', { name: '预览月见八千代的大图' })
    fireEvent.click(screen.getByRole('button', { name: '预览月见八千代的大图' }))
    expect(screen.getByRole('dialog', { name: '月见八千代形象大图' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭大图预览' }))
    expect(screen.queryByRole('dialog', { name: '月见八千代形象大图' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '编辑身份 MD' }))
    expect(openKnowledgeDocument).toHaveBeenCalledWith('yachiyo-runami', 'self/identity.md')
    fireEvent.click(screen.getByRole('button', { name: '编辑 emotion.md' }))
    expect(openKnowledgeDocument).toHaveBeenCalledWith('yachiyo-runami', 'self/emotion.md')
  })

  it('keeps knowledge management out of the profile card and removes the external profile link', async () => {
    const fetch = apiFetch()
    vi.stubGlobal('fetch', fetch)
    render(<VirtualCompanionPage {...props()} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    expect(screen.getByText(/角色包会统一携带形象、记忆、能力、资源和印象卡/u)).toBeTruthy()
    expect(screen.queryByText('查看官方角色资料')).toBeNull()
    expect(screen.queryByRole('button', { name: /公共记忆与知识库/u })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: '近期情绪已启用，点击停用' }))
    await waitFor(() => { expect(screen.getByRole('switch', { name: '近期情绪已停用，点击启用' })).toBeTruthy() })
    fireEvent.click(screen.getByLabelText('更多角色操作'))
    fireEvent.click(screen.getByRole('button', { name: /^冻结为只读/u }))
    await waitFor(() => { expect(screen.getByRole('button', { name: /^解除知识冻结/u })).toBeTruthy() })
    const policyCall = fetch.mock.calls.find(([url]) => url === '/api/virtual-companions/vault/policy/set')
    expect(policyCall?.[1]?.method).toBe('POST')
    expect(typeof policyCall?.[1]?.body === 'string' ? policyCall[1].body : '').toContain('"fullyFrozen":true')
  })

  it('re-reads self Markdown projection immediately after a live Vault event', async () => {
    let currentSummary = '保存前的状态'
    class LiveEventSource {
      static current: LiveEventSource | undefined
      onmessage: ((event: MessageEvent) => void) | null = null
      readonly url: string
      constructor(url: string | URL) { this.url = String(url); LiveEventSource.current = this }
      close(): void {}
      emit(): void { this.onmessage?.(new MessageEvent('message', { data: '{}' })) }
    }
    vi.stubGlobal('EventSource', LiveEventSource)
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      const value = url.endsWith('/vault/self')
        ? { ...self, modules: [{ ...self.modules[0], summary: currentSummary }] }
        : url.endsWith('/vault/policy') ? policy
          : { companions: [yachiyo], rooms: {} }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, value }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }))
    render(<VirtualCompanionPage {...props()} />)
    expect(await screen.findByText('保存前的状态')).toBeTruthy()
    expect(LiveEventSource.current?.url).toContain('/vault/events/yachiyo-runami')

    currentSummary = 'MD 保存后的实时状态'
    LiveEventSource.current?.emit()
    expect(await screen.findByText('MD 保存后的实时状态')).toBeTruthy()
    expect(screen.queryByText('保存前的状态')).toBeNull()
  })

  it('restores a built-in companion through an in-app non-blocking confirmation dialog', async () => {
    const fetch = apiFetch()
    vi.stubGlobal('fetch', fetch)
    const blockingConfirm = vi.spyOn(window, 'confirm')
    render(<VirtualCompanionPage {...props()} />)

    await waitFor(() => { expect(screen.getAllByText('月见八千代').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByLabelText('更多角色操作'))
    fireEvent.click(screen.getByRole('button', { name: /^恢复原版/u }))
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

  it('closes the companion action menu on outside interaction and Escape', async () => {
    vi.stubGlobal('fetch', apiFetch())
    render(<VirtualCompanionPage {...props()} />)
    await screen.findByLabelText('更多角色操作')
    const summary = screen.getByLabelText('更多角色操作')
    const details = summary.closest('details')
    if (!(details instanceof HTMLDetailsElement)) throw new Error('action menu is missing')

    fireEvent.click(summary)
    expect(details.open).toBe(true)
    fireEvent.pointerDown(document.body)
    expect(details.open).toBe(false)

    fireEvent.click(summary)
    expect(details.open).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(details.open).toBe(false)
  })

  it('shows default artwork only while creating and hides it when editing an existing companion', async () => {
    vi.stubGlobal('fetch', apiFetch())
    render(<VirtualCompanionPage {...props()} />)
    await screen.findByRole('button', { name: '编辑资料' })

    fireEvent.click(screen.getByRole('button', { name: '编辑资料' }))
    const editor = screen.getByRole('dialog', { name: '编辑伙伴' })
    expect(within(editor).queryByLabelText('默认形象')).toBeNull()
    expect(within(editor).getByText(/已设定的形象不会显示默认候选/u)).toBeTruthy()
    fireEvent.click(within(editor).getByRole('button', { name: '关闭' }))

    fireEvent.click(screen.getByRole('button', { name: '新增伙伴' }))
    const creator = screen.getByRole('dialog', { name: '新增伙伴' })
    expect(within(creator).getByLabelText('默认形象')).toBeTruthy()
    expect(within(creator).getByText('白色形态')).toBeTruthy()
    expect(within(creator).getByText('黑色形态')).toBeTruthy()
  })
})
