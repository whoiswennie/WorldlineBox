// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { BrowserRenderBlock } from '../src/markdown/BrowserRenderBlock.tsx'

function useElectronRenderer(): void {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 Worldline Electron/41.10.3 Chrome/140.0.0.0',
  )
}

function decodedDocument(element: Element): string {
  const src = element.getAttribute('src') ?? ''
  const prefix = 'data:text/html;charset=utf-8;base64,'
  expect(src.startsWith(prefix)).toBe(true)
  const binary = atob(src.slice(prefix.length))
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MarkdownText browser render fences', () => {
  it('mounts settled HTML in the dedicated Electron guest and keeps source available', () => {
    useElectronRenderer()
    const source = '<button onclick="document.body.dataset.clicked=\'yes\'">Run</button>'
    const { container } = render(<MarkdownText text={`\`\`\`html\n${source}\n\`\`\``} />)
    const guest = container.querySelector('webview')

    expect(guest).not.toBeNull()
    expect(guest?.getAttribute('partition')).toBe('worldline-render')
    expect(decodedDocument(guest!)).toContain(source)
    expect(container.querySelector('button[onclick]')).toBeNull()
    expect(screen.getByText('查看源代码')).toBeTruthy()
    expect(container.querySelector('pre code')?.textContent).toContain(source)
  })

  it('keeps browser fences inert while streaming and activates on settle', () => {
    useElectronRenderer()
    const text = '```html\n<canvas id="chart"></canvas>\n```'
    const view = render(<MarkdownText text={text} streaming />)

    expect(view.container.querySelector('webview')).toBeNull()
    expect(view.container.querySelector('pre code')?.textContent).toContain('<canvas')
    view.rerender(<MarkdownText text={text} />)
    expect(view.container.querySelector('webview')).not.toBeNull()
  })

  it('accepts an iframe URL shorthand and a canvas JavaScript shorthand', () => {
    useElectronRenderer()
    const iframe = render(<MarkdownText text={
      '```iframe\n//music.163.com/outchain/player?id=42&auto=1&height=66\n```'
    } />)
    expect(iframe.container.querySelector('webview')?.getAttribute('src')).toBe(
      'https://music.163.com/outchain/player?id=42&auto=0&height=66',
    )
    expect((iframe.container.querySelector('figure') as HTMLElement).style.width).toBe('330px')
    const iframeViewport = iframe.container.querySelector('webview')?.parentElement as HTMLElement
    expect(iframeViewport.style.height).toBe('86px')
    expect(iframeViewport.style.minHeight).toBe('86px')
    iframe.unmount()

    const canvas = render(<MarkdownText text={'```canvas\nctx.fillRect(0, 0, 20, 20)\n```'} />)
    const canvasDocument = decodedDocument(canvas.container.querySelector('webview')!)
    expect(canvasDocument).toContain('<canvas id="canvas" width="800" height="450"></canvas>')
    expect(canvasDocument).toContain("const ctx=canvas.getContext('2d');ctx.fillRect")
  })

  it('promotes a lone official iframe to a first-party guest so storage-backed players initialize', () => {
    useElectronRenderer()
    const source = '<iframe frameborder="no" width=330 height=86 '
      + 'src="//music.163.com/outchain/player?type=2&amp;id=3425138553&amp;auto=1&amp;height=66"></iframe>'
    const { container } = render(<MarkdownText text={`\`\`\`html\n${source}\n\`\`\``} />)

    expect(container.querySelector('webview')?.getAttribute('src')).toBe(
      'https://music.163.com/outchain/player?type=2&id=3425138553&auto=0&height=66',
    )
    expect((container.querySelector('figure') as HTMLElement).style.width).toBe('330px')
    const viewport = container.querySelector('webview')?.parentElement as HTMLElement
    expect(viewport.style.height).toBe('86px')
    expect(viewport.style.minHeight).toBe('86px')
    expect(container.querySelector('pre code')?.textContent).toContain(source)
  })

  it('reports guest failures and reloads the same browser surface', () => {
    useElectronRenderer()
    const { container } = render(<MarkdownText text={'```html\n<p>hello</p>\n```'} />)
    const guest = container.querySelector('webview') as HTMLElement & { reloadIgnoringCache: () => void }
    guest.reloadIgnoringCache = vi.fn()
    fireEvent(guest, new Event('dom-ready'))
    expect(screen.queryByText('正在加载浏览器内容…')).toBeNull()

    fireEvent(guest, new Event('did-start-loading'))
    expect(screen.queryByText('正在加载浏览器内容…')).toBeNull()

    fireEvent(guest, Object.assign(new Event('did-start-navigation'), { isMainFrame: false }))
    expect(screen.queryByText('正在加载浏览器内容…')).toBeNull()

    fireEvent(guest, Object.assign(new Event('did-start-navigation'), { isMainFrame: true }))
    expect(screen.getByText('正在加载浏览器内容…')).toBeTruthy()
    fireEvent(guest, new Event('dom-ready'))
    expect(screen.queryByText('正在加载浏览器内容…')).toBeNull()

    fireEvent(guest, Object.assign(new Event('did-fail-load'), {
      errorCode: -105,
      errorDescription: 'NAME_NOT_RESOLVED',
    }))
    expect(screen.getByRole('alert').textContent).toContain('NAME_NOT_RESOLVED')
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(guest.reloadIgnoringCache).toHaveBeenCalledTimes(1)
    expect(screen.getByText('正在加载浏览器内容…')).toBeTruthy()
  })

  it('degrades explicitly outside Electron and bounds authored source size', () => {
    const browser = render(<MarkdownText text={'```svg\n<svg><circle r="4"/></svg>\n```'} />)
    expect(browser.container.querySelector('webview')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('桌面客户端')
    browser.unmount()

    useElectronRenderer()
    render(<BrowserRenderBlock source={'x'.repeat(512 * 1024 + 1)} kind="html" />)
    expect(screen.getByRole('status').textContent).toContain('超过 512 KB')
    expect(document.querySelector('webview')).toBeNull()
  })

  it('caps concurrent guest processes and promotes the next queued block', () => {
    useElectronRenderer()
    const blocks = Array.from({ length: 5 }, (_, index) => `block-${String(index)}`)
    const content = (values: readonly string[]) => <>{values.map(value => (
      <BrowserRenderBlock key={value} source={`<p>${value}</p>`} kind="html" />
    ))}</>
    const view = render(content(blocks))

    expect(view.container.querySelectorAll('webview')).toHaveLength(4)
    expect([...view.container.querySelectorAll('webview')].map(decodedDocument).join('\n')).not.toContain('block-4')
    view.rerender(content(blocks.slice(1)))
    expect(view.container.querySelectorAll('webview')).toHaveLength(4)
    expect([...view.container.querySelectorAll('webview')].map(decodedDocument).join('\n')).toContain('block-4')
  })

  it('keeps unfenced raw HTML literal instead of granting it a browser guest', () => {
    useElectronRenderer()
    const { container } = render(<MarkdownText text={'<iframe src="https://example.com"></iframe>'} />)
    expect(container.querySelector('webview')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('<iframe src="https://example.com"></iframe>')
  })
})
