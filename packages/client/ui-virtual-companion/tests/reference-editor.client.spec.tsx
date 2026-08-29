// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import {
  inferReferenceTags,
  KnowledgeVaultPage,
  referenceTitleFromUrl,
} from '../src/client/KnowledgeVaultPage.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function response(value: unknown): Response {
  return new Response(JSON.stringify({ ok: true, value }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('reference quick add', () => {
  it('infers friendly metadata for video files and external URLs', () => {
    expect(inferReferenceTags({ type: 'video/mp4' })).toEqual(['视频', 'mp4'])
    expect(inferReferenceTags({ type: 'audio/mpeg' })).toEqual(['音频', 'mpeg'])
    expect(inferReferenceTags({ type: 'image/gif' })).toEqual(['图片', 'gif'])
    expect(referenceTitleFromUrl('https://example.com/assets/hello-world.mp4')).toBe('hello world')
  })

  it('keeps advanced metadata hidden while uploading a video through the quick path', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const NativeURL = URL
    vi.stubGlobal('URL', class extends NativeURL {
      static override createObjectURL = vi.fn(() => 'blob:video-preview')
      static override revokeObjectURL = vi.fn()
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.href
      requests.push({ url, ...(init === undefined ? {} : { init }) })
      if (url.endsWith('/api/virtual-companions'))
        return Promise.resolve(response({ companions: [], rooms: {} }))
      if (url.endsWith('/knowledge/tree')) return Promise.resolve(response([]))
      if (url.endsWith('/reference/tags')) return Promise.resolve(response([]))
      if (url.endsWith('/reference/search'))
        return Promise.resolve(response({ items: [], nextCursor: -1 }))
      if (url.endsWith('/reference/upload/prepare'))
        return Promise.resolve(response({ uploadId: 'stream-one' }))
      if (url.endsWith('/reference/upload/stream-one'))
        return Promise.resolve(response({
          id: 'video-1', scope: 'public', title: '孤高曼波.1596067136',
          description: '开心庆祝时播放', tags: ['视频', 'mp4'], transcript: '', mimeType: 'video/mp4',
          bytes: 5, source: { type: 'blob', hash: 'hash' }, enabled: true, builtIn: false,
          usageCount: 0, createdAt: 1, updatedAt: 1, url: '/video.mp4',
        }))
      throw new Error(`unexpected request: ${url}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    const view = render(<Page activePage="knowledge" />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '资源画廊' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '资源画廊' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '新增引用' })).toBeTruthy() })
    expect(screen.getByRole('button', { name: '筛选栏' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByPlaceholderText('搜索引用资料')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起筛选栏' }))
    expect(screen.queryByPlaceholderText('搜索引用资料')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '筛选栏' }))
    expect(screen.getByPlaceholderText('搜索引用资料')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新增引用' }))

    expect(screen.getByText('把资源放进来')).toBeTruthy()
    const advanced = screen.getByText('可检索文字').closest('details')
    expect(advanced?.open).toBe(false)
    const input = view.container.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('file input is missing')
    const video = new File(['video'], '孤高曼波.1596067136.mp4', { type: 'video/mp4' })
    fireEvent.change(input, { target: { files: [video] } })

    expect(screen.getByDisplayValue('孤高曼波.1596067136')).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除标签 视频' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除标签 mp4' })).toBeTruthy()
    expect(view.container.querySelector('video')?.getAttribute('src')).toBe('blob:video-preview')
    fireEvent.change(screen.getByPlaceholderText('例如：朋友遇到困难时，用来鼓励和打气'), {
      target: { value: '开心庆祝时播放' },
    })
    fireEvent.click(screen.getByText('可检索文字'))
    expect(advanced?.open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(requests.some(item => item.url.endsWith('/reference/upload/stream-one'))).toBe(true)
    })
    const prepare = requests.find(item => item.url.endsWith('/reference/upload/prepare'))
    const rawPrepareBody = prepare?.init?.body
    if (typeof rawPrepareBody !== 'string') throw new Error('upload preparation body is missing')
    const prepareBody = JSON.parse(rawPrepareBody) as { entry: Record<string, unknown> }
    const entry = prepareBody.entry
    expect(entry).toMatchObject({
      title: '孤高曼波.1596067136', mimeType: 'video/mp4', tags: ['视频', 'mp4'],
      description: '开心庆祝时播放',
    })
    const upload = requests.find(item => item.url.endsWith('/reference/upload/stream-one'))
    expect(upload?.init?.body).toBe(video)
    expect(upload?.init?.headers).toEqual({ 'content-type': 'video/mp4' })
  })

  it('lets the manager disable a resource without deleting it', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const asset = {
      id: 'pause-me', scope: 'public', enabled: true, title: '可暂停视频', description: '',
      tags: ['视频'], transcript: '', mimeType: 'video/mp4', bytes: 5,
      source: { type: 'link', url: 'https://example.com/video.mp4' }, builtIn: false,
      usageCount: 0, createdAt: 1, updatedAt: 1, url: 'https://example.com/video.mp4',
    }
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.href
      requests.push({ url, ...(init === undefined ? {} : { init }) })
      if (url.endsWith('/api/virtual-companions'))
        return Promise.resolve(response({ companions: [], rooms: {} }))
      if (url.endsWith('/knowledge/tree')) return Promise.resolve(response([]))
      if (url.endsWith('/reference/tags')) return Promise.resolve(response([{ tag: '视频', count: 1 }]))
      if (url.endsWith('/reference/search'))
        return Promise.resolve(response({ items: [asset], nextCursor: -1 }))
      if (url.endsWith('/reference/set-enabled'))
        return Promise.resolve(response({ ...asset, enabled: false }))
      throw new Error(`unexpected request: ${url}`)
    }))

    const Page = KnowledgeVaultPage as ComponentType<{ activePage: string }>
    render(<Page activePage="knowledge" />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '资源画廊' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '资源画廊' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '禁用引用 可暂停视频' })).toBeTruthy()
    })
    expect(screen.getByText('1 个标签')).toBeTruthy()
    expect(screen.getByRole('button', { name: /#视频/u }).getAttribute('data-tone')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '禁用引用 可暂停视频' }))

    await waitFor(() => {
      expect(requests.some(item => item.url.endsWith('/reference/set-enabled'))).toBe(true)
    })
    const toggle = requests.find(item => item.url.endsWith('/reference/set-enabled'))
    const toggleBody = toggle?.init?.body
    if (typeof toggleBody !== 'string') throw new Error('toggle body is missing')
    expect(JSON.parse(toggleBody)).toEqual({ scope: 'public', id: 'pause-me', enabled: false })
    const search = requests.find(item => item.url.endsWith('/reference/search'))
    const searchBody = search?.init?.body
    if (typeof searchBody !== 'string') throw new Error('search body is missing')
    expect(JSON.parse(searchBody)).toMatchObject({ includeDisabled: true })
  })
})
