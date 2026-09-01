/**
 * Child-process entry for the Win32 folder dialog: blocks THIS process
 * inside the modal `Show` so the host event loop stays live, reporting over
 * the IPC channel. Spawned as a child process (not a worker thread) so the
 * dialog is the process's first window and Windows activates it without a
 * manual foreground call. Protocol: `{kind:'showing',threadId}` right
 * before the blocking call (the driver's abort lever needs the native
 * thread id), then exactly one of `{kind:'done',path}` or
 * `{kind:'error',message}`.
 */

import { loadWin32DialogBindings } from './win32-dialog-bindings.ts'
import { runPathDialog } from './win32-dialog-logic.ts'
import { createDialogMessenger } from './win32-dialog-messenger.ts'
import type { PathPickerRequest } from '@deepseek-ai/dsh-host-directory-picker'

/** The driver-to-child payload: the dialog title (passed via env). */
export interface Win32DialogWorkerData { request: PathPickerRequest }

/** One notice or outcome posted back to the driver. */
export type Win32DialogWorkerMessage =
  | { kind: 'showing'; threadId: number }
  | { kind: 'done'; path: string | null }
  | { kind: 'error'; message: string }

const encodedRequest = process.env.WORLDLINE_DIALOG_REQUEST ?? ''
if (encodedRequest === '') throw new Error('win32-dialog-worker: WORLDLINE_DIALOG_REQUEST is required')
const request = JSON.parse(encodedRequest) as PathPickerRequest
if (process.send === undefined) throw new Error('win32-dialog-worker must run as a child process with an IPC channel')
const messenger = createDialogMessenger({
  get connected() { return process.connected },
  send(message, callback) {
    if (callback === undefined) return process.send?.(message) ?? false
    return process.send?.(message, callback) ?? false
  },
  disconnect() { process.disconnect() },
})

// A settled driver (or a dead parent) must not orphan a dialog still on screen.
/* v8 ignore next 3 -- the handler exits(0), which would kill the unit lane; built-worker.e2e.ts owns the real disconnect lifecycle. */
process.on('disconnect', () => process.exit(0))

// No top-level await: the built worker ships as CJS, which cannot carry TLA.
void (async () => {
  try {
    const bindings = await loadWin32DialogBindings()
    const path = runPathDialog(bindings, request, (threadId) => {
      messenger.progress({ kind: 'showing', threadId })
    })
    messenger.terminal({ kind: 'done', path })
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    messenger.terminal({ kind: 'error', message })
  }
})()
