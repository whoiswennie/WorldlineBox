import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import type { MarkdownCodeLabels } from './render.tsx'
import css from './MarkdownText.module.css'

const RENDER_PARTITION = 'worldline-render'
const MAX_SOURCE_LENGTH = 512 * 1024
const MAX_ACTIVE_GUESTS = 4

interface GuestReservation {
  granted: boolean
  grant: () => void
}

let activeGuests = 0
const guestQueue: GuestReservation[] = []

function reserveGuest(grant: () => void): () => void {
  const reservation = { granted: false, grant }
  if (activeGuests < MAX_ACTIVE_GUESTS) {
    reservation.granted = true
    activeGuests += 1
    grant()
  } else {
    guestQueue.push(reservation)
  }
  return () => {
    if (!reservation.granted) {
      const index = guestQueue.indexOf(reservation)
      if (index >= 0) guestQueue.splice(index, 1)
      return
    }
    activeGuests -= 1
    const next = guestQueue.shift()
    if (next === undefined) return
    next.granted = true
    activeGuests += 1
    next.grant()
  }
}

export type BrowserRenderKind = 'html' | 'iframe' | 'canvas' | 'svg'

interface DirectRemoteTarget {
  url: string
  width?: number | undefined
  height?: number | undefined
}

interface BrowserGuestElement extends HTMLElement {
  reloadIgnoringCache(): void
}

interface GuestFailureEvent extends Event {
  errorCode?: number | undefined
  errorDescription?: string | undefined
}

interface GuestNavigationEvent extends Event {
  isMainFrame?: boolean | undefined
}

