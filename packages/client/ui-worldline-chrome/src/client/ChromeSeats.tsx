import { useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolchainStatus, ToolchainStatusSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { IconFolderClose16 } from '@deepseek-ai/dsh-client-ui-primitives'
import worldMapPaths from './world-map-paths.json'
import css from './ChromeSeats.module.css'

function Chevron({ open, className }: { open: boolean; className: string | undefined }) {
  return <svg
    className={className}
    data-open={open ? 'true' : 'false'}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path d="m7 9.5 5 5 5-5" />
  </svg>
}

export type WorkspaceTopbarProps = PropsRuntime<'worldline.topbar.leading'> & InjectFace<{
  switchWorkspace: (workspaceId: WorkspaceId) => void
}>

export function WorkspaceTopbar({ useSessions, useWorkspaces, switchWorkspace }: WorkspaceTopbarProps) {
  const cwd = useSessions((state) => {
    const current = state.current
    return current === undefined ? undefined : state.byId[current]?.cwd
  })
  const workspaces = useWorkspaces(state => state.items)
  const recentWorkspaceId = useWorkspaces(state => state.recentWorkspaceId)
  const workspace = cwd === undefined
    ? workspaces.find(item => item.workspaceId === recentWorkspaceId)
    : workspaces.find(item => item.path === cwd)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div ref={root} className={css.workspaceWrap}>
      <button type="button" className={css.workspace} title={workspace?.path} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.8h6l1.8 2h9.2v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.8Z" /></svg>
        <span>会话工作空间</span><strong>{workspace?.path ?? '尚未选择'}</strong><Chevron open={open} className={css.chevron} />
      </button>
      {open && <div
        className={css.workspaceMenu}
        role="menu"
        aria-label="切换工作空间"
        data-native-browser-occluder
      >
        <div className={css.workspaceMenuTitle}>切换工作空间</div>
        {workspaces.length === 0 ? <div className={css.workspaceEmpty}>暂无工作空间</div> : null}
        {workspaces.map(item => <button type="button" role="menuitemradio" aria-checked={item.workspaceId === workspace?.workspaceId} key={item.workspaceId} className={css.workspaceOption} onClick={() => {
          setOpen(false)
          if (item.workspaceId !== workspace?.workspaceId) switchWorkspace(item.workspaceId)
        }}>
          <IconFolderClose16 className={css.optionFolder} size={16} /><span><strong>{item.title}</strong><small>{item.path}</small></span>
          {item.workspaceId === workspace?.workspaceId ? <i>✓</i> : null}
        </button>)}
      </div>}
    </div>
  )
}

interface DeviceLocation { latitude: number; longitude: number; accuracy: number; updatedAt: number }
type LocationState =
  | { status: 'idle' | 'locating'; location: DeviceLocation | null; message: string }
  | { status: 'ready'; location: DeviceLocation; message: string }
  | { status: 'error'; location: null; message: string }

function MiniWorldMap({ location, label }: { location: DeviceLocation | null; label: string }) {
  const [translateX = 160, translateY = 71] = worldMapPaths.translate
  const marker = location === null ? null : {
    x: Math.max(5, Math.min(315, translateX + worldMapPaths.scale * location.longitude * Math.PI / 180)),
    y: Math.max(5, Math.min(137, translateY - worldMapPaths.scale * location.latitude * Math.PI / 180)),
  }
  return <div className={css.worldMap} role="img" aria-label={label}>
    <svg viewBox={worldMapPaths.viewBox} aria-hidden="true">
      <g className={css.mapGrid}>
        {[-60, -30, 0, 30, 60].map((latitude) => {
          const y = translateY - worldMapPaths.scale * latitude * Math.PI / 180
          return <line key={`lat-${latitude}`} x1="5" x2="315" y1={y} y2={y} />
        })}
        {[-120, -60, 0, 60, 120].map((longitude) => {
          const x = translateX + worldMapPaths.scale * longitude * Math.PI / 180
          return <line key={`lon-${longitude}`} x1={x} x2={x} y1="5" y2="137" />
        })}
      </g>
      <path d={worldMapPaths.land} className={css.mapLand} /><path d={worldMapPaths.borders} className={css.mapBorders} />
      {marker === null ? null : <><circle cx={marker.x} cy={marker.y} r="6.5" className={css.mapPulse} /><circle cx={marker.x} cy={marker.y} r="2.8" className={css.mapMarker} /></>}
    </svg>
    <span className={css.mapAttribution}>Natural Earth · 等距圆柱</span><span className={css.mapCaption}>{label}</span>
  </div>
}

