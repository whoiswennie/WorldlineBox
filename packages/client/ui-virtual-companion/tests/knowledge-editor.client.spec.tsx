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
})
