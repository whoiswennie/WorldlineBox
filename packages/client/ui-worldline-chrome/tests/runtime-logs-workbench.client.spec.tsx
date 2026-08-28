// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { RuntimeLogsWorkbench } from '../src/client/RuntimeLogsWorkbench.tsx'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('runtime logs workbench', () => {
  it('polls bounded logs, filters levels, copies rows, and records only on request', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    let recording: { active: boolean; path?: string } = { active: false }
    const read = vi.fn(async () => ({
      entries: [
        { sequence: 1, timestamp: 1, level: 'info' as const, source: 'loader', message: 'ready' },
        { sequence: 2, timestamp: 2, level: 'error' as const, source: 'agent', message: 'failed' },
      ],
      nextCursor: 2,
      dropped: false,
      recording,
    }))
    const startRecording = vi.fn(async () => {
      recording = { active: true, path: 'C:\\logs\\runtime.jsonl' }
      return { active: true as const, path: recording.path }
    })
    render(<RuntimeLogsWorkbench {...({
      sessionId: 's',
      useSessions: () => undefined,
      read,
      startRecording,
      stopRecording: vi.fn(async () => {
        recording = { active: false }
        return { active: false as const }
      }),
      openPath: vi.fn(async () => {}),
    } as unknown as ComponentProps<typeof RuntimeLogsWorkbench>)} />)

    expect(await screen.findByText('failed')).toBeTruthy()
    expect(screen.getByText('ready')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'info' }))
    expect(screen.queryByText('ready')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '复制当前视图' }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[ERROR] agent failed')) })

    fireEvent.click(screen.getByRole('button', { name: /记录到文件/ }))
    await waitFor(() => { expect(startRecording).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('停止记录')).toBeTruthy()
  })
})