export type ClockTopbarProps = PropsRuntime<'worldline.topbar.trailing'>

export function ClockTopbar(_props: ClockTopbarProps) {
  const [now, setNow] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  const [locateRevision, setLocateRevision] = useState(0)
  const [locationState, setLocationState] = useState<LocationState>({ status: 'idle', location: null, message: '展开面板后获取设备实时位置' })
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(new Date()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (!open) return
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key) }
  }, [open])
  useEffect(() => {
    if (!open) return
    setLocationState(current => ({ status: 'locating', location: current.location, message: '正在获取设备实时位置…' }))
    const watchId = navigator.geolocation.watchPosition((position) => {
      setLocationState({ status: 'ready', location: {
        latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracy: position.coords.accuracy, updatedAt: position.timestamp || Date.now(),
      }, message: '设备实时定位 · 持续更新' })
    }, (error) => { setLocationState({ status: 'error', location: null, message: `无法获取设备位置：${error.message}` }) }, {
      enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000,
    })
    return () => { navigator.geolocation.clearWatch(watchId) }
  }, [locateRevision, open])
  const time = useMemo(() => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now), [now])
  const date = useMemo(() => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('/', '.'), [now])
  const weekday = useMemo(() => new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(now), [now])
  const offsetMinutes = -now.getTimezoneOffset(); const offsetSign = offsetMinutes >= 0 ? '+' : '-'
  const offset = `UTC${offsetSign}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`
  const location = locationState.location
  const locationLabel = location === null ? locationState.message : `${location.latitude.toFixed(4)}°, ${location.longitude.toFixed(4)}° · ±${Math.round(location.accuracy)} m`
  return (
    <div ref={root} className={css.clockWrap}>
      <button type="button" className={css.clock} aria-expanded={open} onClick={() => { setOpen(value => !value) }}><span className={css.clockIcon}>◷</span><strong>{time}</strong><Chevron open={open} className={css.clockChevron} /></button>
      {open && <section
        className={css.clockPopover}
        aria-label="时间与实时定位"
        data-native-browser-occluder
      >
        <header className={css.clockHero}><div><span className={css.date}>▦&nbsp; {date} · {weekday}</span><strong>{time}</strong><small><i />本机系统时间 · 每秒刷新</small></div><div className={css.timezone}><b>{offset}</b><span>{Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区'}</span></div></header>
        <div className={css.mapArea}><MiniWorldMap location={location} label={locationLabel} /></div>
        <footer className={css.locationMeta}><div><span>◎&nbsp; 设备定位</span><strong>{locationLabel}</strong></div><button type="button" disabled={locationState.status === 'locating'} onClick={() => { setLocateRevision(value => value + 1) }}>↻&nbsp; 重新定位</button></footer>
      </section>}
    </div>
  )
}

export type RuntimeStatusProps = PropsRuntime<'worldline.status.left'> & InjectFace<{
  loadToolchains: () => Promise<ToolchainStatusSnapshot>
}>

type ToolchainLoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; snapshot: ToolchainStatusSnapshot }
  | { phase: 'error'; message: string }

function ToolchainBadge({ name, status, failed = false }: {
  name: string
  status?: ToolchainStatus | undefined
  failed?: boolean | undefined
}) {
  const ready = status?.ready === true
  const detail = failed ? '检测失败' : status === undefined ? '检测中…' : ready
    ? status.version === undefined ? '已就绪' : `v${status.version}`
    : '未检测到'
  return <span data-ready={failed ? 'error' : status === undefined ? 'loading' : String(ready)}>
    <i /><b>{name}</b><em>{detail}</em>
  </span>
}

export function RuntimeStatus({ loadToolchains }: RuntimeStatusProps) {
  const [state, setState] = useState<ToolchainLoadState>({ phase: 'loading' })
  useEffect(() => {
    let current = true
    void loadToolchains().then(
      (snapshot) => { if (current) setState({ phase: 'ready', snapshot }) },
      (reason: unknown) => {
        if (current) setState({
          phase: 'error', message: reason instanceof Error ? reason.message : String(reason),
        })
      },
    )
    return () => { current = false }
  }, [loadToolchains])
  const snapshot = state.phase === 'ready' ? state.snapshot : undefined
  const failed = state.phase === 'error'
  return <div
    className={css.runtime}
    aria-label="本机开发环境"
    title={failed ? state.message : undefined}
  >
    <ToolchainBadge name="Python" status={snapshot?.python} failed={failed} />
    <ToolchainBadge name="Node.js" status={snapshot?.node} failed={failed} />
    <ToolchainBadge name="Git" status={snapshot?.git} failed={failed} />
  </div>
}
