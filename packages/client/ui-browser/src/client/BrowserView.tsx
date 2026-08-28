import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './BrowserView.module.css'

interface BrowserTab {
  id: string
  url: string
  title?: string
  active: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

interface BrowserSnapshot {
  available: boolean
  session?: string
  tabs: BrowserTab[]
  error?: string
}

type BrowserAction = 'switch' | 'close' | 'new' | 'navigate' | 'back' | 'forward' | 'reload'

function icon(kind: 'browser' | 'plus' | 'close' | 'back' | 'forward' | 'reload' | 'lock') {
  const content = kind === 'browser'
    ? <><circle cx="12" cy="12" r="8.5" /><path d="M3.8 9h16.4M3.8 15h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5S14.2 18.2 12 20.5C9.8 18.2 8.7 15.4 8.7 12S9.8 5.8 12 3.5Z" /></>
    : kind === 'plus' ? <path d="M12 5v14M5 12h14" />
      : kind === 'close' ? <path d="m7 7 10 10M17 7 7 17" />
        : kind === 'back' ? <path d="m14.5 6-6 6 6 6" />
          : kind === 'forward' ? <path d="m9.5 6 6 6-6 6" />
            : kind === 'reload' ? <><path d="M18.5 8A7 7 0 1 0 19 15" /><path d="M18.5 3.5V8h-4.7" /></>
              : <><rect x="5.5" y="10" width="13" height="9" rx="2" /><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" /></>
  return <svg viewBox="0 0 24 24" aria-hidden="true">{content}</svg>
}

function pageLabel(tab: BrowserTab): string {
  const title = tab.title?.trim()
  if (title !== undefined && title !== '') return title
  if (tab.url === '' || tab.url === 'about:blank') return '新标签页'
  try {
    const parsed = new URL(tab.url)
    return parsed.hostname.replace(/^www\./u, '') || tab.url
  } catch {
    return tab.url
  }
}

export function BrowserView({ sessionId }: ConvViewProps) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>({ available: false, tabs: [] })
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [previewRevision, setPreviewRevision] = useState(0)
  const [previewReady, setPreviewReady] = useState(false)
  const surface = useRef<HTMLDivElement | null>(null)
  const previewTimer = useRef<number | undefined>(undefined)
  const generatedSurfaceId = useId()
  const surfaceId = useMemo(() => `${sessionId}:${generatedSurfaceId}`, [generatedSurfaceId, sessionId])
  const endpoint = useMemo(() => `/worldline-browser?session=${encodeURIComponent(sessionId)}`, [sessionId])
  const nativeSurface = typeof navigator !== 'undefined' && /\bElectron\//u.test(navigator.userAgent)
  const activeTab = snapshot.tabs.find(tab => tab.active)
  const previewUrl = activeTab === undefined
    ? undefined
    : `${endpoint}&preview=1&width=1280&height=960&frame=${String(previewRevision)}`

  const read = useCallback(async (): Promise<BrowserSnapshot> => {
    const response = await fetch(endpoint, { cache: 'no-store' })
    const body = await response.json() as BrowserSnapshot & { error?: string }
    if (!response.ok) throw new Error(body.error ?? `浏览器状态读取失败（${String(response.status)}）`)
    setSnapshot(body)
    return body
  }, [endpoint])

