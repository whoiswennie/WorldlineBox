import { describe, expect, it, vi } from 'vitest'
import { createDialogMessenger, type DialogMessageChannel } from '../src/win32-dialog-messenger.ts'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

class FakeChannel implements DialogMessageChannel {
  connected = true
  readonly pending: Array<() => void> = []
  readonly messages: Win32DialogWorkerMessage[] = []
  disconnect = vi.fn(() => { this.connected = false })
  send = vi.fn((message: Win32DialogWorkerMessage, callback?: (error: Error | null) => void) => {
    this.messages.push(message)
    if (callback !== undefined) this.pending.push(() => { callback(null) })
    return true
  })
}

describe('createDialogMessenger', () => {
  it('keeps IPC connected after showing and disconnects only after the terminal message flushes', () => {
    const channel = new FakeChannel()
    const messenger = createDialogMessenger(channel)

    messenger.progress({ kind: 'showing', threadId: 27 })
    expect(channel.messages).toEqual([{ kind: 'showing', threadId: 27 }])
    expect(channel.pending).toHaveLength(0)
    expect(channel.disconnect).not.toHaveBeenCalled()

    messenger.terminal({ kind: 'done', path: 'C:\\workspace' })
    expect(channel.messages.at(-1)).toEqual({ kind: 'done', path: 'C:\\workspace' })
    expect(channel.disconnect).not.toHaveBeenCalled()

    channel.pending[0]?.()
    expect(channel.disconnect).toHaveBeenCalledOnce()
  })
})