function renderLabel(kind: BrowserRenderKind): string {
  switch (kind) {
    case 'html': return 'HTML'
    case 'iframe': return 'iframe'
    case 'canvas': return 'Canvas'
    case 'svg': return 'SVG'
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function iframeMarkup(source: string): string {
  const value = source.trim()
  if (!/^(?:https?:)?\/\//i.test(value)) return source
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return source
    return `<iframe src="${escapeAttribute(url.href)}" title="嵌入内容" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="no-referrer"></iframe>`
  } catch {
    return source
  }
}

function normalizeRemoteUrl(value: string): string | undefined {
  const decoded = value
    .replaceAll(/&(?:amp|#38|#x26);/giu, '&')
    .trim()
  if (!/^(?:https?:)?\/\//iu.test(decoded)) return undefined
  try {
    const url = new URL(decoded.startsWith('//') ? `https:${decoded}` : decoded)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    // Product media cards are user-initiated: old transcripts must not restore autoplay.
    if (url.hostname === 'music.163.com' && url.pathname === '/outchain/player') {
      url.searchParams.set('auto', '0')
    }
    return url.href
  } catch {
    return undefined
  }
}

function iframeAttribute(attributes: string, name: 'width' | 'height' | 'src'): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    'iu',
  ).exec(attributes)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

function pixelDimension(value: string | undefined, maximum: number): number | undefined {
  if (value === undefined) return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/iu.exec(value)
  if (match === null) return undefined
  const parsed = Math.round(Number(match[1]))
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : undefined
}

function compactRemoteDimensions(value: string): Pick<DirectRemoteTarget, 'width' | 'height'> | undefined {
  const url = new URL(value)
  if (url.hostname !== 'music.163.com' || url.pathname !== '/outchain/player') return undefined
  const playerHeight = pixelDimension(url.searchParams.get('height') ?? undefined, 700) ?? 66
  return { width: 330, height: playerHeight + 20 }
}

/**
 * A lone iframe must become the guest's top-level page. Keeping it below a
 * generated data: document gives it an opaque third-party storage context;
 * older embeds such as NetEase Cloud Music then throw while reading
 * localStorage and leave an empty player even though every request succeeded.
 */
function directRemoteTarget(source: string, kind: BrowserRenderKind): DirectRemoteTarget | undefined {
  const value = source.trim()
  if (kind === 'iframe') {
    const direct = normalizeRemoteUrl(value)
    if (direct !== undefined) return { url: direct, ...compactRemoteDimensions(direct) }
  }
  const iframe = /^<iframe\b([^>]*)>\s*<\/iframe>$/isu.exec(value)
  if (iframe === null) return undefined
  const attributes = iframe[1] ?? ''
  const url = normalizeRemoteUrl(iframeAttribute(attributes, 'src') ?? '')
  if (url === undefined) return undefined
  const compact = compactRemoteDimensions(url)
  return {
    url,
    width: pixelDimension(iframeAttribute(attributes, 'width'), 2_560) ?? compact?.width,
    height: pixelDimension(iframeAttribute(attributes, 'height'), 720) ?? compact?.height,
  }
}

function canvasMarkup(source: string): string {
  if (/<(?:canvas|html|body|script|style)\b/iu.test(source)) return source
  // A canvas fence may be either complete markup or drawing JavaScript. The
  // shorthand supplies the conventional canvas/ctx bindings without eval.
  const script = source.replace(/<\/script/giu, '<\\/script')
  return `<canvas id="canvas" width="800" height="450"></canvas><script>const canvas=document.getElementById('canvas');const ctx=canvas.getContext('2d');${script}</script>`
}

function completeDocument(source: string, kind: BrowserRenderKind): string {
  const markup = kind === 'iframe'
    ? iframeMarkup(source)
    : kind === 'canvas'
      ? canvasMarkup(source)
      : source
  if (/<!doctype\s+html|<html(?:\s|>)/iu.test(markup)) {
    if (/<base(?:\s|>)/iu.test(markup)) return markup
    const head = /<head(?:\s[^>]*)?>/iu.exec(markup)
    if (head !== null) {
      const offset = head.index + head[0].length
      return `${markup.slice(0, offset)}<base href="https://worldline-render.invalid/">${markup.slice(offset)}`
    }
    const html = /<html(?:\s[^>]*)?>/iu.exec(markup)
    if (html !== null) {
      const offset = html.index + html[0].length
      return `${markup.slice(0, offset)}<head><base href="https://worldline-render.invalid/"></head>${markup.slice(offset)}`
    }
    return markup
  }
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<base href="https://worldline-render.invalid/">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>html{box-sizing:border-box}*,*::before,*::after{box-sizing:inherit}',
    'body{margin:0;padding:12px;min-height:1px;overflow-wrap:anywhere}',
    'iframe,img,svg,canvas,video{max-width:100%}iframe{width:100%;min-height:240px;border:0}</style>',
    '</head><body>', markup, '</body></html>',
  ].join('')
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function renderDataUrl(source: string, kind: BrowserRenderKind): string {
  return `data:text/html;charset=utf-8;base64,${base64Utf8(completeDocument(source, kind))}`
}

function electronRenderer(): boolean {
  return typeof navigator !== 'undefined' && /\bElectron\/\d/iu.test(navigator.userAgent)
}

/**
 * A real Chromium guest surface for settled HTML-family fences. Electron
 * keeps this guest in a separate, Node-free WebContents; the desktop policy
 * disables its CORS boundary without exposing the Worldline renderer.
 */
export function BrowserRenderBlock({ source, kind, codeLabels }: {
  source: string
  kind: BrowserRenderKind
  codeLabels?: MarkdownCodeLabels | undefined
}) {
  const guest = useRef<BrowserGuestElement | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [ready, setReady] = useState(false)
  const [admitted, setAdmitted] = useState(false)
  const desktop = electronRenderer()
  const sourceBytes = useMemo(() => new TextEncoder().encode(source).byteLength, [source])
  const oversized = sourceBytes > MAX_SOURCE_LENGTH
  const label = renderLabel(kind)
  const directTarget = useMemo(() => directRemoteTarget(source, kind), [kind, source])
  const guestUrl = useMemo(
    () => desktop && !oversized && admitted
      ? directTarget?.url ?? renderDataUrl(source, kind)
      : undefined,
    [admitted, desktop, directTarget, kind, oversized, source],
  )

  useEffect(() => {
    if (!desktop || oversized) {
      setAdmitted(false)
      return
    }
    return reserveGuest(() => { setAdmitted(true) })
  }, [desktop, oversized])

  useEffect(() => {
    setError(undefined)
    setReady(false)
  }, [guestUrl])

  useEffect(() => {
    const element = guest.current
    if (element === null) return
    const onReady = () => { setReady(true); setError(undefined) }
    const onNavigation = (event: Event) => {
      if ((event as GuestNavigationEvent).isMainFrame !== false) setReady(false)
    }
    const onFailure = (event: Event) => {
      const failure = event as GuestFailureEvent
      // -3 is Chromium's expected ERR_ABORTED during an explicit reload or navigation.
      if (failure.errorCode === -3) return
      setError(failure.errorDescription ?? '浏览器内容加载失败')
      setReady(false)
    }
    const onGone = () => {
      setError('浏览器渲染进程已退出，可重新加载此内容。')
      setReady(false)
    }
    element.addEventListener('dom-ready', onReady)
    element.addEventListener('did-start-navigation', onNavigation)
    element.addEventListener('did-fail-load', onFailure)
    element.addEventListener('render-process-gone', onGone)
    return () => {
      element.removeEventListener('dom-ready', onReady)
      element.removeEventListener('did-start-navigation', onNavigation)
      element.removeEventListener('did-fail-load', onFailure)
      element.removeEventListener('render-process-gone', onGone)
    }
  }, [guestUrl])

  const unavailable = oversized
    ? '内容超过 512 KB 的浏览器块上限，已保留为源代码。'
    : desktop
      ? '正在等待可用的浏览器渲染进程…'
      : '完整浏览器块仅在世界线桌面客户端中运行。'

  return (
    <figure
      className={css.browserRenderFigure}
      aria-label={`${label} 浏览器渲染`}
      style={directTarget?.width === undefined ? undefined : {
        width: `${String(directTarget.width)}px`,
        maxWidth: '100%',
      }}
    >
      <figcaption className={css.browserRenderHeader}>
        <span><strong>{label}</strong><small>完整浏览器渲染</small></span>
        {guestUrl !== undefined && (
          <button type="button" onClick={() => {
            setError(undefined)
            setReady(false)
            guest.current?.reloadIgnoringCache()
          }}>重新加载</button>
        )}
      </figcaption>
      {guestUrl === undefined ? (
        <div className={css.browserRenderUnavailable} role="status">{unavailable}</div>
      ) : (
        <div
          className={css.browserRenderViewport}
          aria-busy={!ready}
          style={directTarget?.height === undefined ? undefined : {
            height: `${String(directTarget.height)}px`,
            minHeight: `${String(directTarget.height)}px`,
          }}
        >
          {createElement('webview', {
            ref: (element: Element | null) => { guest.current = element as BrowserGuestElement | null },
            src: guestUrl,
            partition: RENDER_PARTITION,
            className: css.browserRenderGuest,
            'aria-label': `${label} 浏览器内容`,
          })}
          {!ready && error === undefined && <span className={css.browserRenderLoading}>正在加载浏览器内容…</span>}
        </div>
      )}
      {error !== undefined && <div className={css.browserRenderError} role="alert">{error}</div>}
      <details className={css.browserRenderSource}>
        <summary>查看源代码</summary>
        <CodeBlock
          code={`${source}\n`}
          lang={kind}
          copyLabel={codeLabels?.copyLabel}
          copiedLabel={codeLabels?.copiedLabel}
        />
      </details>
    </figure>
  )
}
