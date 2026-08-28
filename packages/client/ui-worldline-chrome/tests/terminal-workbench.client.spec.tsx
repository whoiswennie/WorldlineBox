// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { TerminalWorkbench } from '../src/client/TerminalWorkbench.tsx'

const terminalMock = vi.hoisted(() => ({
  onData: undefined as ((data: string) => void) | undefined,
  keyHandler: undefined as ((event: KeyboardEvent) => boolean) | undefined,
  writes: [] as string[],
  selection: 'selected output',
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 30
    loadAddon(): void {}
    open(): void {}
    onData(listener: (data: string) => void): { dispose(): void } {
      terminalMock.onData = listener
      return { dispose: () => {} }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      terminalMock.keyHandler = handler
    }
    write(data: string): void { terminalMock.writes.push(data) }
    reset(): void {}
    clear(): void {}
    focus(): void {}
    dispose(): void {}
    getSelection(): string { return terminalMock.selection }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  terminalMock.onData = undefined
  terminalMock.keyHandler = undefined
  terminalMock.writes = []
})

describe('integrated terminal workbench', () => {
  it('creates a persistent PTY, streams raw output, writes keys, and exposes controls', async () => {
    const sessionId = 'terminal-session' as SessionId
    const spawn = vi.fn(async () => ({
      sessionId: 'pty-1', type: 'shell', pid: 42,
      status: { kind: 'running' as const }, motd: '',
    }))
    const readRaw = vi.fn(async () => ({
      data: 'PowerShell\r\nPS C:\\workspace> ', cursor: 29, reset: false, truncated: false,
    }))
    const write = vi.fn(async () => {})
    const interrupt = vi.fn(async () => {})
    render(<TerminalWorkbench {...({
      sessionId,
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      list: vi.fn(async () => ({ backends: ['shell'], sessions: [] })),
      spawn,
      readRaw,
      write,
      resize: vi.fn(async () => {}),
      interrupt,
      kill: vi.fn(async () => {}),
    } as ComponentProps<typeof TerminalWorkbench>)} />)

    expect(await screen.findByRole('tab', { name: /shell 1/ })).toBeTruthy()
    expect(spawn).toHaveBeenCalledWith(sessionId, 'shell', 'C:\\workspace')
    await waitFor(() => { expect(readRaw).toHaveBeenCalledWith(sessionId, 'pty-1', 0) })
    await waitFor(() => { expect(terminalMock.writes).toContain('PowerShell\r\nPS C:\\workspace> ') })

    terminalMock.onData?.('Get-Location\r')
    await waitFor(() => { expect(write).toHaveBeenCalledWith(sessionId, 'pty-1', 'Get-Location\r') })
    expect(terminalMock.keyHandler?.(new KeyboardEvent('keydown', {
      key: 'v', ctrlKey: true, shiftKey: true,
    }))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '中断' }))
    await waitFor(() => { expect(interrupt).toHaveBeenCalledWith(sessionId, 'pty-1') })
  })
})
