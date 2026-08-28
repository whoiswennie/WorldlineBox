import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BrowserView } from './BrowserView.tsx'
import { browserNavigation, installBrowserLinkRouting } from './link-routing.ts'

export type { BrowserNavigation } from './link-routing.ts'

export const inject = ['slots', 'sessions', 'conversation', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.provide('browserNavigation', browserNavigation(ctx))
  installBrowserLinkRouting(ctx)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'browser',
    order: 30,
    label: '浏览器',
    inject: (_sessionId: SessionId) => ({}),
  }, BrowserView))
}
