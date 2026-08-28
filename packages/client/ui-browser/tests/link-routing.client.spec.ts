// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { installBrowserLinkRouting } from '../src/client/link-routing.ts'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(current: SessionId | undefined, currentPage = 'conversation') {
  const selectView = vi.fn()
  const activatePage = vi.fn()
  let dispose = () => {}
  const ctx = {
    conversation: { selectView },
    layout: { activatePage, activePage: () => currentPage },
    sessions: { list: { getSnapshot: () => ({ current }) } },
    effect: (apply: () => (() => void)) => { dispose = apply(); return dispose },
  } as unknown as ClientContext
  installBrowserLinkRouting(ctx)
  return { ctx, selectView, activatePage, dispose }
}

describe('browser link routing', () => {
  it('returns from Settings before selecting the current conversation Browser view', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ available: true, tabs: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const { selectView, activatePage, dispose } = setup('session-1' as SessionId, 'settings')
    const anchor = document.createElement('a')
    anchor.href = 'https://search.bilibili.com/all?keyword=%E5%A4%A9%E5%B9%BB'
    anchor.target = '_blank'
    anchor.textContent = '搜索结果'
    document.body.append(anchor)

    const allowed = fireEvent.click(anchor)

    expect(allowed).toBe(false)
    await vi.waitFor(() => { expect(selectView).toHaveBeenCalledWith('session-1', 'browser') })
    expect(activatePage).toHaveBeenCalledWith('conversation')
    expect(activatePage.mock.invocationCallOrder[0]).toBeLessThan(selectView.mock.invocationCallOrder[0] ?? 0)
    expect(fetchMock).toHaveBeenCalledWith('/worldline-browser?session=session-1', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'open', url: anchor.href }),
    }))
    dispose()
  })

  it('leaves non-web links and pages without a current conversation alone', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { activatePage, dispose } = setup(undefined)
    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/'
    document.body.append(anchor)
    let routed = false
    anchor.addEventListener('click', (event) => { routed = event.defaultPrevented; event.preventDefault() })

    fireEvent.click(anchor)
    expect(routed).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(activatePage).not.toHaveBeenCalled()
    dispose()
  })
})
