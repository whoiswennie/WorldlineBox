// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BrowserView } from '../src/client/BrowserView.tsx'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function json(value: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
}

function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : ''
}

const tabs = [
  {
    id: 'one', url: 'https://example.com/a', title: 'Example article',
    active: true, canGoBack: true, canGoForward: true,
  },
  {
    id: 'two', url: 'https://openai.com/', title: 'OpenAI',
    active: false, canGoBack: false, canGoForward: false,
  },
  {
    id: 'three', url: 'https://fallback.example/docs',
    active: false, canGoBack: false, canGoForward: false,
  },
]

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('BrowserView', () => {
  it('renders embedded multi-page tabs and routes tab operations through the host endpoint', async () => {
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ available: true, session: 'browser-1', tabs })
      return json({ available: true, session: 'browser-1', tabs })
    })
    vi.stubGlobal('fetch', fetchMock)
    const props = { sessionId: 'session-1' } as unknown as ConvViewProps
    render(<BrowserView {...props} />)

    expect((await screen.findByRole('tab', { name: /Example article/u })).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /OpenAI/u }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tab', { name: /fallback\.example/u })).toBeTruthy()
    const preview = screen.getByAltText('浏览器页面实时预览')
    expect(preview.getAttribute('src')).toContain('preview=1')
    fireEvent.pointerDown(preview, { clientX: 10, clientY: 10, button: 0 })
    fireEvent.keyDown(preview, { key: 'Enter', code: 'Enter' })

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('"action":"switch"'))).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '关闭 OpenAI' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('"action":"close"'))).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '新建浏览器页面' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('"action":"new"'))).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('"action":"back"'))).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('"action":"forward"'))).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('"action":"reload"'))).toBe(true)
    })
    fireEvent.change(screen.getByRole('textbox', { name: '网址' }), { target: { value: 'example.org/docs' } })
    fireEvent.submit(screen.getByRole('textbox', { name: '网址' }).closest('form')!)

    await waitFor(() => {
      const actions = fetchMock.mock.calls
        .map(([, init]) => {
          const body = bodyText(init)
          return body === '' ? undefined : JSON.parse(body) as { action?: string }
        })
        .map(body => body?.action)
      expect(actions).toContain('switch')
      expect(actions).toContain('close')
      expect(actions).toContain('new')
      expect(actions).toContain('back')
      expect(actions).toContain('forward')
      expect(actions).toContain('reload')
      expect(actions).toContain('input')
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('https://example.org/docs'))).toBe(true)
      expect(fetchMock.mock.calls.some(([, init]) => {
        const body = bodyText(init)
        return body.includes('"action":"surface"') && body.includes('"native":false')
      })).toBe(true)
    })
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('session=session-1'))).toBe(true)
  })

  it('keeps direct navigation available before a page exists without requiring a plug-in', async () => {
    const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
      json({ available: true, session: 'user:session-2', tabs: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const props = { sessionId: 'session-2' } as unknown as ConvViewProps
    render(<BrowserView {...props} />)

    expect(await screen.findByText('当前没有打开任何页面')).toBeTruthy()
    expect(screen.queryByText(/dsh-builtin-browser/u)).toBeNull()
    expect(screen.getByRole('button', { name: '新建浏览器页面' })).toHaveProperty('disabled', false)
    const input = screen.getByRole('textbox', { name: '网址' })
    expect(input).toHaveProperty('disabled', false)
    fireEvent.change(input, { target: { value: 'www.bilibili.com' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => bodyText(init).includes('https://www.bilibili.com'))).toBe(true)
    })
  })

  it('yields the native Electron surface while a renderer popover is open', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Worldline Electron/40.0.0')
    const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
      json({ available: true, session: 'browser-overlay', tabs }))
    vi.stubGlobal('fetch', fetchMock)
    const props = { sessionId: 'browser-overlay' } as unknown as ConvViewProps
    render(<BrowserView {...props} />)

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => {
        const body = bodyText(init)
        return body.includes('"action":"surface"')
          && body.includes('"native":true')
          && body.includes('"active":true')
      })).toBe(true)
    })

    const popover = document.createElement('div')
    popover.setAttribute('data-native-browser-occluder', '')
    document.body.append(popover)
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => {
        const body = bodyText(init)
        return body.includes('"action":"surface"')
          && body.includes('"native":true')
          && body.includes('"active":false')
      })).toBe(true)
    })

    fetchMock.mockClear()
    popover.remove()
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => {
        const body = bodyText(init)
        return body.includes('"action":"surface"')
          && body.includes('"active":true')
      })).toBe(true)
    })
  })

  it('closes the final page, clears the address, and renders the explicit empty state', async () => {
    let current = [tabs[0]!]
    const fetchMock = vi.fn((_input: string | URL, init?: RequestInit) => {
      const body = bodyText(init)
      if (body.includes('"action":"close"')) current = []
      return json({ available: true, session: 'user:session-3', tabs: current })
    })
    vi.stubGlobal('fetch', fetchMock)
    const props = { sessionId: 'session-3' } as unknown as ConvViewProps
    render(<BrowserView {...props} />)

    expect(await screen.findByDisplayValue('https://example.com/a')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭 Example article' }))

    expect(await screen.findByText('当前没有打开任何页面')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '网址' })).toHaveProperty('value', '')
  })
})
