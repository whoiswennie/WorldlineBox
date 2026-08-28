import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AuthOverlay } from './AuthOverlay.tsx'
import { AccountSettings } from './AccountSettings.tsx'
import {
  getAuthSnapshot,
  subscribeAuth,
  type AuthSnapshot,
} from './auth-store.ts'

/** Public reactive account identity used by presentation plugins. */
export interface AccountIdentity {
  getSnapshot(): AuthSnapshot
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    accountIdentity: AccountIdentity
  }
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.provide('accountIdentity', { getSnapshot: getAuthSnapshot, subscribe: subscribeAuth })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'worldline-auth', order: -100,
  }, AuthOverlay))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'account',
    order: -10,
    label: '账号主页',
  }, AccountSettings))
}
