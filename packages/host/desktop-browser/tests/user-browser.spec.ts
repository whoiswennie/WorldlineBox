import { describe, expect, it, vi } from 'vitest'
import { UserBrowserRuntime, type ElectronViewHandle } from '../src/user-browser.ts'

function fixture() {
  const commands: Array<{ id: string; method: string; params?: Record<string, unknown> }> = []
  const destroyed: string[] = []
  const shown: string[] = []
  let hidden = 0
  let next = 0
  const createView = (): ElectronViewHandle => {
    const id = `view-${String(++next)}`
    return {
      id,
      sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        commands.push(params === undefined ? { id, method } : { id, method, params })
        if (method === 'Page.getNavigationHistory') {
          return {
            currentIndex: 1,
            entries: [
              { id: 10, url: 'https://first.example/', title: 'First page' },
              { id: 11, url: 'https://second.example/', title: 'Second page' },
              { id: 12, url: 'https://third.example/', title: 'Third page' },
            ],
          }
        }
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { clientWidth: 1000, clientHeight: 500 } }
        }
        return {}
      }),
      drainEvents: vi.fn(async () => []),
      setDevTools: vi.fn(async (open?: boolean) => open ?? true),
      capturePreview: vi.fn(async () => ({ mimeType: 'image/jpeg' as const, data: 'aGVsbG8=', sequence: 1 })),
    }
  }
  const runtime = new UserBrowserRuntime({
    createView,
    destroyView: (handle) => { destroyed.push(handle.id) },
    showView: (handle) => { shown.push(handle.id) },
    hideView: () => { hidden += 1 },
  })
  return { runtime, commands, destroyed, shown, hidden: () => hidden }
}

describe('UserBrowserRuntime', () => {
  it('owns direct user navigation independently for each conversation', async () => {
    const { runtime, commands, shown } = fixture()
    await runtime.openUrl('session-a', 'https://example.com/')
    await runtime.openUrl('session-b', 'https://openai.com/')

    expect(commands.filter(command => command.method === 'Page.navigate')).toEqual([
      { id: 'view-1', method: 'Page.navigate', params: { url: 'https://example.com/' } },
      { id: 'view-2', method: 'Page.navigate', params: { url: 'https://openai.com/' } },
    ])
    expect(shown).toEqual(['view-1', 'view-2'])
    expect(await runtime.listTabs('session-a')).toEqual([
      expect.objectContaining({ url: 'https://second.example/', title: 'Second page' }),
    ])
  })

  it('supports tabs, switching, closing, history navigation, and reload', async () => {
    const { runtime, commands, destroyed, shown } = fixture()
    await runtime.openUrl('session', 'https://one.example/')
    await runtime.openUrl('session', 'about:blank', true)
    const tabs = await runtime.listTabs('session')
    const navigationCount = commands.filter(command => command.method === 'Page.navigate').length
    runtime.switchTab('session', tabs[0]!.id)
    expect(commands.filter(command => command.method === 'Page.navigate')).toHaveLength(navigationCount)
    await runtime.back('session')
    await runtime.forward('session')
    await runtime.reload('session')
    runtime.closeTab('session', tabs[0]!.id)

    expect(commands.some(command => command.method === 'Page.navigateToHistoryEntry'
      && command.params?.entryId === 10)).toBe(true)
    expect(commands.some(command => command.method === 'Page.navigateToHistoryEntry'
      && command.params?.entryId === 12)).toBe(true)
    expect(commands.some(command => command.method === 'Page.reload')).toBe(true)
    expect(destroyed).toEqual(['view-1'])
    expect(shown.at(-1)).toBe('view-2')
  })

  it('captures the active compositor frame and forwards normalized preview input', async () => {
    const { runtime, commands } = fixture()
    await runtime.openUrl('session', 'https://example.com/')

    await expect(runtime.capturePreview('session', 1280, 960)).resolves.toEqual({
      mimeType: 'image/jpeg', data: 'aGVsbG8=', sequence: 1,
    })
    await runtime.dispatchPointer('session', { kind: 'down', x: 0.25, y: 0.5 })
    await runtime.dispatchKeyboard('session', { text: '幻' })
    await runtime.dispatchKeyboard('session', { key: 'Enter', code: 'Enter' })

    const pointerCommand = commands.find(command => command.method === 'Input.dispatchMouseEvent')
    expect(pointerCommand?.params).toMatchObject({ type: 'mousePressed', x: 250, y: 250 })
    expect(commands).toContainEqual(expect.objectContaining({
      method: 'Input.insertText', params: { text: '幻' },
    }))
    expect(commands.filter(command => command.method === 'Input.dispatchKeyEvent')).toHaveLength(2)
  })

  it('rejects non-web navigation and disposes every owned view', async () => {
    const { runtime, destroyed } = fixture()
    await expect(runtime.openUrl('session', 'file:///secret')).rejects.toThrow(/HTTP\(S\)/u)
    await runtime.openUrl('session', 'https://one.example/')
    await runtime.openUrl('session', 'https://two.example/', true)
    runtime.dispose()
    expect(destroyed).toEqual(['view-1', 'view-2'])
  })

  it('restores the active tab per conversation and hides the native layer for an empty conversation', async () => {
    const { runtime, shown, hidden } = fixture()
    await runtime.openUrl('session-a', 'https://one.example/')
    await runtime.openUrl('session-b', 'https://two.example/')

    runtime.activateSession('session-a')
    expect(shown.at(-1)).toBe('view-1')
    runtime.activateSession('session-empty')
    expect(hidden()).toBe(1)
    expect(await runtime.listTabs('session-a')).toHaveLength(1)
    expect(await runtime.listTabs('session-b')).toHaveLength(1)
  })

  it('bounds the in-memory conversation cache and destroys the least-recently-used native views', async () => {
    const { runtime, destroyed } = fixture()
    for (let index = 1; index <= 9; index += 1) {
      await runtime.openUrl(`session-${String(index)}`, `https://${String(index)}.example/`)
    }

    expect(destroyed).toContain('view-1')
    expect(await runtime.listTabs('session-1')).toEqual([])
    expect(await runtime.listTabs('session-9')).toHaveLength(1)
  })

  it('caps tabs per conversation instead of retaining unbounded native views', async () => {
    const { runtime } = fixture()
    await runtime.openUrl('session', 'https://1.example/')
    for (let index = 2; index <= 12; index += 1) {
      await runtime.openUrl('session', `https://${String(index)}.example/`, true)
    }

    await expect(runtime.openUrl('session', 'https://13.example/', true)).rejects.toThrow(/最多保留 12/u)
    expect(await runtime.listTabs('session')).toHaveLength(12)
  })
})
