/**
 * Service Definition for conversation-owned native browser automation.
 * Providers retain native objects and enforce Session/tab ownership; consumers
 * contribute model tools or other policies without importing Electron.
 * @module @deepseek-ai/dsh-browser
 */

import type { BrowserAction, BrowserController } from './types.ts'

/** Stable action vocabulary shared by providers and model-facing adapters. */
export const BROWSER_ACTIONS = [
  'list', 'open', 'focus', 'close', 'state', 'navigate', 'reload', 'back', 'forward', 'stop',
  'snapshot', 'html', 'text', 'screenshot', 'evaluate', 'click', 'fill', 'type', 'press',
  'select', 'wait_for_selector', 'wait_for_load', 'console', 'network', 'clear_logs', 'devtools', 'cdp',
] as const satisfies readonly BrowserAction[]

export type {
  BrowserAction,
  BrowserCommand,
  BrowserCommandResult,
  BrowserController,
  BrowserExecutionOptions,
  BrowserTabSnapshot,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserController: BrowserController
  }
}
