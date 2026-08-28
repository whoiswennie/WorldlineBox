import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/cordis'

type BrowserLinkContext = Pick<ClientContext, 'conversation' | 'effect' | 'layout' | 'sessions'>

/** Browser navigation operations shared with other client plugins. */
export interface BrowserNavigation {
  /** Open an HTTP(S) URL in the session's embedded browser and select that view. */
  openWeb(sessionId: SessionId, url: string): Promise<void>
  openLocal(sessionId: SessionId, workspaceRoot: string, path: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserNavigation: BrowserNavigation
  }
}

function httpLink(target: EventTarget | null): HTMLAnchorElement | undefined {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const anchor = element?.closest<HTMLAnchorElement>('a[href]')
  if (anchor === null || anchor === undefined || anchor.hasAttribute('download')) return undefined
  try {
    const protocol = new URL(anchor.href, window.location.href).protocol
    return protocol === 'http:' || protocol === 'https:' ? anchor : undefined
  } catch {
    return undefined
  }
}

/**
 * Open one user-clicked web link through the current conversation's embedded browser.
 * @param ctx - conversation and session services for the active client.
 * @param sessionId - conversation that owns the browser tab.
 * @param url - absolute HTTP(S) destination.
 */
export async function openConversationBrowserLink(
  ctx: BrowserLinkContext,
  sessionId: SessionId,
  url: string,
): Promise<void> {
  await postBrowserAction(ctx, sessionId, { action: 'open', url })
}

async function postBrowserAction(
  ctx: Pick<BrowserLinkContext, 'conversation' | 'layout'>,
  sessionId: SessionId,
  action: Record<string, unknown>,
): Promise<void> {
  const endpoint = `/worldline-browser?session=${encodeURIComponent(sessionId)}`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  })
  const value = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(value.error ?? `浏览器链接打开失败（${String(response.status)}）`)
  const returningToConversation = ctx.layout.activePage() !== 'conversation'
  ctx.layout.activatePage('conversation')
  if (returningToConversation) {
    // Feature pages replace the conversation tree. Let React mount the target
    // session header before dispatching its view-selection event.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  }
  ctx.conversation.selectView(sessionId, 'browser')
}

/**
 * Create the browser-navigation service bound to one client context.
 * @param ctx - conversation service used to select the browser view.
 * @returns the bound navigation service.
 */
export function browserNavigation(
  ctx: Pick<BrowserLinkContext, 'conversation' | 'layout'>,
): BrowserNavigation {
  return {
    openWeb: async (sessionId, url) => {
      if (!/^https?:\/\//iu.test(url)) throw new Error('仅支持 HTTP(S) 网页地址')
      await postBrowserAction(ctx, sessionId, { action: 'open', url })
    },
    openLocal: async (sessionId, workspaceRoot, path) => {
      await postBrowserAction(ctx, sessionId, { action: 'open-local', workspaceRoot, path })
    },
  }
}

/**
 * Route ordinary HTTP(S) anchors at the Cordis client boundary. This covers
 * assistant Markdown, trajectory links, and future plug-in surfaces without
 * teaching any renderer about Electron or the third-party browser plug-in.
 * @param ctx - client context owning the event-listener effect.
 */
export function installBrowserLinkRouting(ctx: BrowserLinkContext): void {
  ctx.effect(() => {
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = httpLink(event.target)
      const sessionId = ctx.sessions.list.getSnapshot().current
      if (anchor === undefined || sessionId === undefined) return

      // Prevent Electron's target=_blank path synchronously. The project Host
      // owns navigation and will create/select an in-app browser tab instead.
      event.preventDefault()
      event.stopPropagation()
      void openConversationBrowserLink(ctx, sessionId, anchor.href).catch((error: unknown) => {
        window.dispatchEvent(new CustomEvent('worldline-browser-link-error', { detail: error }))
      })
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, 'browser: route web links into the current conversation tab')
}
