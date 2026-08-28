import type { Win32DialogWorkerMessage } from './win32-dialog-worker.ts'

/** IPC surface used by the Win32 dialog child. Kept small so ordering is testable without opening COM UI. */
export interface DialogMessageChannel {
  readonly connected: boolean
  send(message: Win32DialogWorkerMessage, callback?: (error: Error | null) => void): boolean
  disconnect(): void
}

/** Ordered progress and terminal delivery for one Win32 dialog worker. */
export interface DialogMessenger {
  /** Progress keeps IPC alive; a later terminal result still has to cross the same channel. */
  progress(message: Extract<Win32DialogWorkerMessage, { kind: 'showing' }>): void
  /** Terminal delivery owns channel shutdown and disconnects only after Node flushes the message. */
  terminal(message: Exclude<Win32DialogWorkerMessage, { kind: 'showing' }>): void
}

/**
 * Build the ordered worker messenger. In particular, never disconnect from
 * the callback of `showing`: the native `Show` call blocks this process and
 * its final result is posted only after that call returns.
 * @param channel - connected worker IPC channel.
 * @returns ordered messenger bound to the channel.
 */
export function createDialogMessenger(channel: DialogMessageChannel): DialogMessenger {
  return {
    progress(message) {
      channel.send(message)
    },
    terminal(message) {
      channel.send(message, () => {
        if (channel.connected) channel.disconnect()
      })
    },
  }
}