  const post = useCallback(async (body: Record<string, unknown>): Promise<BrowserSnapshot> => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const value = await response.json() as BrowserSnapshot & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `浏览器操作失败（${String(response.status)}）`)
    setSnapshot(value)
    return value
  }, [endpoint])

  useEffect(() => {
    let stopped = false
    void read().catch((reason: unknown) => {
      if (!stopped) setError(reason instanceof Error ? reason.message : String(reason))
    })
    const timer = window.setInterval(() => {
      void read().catch((reason: unknown) => {
        if (!stopped) setError(reason instanceof Error ? reason.message : String(reason))
      })
    }, 1_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [read])

  useEffect(() => {
    setPreviewReady(false)
    if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current)
    if (activeTab !== undefined) setPreviewRevision(Date.now())
    return () => {
      if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current)
    }
  }, [activeTab?.id])

  const schedulePreview = (delay: number) => {
    if (previewTimer.current !== undefined) window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(() => { setPreviewRevision(Date.now()) }, delay)
  }

  useEffect(() => {
    const element = surface.current
    if (element === null) return
    let frame: number | undefined
    let pending: { active: boolean; bounds?: { x: number; y: number; width: number; height: number } } | undefined
    let sending = false
    let mounted = true
    const flush = async () => {
      if (sending) return
      sending = true
      while (pending !== undefined) {
        const value = pending
        pending = undefined
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'surface', surfaceId, native: nativeSurface, ...value }),
          })
          if (!response.ok) {
            const body = await response.json() as { error?: string }
            throw new Error(body.error ?? `浏览器边界更新失败（${String(response.status)}）`)
          }
        } catch (reason) {
          if (value.active && mounted) setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
      sending = false
    }
    const queue = (active: boolean) => {
      const rect = active ? surface.current?.getBoundingClientRect() : undefined
      pending = {
        active,
        ...(rect === undefined ? {} : {
          bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        }),
      }
      void flush()
    }
    const update = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        queue(document.querySelector('[data-native-browser-occluder]') === null)
      })
    }
    const observer = new ResizeObserver(update)
    const occlusionObserver = new MutationObserver(update)
    const occlusionRoot = document.querySelector('[data-native-browser-occlusion-root]')
      ?? document.body
    observer.observe(element)
    occlusionObserver.observe(occlusionRoot, {
      attributes: true,
      attributeFilter: ['data-native-browser-occluder'],
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', update)
    update()
    return () => {
      mounted = false
      observer.disconnect()
      occlusionObserver.disconnect()
      window.removeEventListener('resize', update)
      if (frame !== undefined) cancelAnimationFrame(frame)
      queue(false)
    }
  }, [endpoint, nativeSurface, surfaceId])

  useEffect(() => {
    setAddress(activeTab?.url ?? '')
  }, [activeTab?.id, activeTab?.url])

  const act = async (action: BrowserAction, extra: Record<string, unknown> = {}) => {
    setBusy(true)
    setError('')
    try {
      await post({ action, ...extra })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const navigate = () => {
    let target = address.trim()
    if (target === '') return
    if (!/^https?:\/\//iu.test(target)) target = `https://${target}`
    void act('navigate', { url: target })
  }

  const sendInput = useCallback((body: Record<string, unknown>) => {
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'input', ...body }),
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [endpoint])

  const pointerPosition = (
    event: ReactPointerEvent<HTMLImageElement> | ReactWheelEvent<HTMLImageElement>,
  ): { x: number; y: number } => {
    const image = event.currentTarget
    const rect = image.getBoundingClientRect()
    const naturalWidth = Math.max(1, image.naturalWidth)
    const naturalHeight = Math.max(1, image.naturalHeight)
    const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
    const width = naturalWidth * scale
    const height = naturalHeight * scale
    const left = rect.left + (rect.width - width) / 2
    const top = rect.top + (rect.height - height) / 2
    return {
      x: Math.max(0, Math.min(1, (event.clientX - left) / Math.max(1, width))),
      y: Math.max(0, Math.min(1, (event.clientY - top) / Math.max(1, height))),
    }
  }

  const mouseButton = (button: number): 'left' | 'middle' | 'right' =>
    button === 1 ? 'middle' : button === 2 ? 'right' : 'left'

  const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
    (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

  const pointer = (kind: 'down' | 'up', event: ReactPointerEvent<HTMLImageElement>) => {
    event.preventDefault()
    if (kind === 'down') event.currentTarget.focus()
    sendInput({
      kind,
      ...pointerPosition(event),
      button: mouseButton(event.button),
      clickCount: event.detail > 1 ? Math.min(event.detail, 3) : 1,
      modifiers: modifiers(event),
    })
  }

  const wheel = (event: ReactWheelEvent<HTMLImageElement>) => {
    event.preventDefault()
    sendInput({
      kind: 'wheel',
      ...pointerPosition(event),
      button: 'none',
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiers(event),
    })
  }

  const key = (event: ReactKeyboardEvent<HTMLImageElement>) => {
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    const shortcut = event.altKey || event.ctrlKey || event.metaKey
    sendInput({
      kind: 'key',
      ...(event.key.length === 1 && !shortcut ? { text: event.key } : { key: event.key, code: event.code }),
      modifiers: modifiers(event),
    })
  }

  return <section className={css.root} aria-label="浏览器" data-native-browser-surface>
    <div className={css.pageTabs} role="tablist" aria-label="浏览器页面">
      <span className={css.browserMark}>{icon('browser')}</span>
      <div className={css.tabScroller}>
        {snapshot.tabs.map(tab => <div
          role="tab"
          aria-selected={tab.active}
          className={css.pageTab}
          data-active={tab.active || undefined}
          key={tab.id}
          title={tab.url}
        >
          <button
            type="button"
            className={css.tabSelect}
            disabled={busy}
            onClick={() => { if (!tab.active) void act('switch', { tabId: tab.id }) }}
          ><span>{pageLabel(tab)}</span></button>
          <button
            type="button"
            className={css.tabClose}
            aria-label={`关闭 ${pageLabel(tab)}`}
            disabled={busy}
            onClick={() => { void act('close', { tabId: tab.id }) }}
          >{icon('close')}</button>
        </div>)}
      </div>
      <button type="button" className={css.iconButton} aria-label="新建浏览器页面" title="新建页面" disabled={busy || !snapshot.available} onClick={() => { void act('new') }}>{icon('plus')}</button>
    </div>
    <div className={css.navigation}>
      <button type="button" aria-label="后退" disabled={busy || activeTab === undefined || activeTab.canGoBack === false} onClick={() => { void act('back') }}>{icon('back')}</button>
      <button type="button" aria-label="前进" disabled={busy || activeTab === undefined || activeTab.canGoForward === false} onClick={() => { void act('forward') }}>{icon('forward')}</button>
      <button type="button" aria-label="刷新" disabled={busy || activeTab === undefined} onClick={() => { void act('reload') }}>{icon('reload')}</button>
      <form onSubmit={(event) => { event.preventDefault(); navigate() }}>
        <span>{icon('lock')}</span>
        <input aria-label="网址" placeholder="输入网址并按 Enter 访问" value={address} disabled={!snapshot.available || busy} onChange={(event) => { setAddress(event.currentTarget.value) }} />
      </form>
    </div>
    {error !== '' ? <div className={css.error} role="alert">{error}<button type="button" onClick={() => { setError(''); void read() }}>重试</button></div> : null}
    <div ref={surface} className={css.surface}>
      {previewUrl !== undefined ? <img
        className={css.preview}
        data-ready={previewReady || undefined}
        src={previewUrl}
        alt="浏览器页面实时预览"
        draggable={false}
        tabIndex={0}
        onLoad={() => { setPreviewReady(true); schedulePreview(250) }}
        onError={() => { setPreviewReady(false); schedulePreview(1_000) }}
        onPointerDown={(event) => { pointer('down', event) }}
        onPointerUp={(event) => { pointer('up', event) }}
        onWheel={wheel}
        onKeyDown={key}
      /> : null}
      {snapshot.tabs.length === 0 ? <div className={css.empty}>
        <span>{icon('browser')}</span>
        <strong>{snapshot.available ? '当前没有打开任何页面' : '当前环境不支持内置浏览器'}</strong>
        <p>{snapshot.available ? '在地址栏输入网站，或点击加号新建一个页面。' : '请使用世界线桌面客户端访问内置浏览器。'}</p>
      </div> : null}
    </div>
  </section>
}
