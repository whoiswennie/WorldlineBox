import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import type { ILayout } from './service.ts'
import css from './AppFrame.module.css'

export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<
    | 'sidebar'
    | 'conversation'
    | 'details'
    | 'shell.overlay'
    | 'worldline.rail.primary'
    | 'worldline.rail.bottom'
    | 'worldline.topbar.leading'
    | 'worldline.topbar.center'
    | 'worldline.topbar.trailing'
    | 'worldline.status.left'
    | 'worldline.status.right'
    | 'worldline.main.page'
    | 'worldline.workspace.right'
  >
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & InjectFace<{ navigation: ILayout }>

function CenterColumn(props: { children?: ReactNode }) {
  return <main className={css.centerCol}>{props.children}</main>
}

function DetailsColumn(props: { children?: ReactNode }) {
  return <aside className={css.detailsCol}>{props.children}</aside>
}

function DragHandle(props: {
  side: 'sidebar' | 'details'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = event.clientX
    latest.current = event.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  renderSlotChain,
  navigation,
}: AppFrameProps) {
  const panels = useStore(state => state)
  const activePage = useSyncExternalStore(
    listener => navigation.subscribePage(listener),
    () => navigation.activePage(),
    () => 'conversation',
  )
  const detailsSession = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === false ? current : undefined
  })
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const lastSession = useRef(detailsSession)

  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) actions.closeDetails()
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  useEffect(() => {
    const element = workspaceRef.current
    if (element === null) return
    let scheduled: number | null = null
    const observer = new ResizeObserver(() => {
      scheduled ??= requestAnimationFrame(() => {
        scheduled = null
        const width = element.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (scheduled !== null) cancelAnimationFrame(scheduled)
    }
  }, [])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const contentPage = activePage !== 'conversation'
  const sidebarCollapsed = contentPage || (narrow ? !panels.narrowExpanded : panels.sidebar === 0)
  const sidebarPreference = sidebarCollapsed ? 0 : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  // The Worldline workspace rightbar is global chrome, so it must remain
  // operable on the new-session screen too. Only the session-owned `details`
  // occupant is gated below; the column itself follows the user's toggle.
  const effectiveDetails = panels.details
  const solvedColumns = computeColumns(viewport, sidebarPreference, effectiveDetails)
  // Feature pages own the full center workspace. The conversation/session
  // browser is not a second navigation rail and must disappear completely
  // outside the conversation page (the global Worldline rail stays visible).
  const columns = contentPage
    ? { ...solvedColumns, sidebar: 0, center: solvedColumns.center + solvedColumns.sidebar }
    : solvedColumns
  const columnsRef = useRef(columns)
  columnsRef.current = columns

  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={css.frame}
      data-worldline-app-frame
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-sidebar-hidden={contentPage || sidebarCollapsed || undefined}
      data-details-collapsed={columns.details === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      <nav className={css.rail} aria-label="主导航">
        <div className={css.railPrimary}>{renderSlot('worldline.rail.primary', {})}</div>
        <div className={css.railBottom}>{renderSlot('worldline.rail.bottom', {})}</div>
      </nav>

      <header className={css.topbar} data-native-browser-occlusion-root>
        <div className={css.topbarLeading}>{renderSlot('worldline.topbar.leading', {})}</div>
        <div className={css.topbarCenter}>{renderSlot('worldline.topbar.center', {})}</div>
        <div className={css.topbarTrailing}>{renderSlot('worldline.topbar.trailing', {})}</div>
      </header>

      <div
        ref={workspaceRef}
        className={css.workspace}
        style={{ gridTemplateColumns: `${columns.sidebar}px minmax(0, 1fr) ${columns.details}px` }}
      >
        <aside className={css.sidebarCol} aria-hidden={contentPage || sidebarCollapsed || undefined}>
          {contentPage || sidebarCollapsed ? null : renderSlot('sidebar', { collapsed: false, width: columns.sidebar })}
        </aside>
        <CenterColumn>
          {renderSlotChain('worldline.main.page', { activePage }, {
            fallback: renderSlot('conversation', {}),
          })}
        </CenterColumn>
        <DetailsColumn>
          {renderSlot('worldline.workspace.right', {})}
          {detailsSession === undefined ? null : renderSlot('details', {})}
        </DetailsColumn>
        <div className={css.overlayLayer} data-shell-overlay>{renderSlot('shell.overlay', {})}</div>
        {!sidebarCollapsed && (
          <DragHandle
            side="sidebar"
            left={columns.sidebar}
            onStart={() => { sidebarBase.current = columnsRef.current.sidebar; setDragging(true) }}
            onDrag={(dx) => { actions.setSidebar(sidebarBase.current + dx) }}
            onEnd={() => { setDragging(false) }}
          />
        )}
        {columns.details > 0 && (
          <DragHandle
            side="details"
            left={viewport - columns.details}
            onStart={() => { detailsBase.current = columnsRef.current.details; setDragging(true) }}
            onDrag={(dx) => { actions.setDetails(detailsBase.current - dx) }}
            onEnd={() => { setDragging(false) }}
          />
        )}
      </div>

      <footer className={css.statusbar}>
        <div className={css.statusLeft}>{renderSlot('worldline.status.left', {})}</div>
        <div className={css.statusRight}>{renderSlot('worldline.status.right', {})}</div>
      </footer>
    </div>
  )
}
