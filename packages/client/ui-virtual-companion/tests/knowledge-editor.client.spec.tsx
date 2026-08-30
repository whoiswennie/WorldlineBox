// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import { KnowledgeVaultPage } from '../src/client/KnowledgeVaultPage.tsx'

function response(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, value }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('knowledge editor and file tree', () => {
  it('opens a companion self document requested from its profile card', async () => {
    const reads: Array<{ scope: string; path: string; view: string }> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request ? input.url : input.href
      if (url.endsWith('/api/virtual-companions')) return Promise.resolve(response({
        companions: [{ id: 'kaguya', name: '辉夜', avatar: '/avatars/kaguya.png' }], rooms: {},
      }))
      if (url.endsWith('/knowledge/tree')) return Promise.resolve(response([]))
      if (url.endsWith('/knowledge/read')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          scope: string
          path: string
          view: string
        }
        reads.push(body)
        return Promise.resolve(response({
          scope: body.scope, path: body.path, title: '核心身份', summary: '来自 MD', tags: [],
          revision: 'identity-one', updatedAt: 1, content: '# 核心身份\n\n来自 MD',
          headings: ['核心身份'], links: [], sources: [], totalLines: 3, view: 'full',
        }))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    const openRequest = { scope: 'kaguya', path: 'self/identity.md', revision: 1 }
    const Page = KnowledgeVaultPage as ComponentType<{
      activePage: string
      getOpenRequest(): { scope: string; path: string; revision: number }
      subscribeOpenRequest(listener: () => void): () => void
    }>
    render(<Page activePage="knowledge-vault"
      getOpenRequest={() => openRequest}
      subscribeOpenRequest={() => () => undefined} />)

    await waitFor(() => { expect(reads).toContainEqual({
      scope: 'kaguya', path: 'self/identity.md', view: 'full',
    }) })
    expect(screen.getAllByText('核心身份').length).toBeGreaterThan(0)
  })

  it('searches while typing and restores the complete root tree when cleared', async () => {
    const searchRequests: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.href
      if (url.endsWith('/api/virtual-companions')) {
        return Promise.resolve(response({
          companions: [{ id: 'kaguya', name: '辉夜', avatar: '/avatars/kaguya.png' }],
          rooms: {},
        }))
      }
      if (url.endsWith('/knowledge/tree')) {
        return Promise.resolve(response([
          { name: 'root.md', path: 'root.md', kind: 'document', size: 12 },
          { name: 'memory', path: 'memory', kind: 'directory', children: 1 },
        ]))
      }
      if (url.endsWith('/knowledge/search')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          query?: string
        }
        searchRequests.push(body.query ?? '')
        return Promise.resolve(response([{
          scope: 'public', path: 'memory/moon.md', title: '月色记忆',
          summary: '与月亮有关的回忆', tags: ['月'], revision: 'one', updatedAt: 1,
        }]))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    render(<Page activePage="knowledge" />)
    expect(await screen.findByRole('button', { name: 'root.md' })).toBeTruthy()

    const input = screen.getByPlaceholderText('搜索标题、标签与正文')
    fireEvent.change(input, { target: { value: '月' } })
    expect(await screen.findByText('月色记忆')).toBeTruthy()
    expect(searchRequests).toEqual(['月'])
    expect(screen.queryByRole('button', { name: 'root.md' })).toBeNull()

    fireEvent.change(input, { target: { value: '' } })
    expect(await screen.findByRole('button', { name: 'root.md' })).toBeTruthy()
    expect(searchRequests).toEqual(['月'])
  })

  it('uses resource-manager tree rows and opens Markdown in edit mode', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.href
      if (url.endsWith('/api/virtual-companions')) {
        return Promise.resolve(response({
          companions: [{ id: 'kaguya', name: '辉夜', avatar: '/avatars/kaguya.png' }],
          rooms: {},
        }))
      }
      if (url.endsWith('/knowledge/tree')) {
        const rawBody = init?.body
        if (typeof rawBody !== 'string') throw new Error('knowledge tree request body is missing')
        const body = JSON.parse(rawBody) as { path: string }
        return Promise.resolve(response(body.path === ''
          ? [{ name: 'pages', path: 'pages', kind: 'directory', children: 1 }]
          : [{ name: 'index.md', path: 'pages/index.md', kind: 'document', size: 24 }]))
      }
      if (url.endsWith('/knowledge/read')) {
        return Promise.resolve(response({
          scope: 'public', path: 'pages/index.md', title: 'Vault index',
          summary: 'Vault entry point', tags: ['index'], revision: 'revision-one',
          updatedAt: 1, content: '# Vault index', headings: ['Vault index'], links: [],
          sources: [], totalLines: 1, view: 'full',
        }))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    render(<Page activePage="knowledge" />)

    const scopeSwitcher = screen.getByRole('combobox', { name: '选择知识库' })
    expect(scopeSwitcher).toBeTruthy()
    expect(screen.getByRole('button', { name: '文件树' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '页面信息' }).getAttribute('aria-pressed'))
      .toBe('false')
    const folder = await screen.findByRole('button', { name: 'pages' })
    expect(folder.querySelectorAll('svg')).toHaveLength(2)
    fireEvent.click(folder)

    const file = await screen.findByRole('button', { name: 'index.md' })
    expect(file.querySelector('svg')).toBeTruthy()
    fireEvent.click(file)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '编辑' }).getAttribute('aria-pressed')).toBe('true')
    })
    expect(screen.getByRole('button', { name: '分屏' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: '页面信息' }))
    expect(screen.getByRole('button', { name: '收起页面信息' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起页面信息' }))
    expect(screen.getByRole('button', { name: '页面信息' }).getAttribute('aria-pressed'))
      .toBe('false')

    expect(screen.queryByRole('button', { name: '收起文件树' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '文件树' }))
    expect(screen.queryByRole('button', { name: 'pages' })).toBeNull()
    expect(screen.getByRole('button', { name: '文件树' }).getAttribute('aria-pressed')).toBe('false')

    const closeTab = screen.getByRole('button', { name: '关闭标签页 Vault index' })
    expect(closeTab.textContent).toBe('×')
    fireEvent.click(closeTab)
    expect(screen.queryByRole('tab', { name: /Vault index/u })).toBeNull()

    fireEvent.click(scopeSwitcher)
    const companionScope = await screen.findByRole('option', { name: /辉夜/u })
    expect(companionScope.querySelector('img')?.getAttribute('src')).toBe('/avatars/kaguya.png')
    fireEvent.click(companionScope)
    expect(scopeSwitcher.textContent).toContain('辉夜')
    expect(screen.getByText('翻开 辉夜 的记忆书页')).toBeTruthy()
  })

  it('creates folders and supports keyboard copy, paste, and recoverable deletion', async () => {
    const requests: Array<{ action: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input
        : input instanceof Request ? input.url : input.href
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      if (url.endsWith('/api/virtual-companions')) {
        return Promise.resolve(response({ companions: [], rooms: {} }))
      }
      if (url.endsWith('/knowledge/tree')) {
        const path = body['path']
        return Promise.resolve(response(path === ''
          ? [{ name: 'memory', path: 'memory', kind: 'directory' }]
          : path === 'memory'
            ? [
              { name: 'source.md', path: 'memory/source.md', kind: 'document', revision: 'one' },
              { name: 'target', path: 'memory/target', kind: 'directory' },
            ]
            : []))
      }
      if (url.endsWith('/knowledge/read')) return Promise.resolve(response({
        scope: 'public', path: 'memory/source.md', title: 'source', summary: '', tags: [],
        revision: 'one', updatedAt: 1, content: '# source', headings: ['source'], links: [],
        sources: [], totalLines: 1, view: 'full',
      }))
      if (url.endsWith('/knowledge/create')) {
        requests.push({ action: 'create', body })
        return Promise.resolve(response({ name: body['name'], path: `memory/${String(body['name'])}`,
          kind: 'directory' }))
      }
      if (url.endsWith('/knowledge/copy')) {
        requests.push({ action: 'copy', body })
        return Promise.resolve(response({ name: 'source.md', path: body['target'], kind: 'document' }))
      }
      if (url.endsWith('/knowledge/trash')) {
        requests.push({ action: 'trash', body })
        return Promise.resolve(response({ removed: true }))
      }
      throw new Error(`unexpected request: ${url}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    const { container } = render(<Page activePage="knowledge" />)
    fireEvent.click(await screen.findByRole('button', { name: 'memory' }))

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
    fireEvent.change(screen.getByLabelText('文件夹名称'), { target: { value: '项目资料' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => {
      expect(requests[0]).toMatchObject({ action: 'create', body: {
        kind: 'directory', parent: 'memory', name: '项目资料',
      } })
    })

    const source = await screen.findByRole('button', { name: 'source.md' })
    fireEvent.click(source)
    const pane = container.querySelector('aside')!
    fireEvent.keyDown(pane, { key: 'c', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'target' }))
    fireEvent.keyDown(pane, { key: 'v', ctrlKey: true })
    await waitFor(() => {
      expect(requests.some(request => request.action === 'copy'
        && request.body['target'] === 'memory/target/source.md')).toBe(true)
    })

    fireEvent.click(source)
    fireEvent.keyDown(pane, { key: 'Delete' })
    expect(screen.getByRole('dialog', { name: '移到回收目录' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(requests.some(request => request.action === 'trash'
        && request.body['path'] === 'memory/source.md')).toBe(true)
    })
  })

  it('imports a dropped Markdown file into the selected directory', async () => {
    const imports: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input
        : input instanceof Request ? input.url : input.href
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      if (url.endsWith('/api/virtual-companions')) {
        return Promise.resolve(response({ companions: [], rooms: {} }))
      }
      if (url.endsWith('/knowledge/tree')) return Promise.resolve(response([]))
      if (url.endsWith('/knowledge/create')) {
        imports.push(body)
        return Promise.resolve(response({
          scope: 'public', path: 'memory/long/pages/notes.md', title: 'notes', summary: '', tags: [],
          revision: 'one', updatedAt: 1, content: '# imported', headings: ['imported'], links: [],
          sources: [], totalLines: 1, view: 'full',
        }))
      }
      if (url.endsWith('/knowledge/read')) return Promise.resolve(response({
        scope: 'public', path: 'memory/long/pages/notes.md', title: 'notes', summary: '', tags: [],
        revision: 'one', updatedAt: 1, content: '# imported', headings: ['imported'], links: [],
        sources: [], totalLines: 1, view: 'full',
      }))
      throw new Error(`unexpected request: ${url}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    const { container } = render(<Page activePage="knowledge" />)
    await screen.findByRole('button', { name: '导入文件' })
    const input = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!
    fireEvent.change(input, { target: { files: [new File(['# imported'], 'notes.md', {
      type: 'text/markdown',
    })] } })
    await waitFor(() => {
      expect(imports[0]).toMatchObject({
        kind: 'document', parent: 'memory/long/pages', name: 'notes.md', content: '# imported',
      })
    })
  })

  it('manages every deleted companion Vault from one knowledge-base trash tab', async () => {
    let trash = [
      { id: 'old-friend-1000', agentId: 'old-friend', name: '旧伙伴', deletedAt: 1_000,
        createdAt: 100, updatedAt: 900, restorable: true,
        avatar: '/api/virtual-companions/vault/trash/avatar/old-friend-1000' },
      { id: 'kaguya-2000', agentId: 'kaguya', name: '辉夜旧版本', deletedAt: 2_000,
        createdAt: 100, updatedAt: 1_900, restorable: false },
    ]
    const actions: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.href
      if (url.endsWith('/api/virtual-companions')) {
        return Promise.resolve(response({
          companions: [{ id: 'kaguya', name: '辉夜', avatar: '/avatars/kaguya.png' }], rooms: {},
        }))
      }
      if (url.endsWith('/vault/trash/list')) return Promise.resolve(response(trash))
      if (url.endsWith('/vault/trash/empty')) {
        actions.push('empty')
        trash = []
        return Promise.resolve(response({ removed: 2 }))
      }
      if (url.endsWith('/knowledge/tree')) return Promise.resolve(response([]))
      throw new Error(`unexpected request: ${url}; body=${typeof init?.body}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    render(<Page activePage="knowledge" />)
    fireEvent.click(screen.getByRole('tab', { name: /回收站/u }))
    expect(await screen.findByText('旧伙伴')).toBeTruthy()
    expect(screen.getByText('旧伙伴').closest('article')?.querySelector('img')?.getAttribute('src'))
      .toBe('/api/virtual-companions/vault/trash/avatar/old-friend-1000')
    expect(screen.getByText('同 ID 伙伴正在使用')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '恢复伙伴' })[1]?.hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '清空回收站' }))
    expect(screen.getByRole('dialog', { name: '清空回收站' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认永久删除' }))
    expect(await screen.findByText('回收站是空的')).toBeTruthy()
    expect(actions).toEqual(['empty'])
  })

  it('restores a recoverable companion and refreshes the companion directory', async () => {
    let trash = [{ id: 'returning-3000', agentId: 'returning', name: '归来伙伴', deletedAt: 3_000,
      createdAt: 100, updatedAt: 2_900, restorable: true }]
    let restoredId = ''
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.href
      if (url.endsWith('/api/virtual-companions')) {
        return Promise.resolve(response({ companions: [], rooms: {} }))
      }
      if (url.endsWith('/vault/trash/list')) return Promise.resolve(response(trash))
      if (url.endsWith('/vault/trash/restore')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id?: string }
        restoredId = body.id ?? ''
        trash = []
        return Promise.resolve(response({ manifest: { agent: { id: 'returning' } }, directory: {} }))
      }
      if (url.endsWith('/knowledge/tree')) return Promise.resolve(response([]))
      throw new Error(`unexpected request: ${url}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    render(<Page activePage="knowledge" />)
    fireEvent.click(screen.getByRole('tab', { name: /回收站/u }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复伙伴' }))
    expect(await screen.findByText('回收站是空的')).toBeTruthy()
    expect(restoredId).toBe('returning-3000')
  })
})
