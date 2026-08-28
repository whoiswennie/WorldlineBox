import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RuntimeLogEntry, RuntimeLogLevel, RuntimeLogSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RuntimeLogsWorkbench.module.css'

interface Injected {
  read: (cursor?: number) => Promise<RuntimeLogSnapshot>
  startRecording: () => Promise<{ active: true; path: string }>
  stopRecording: () => Promise<{ active: false; path?: string }>
  openPath: (path: string) => Promise<void>
}

type Props = ConvViewProps & InjectFace<Injected>
const MAX_CLIENT_ENTRIES = 5_000
const ROW_HEIGHT = 30
const LEVELS: RuntimeLogLevel[] = ['error', 'warn', 'info', 'debug']
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
})

function formatTime(timestamp: number): string {
  return TIME_FORMATTER.format(timestamp)
}

function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text)
}

function lineOf(entry: RuntimeLogEntry): string {
  return `${new Date(entry.timestamp).toISOString()} [${entry.level.toUpperCase()}] ${entry.source} ${entry.message}`
}

export function RuntimeLogsWorkbench({ read, startRecording, stopRecording, openPath }: Props) {
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([])
  const [levels, setLevels] = useState<Set<RuntimeLogLevel>>(new Set(LEVELS))
  const [query, setQuery] = useState('')
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [dropped, setDropped] = useState(false)
  const [recording, setRecording] = useState<RuntimeLogSnapshot['recording']>({ active: false })
  const [selected, setSelected] = useState<number>()
  const [error, setError] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(400)
  const cursorRef = useRef<number>()
  const viewportRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return entries.filter(entry => levels.has(entry.level)
      && (needle === '' || `${entry.source}\n${entry.message}`.toLocaleLowerCase().includes(needle)))
  }, [entries, levels, query])
  const selectedEntry = entries.find(entry => entry.sequence === selected)

  const showError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const observer = new ResizeObserver(() => { setViewportHeight(viewport.clientHeight) })
    observer.observe(viewport)
    setViewportHeight(viewport.clientHeight)
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    if (paused) return
    let cancelled = false
    let timer = 0
    const poll = async (): Promise<void> => {
      try {
        const page = await read(cursorRef.current)
        if (cancelled) return
        cursorRef.current = page.nextCursor
        setDropped(current => current || page.dropped)
        setRecording(page.recording)
        if (page.entries.length > 0) {
          setEntries((current) => {
            const lastSequence = current.at(-1)?.sequence ?? -1
            const next = [...current, ...page.entries.filter(entry => entry.sequence > lastSequence)]
            return next.slice(-MAX_CLIENT_ENTRIES)
          })
        }
        timer = window.setTimeout(() => { void poll() }, page.entries.length >= 500 ? 30 : 180)
      } catch (reason: unknown) {
        if (!cancelled) {
          showError(reason)
          timer = window.setTimeout(() => { void poll() }, 1_000)
        }
      }
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [paused, read, showError])

  useEffect(() => {
    if (!follow) return
    const viewport = viewportRef.current
    if (viewport !== null) viewport.scrollTop = viewport.scrollHeight
  }, [filtered.length, follow])

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + 16
  const visible = filtered.slice(startIndex, startIndex + visibleCount)
  const bottomPadding = Math.max(0, (filtered.length - startIndex - visible.length) * ROW_HEIGHT)

  const toggleLevel = (level: RuntimeLogLevel): void => {
    setLevels((current) => {
      const next = new Set(current)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  const toggleRecording = async (): Promise<void> => {
    setError('')
    try {
      setRecording(recording.active ? await stopRecording() : await startRecording())
    } catch (reason: unknown) {
      showError(reason)
    }
  }

  return <section className={css.root} data-conversation-composer-overlay="" data-worldline-runtime-logs="">
    <header className={css.toolbar}>
      <div className={css.levels} aria-label="日志级别">
        {LEVELS.map(level => <button key={level} type="button" data-level={level}
          aria-pressed={levels.has(level)} onClick={() => { toggleLevel(level) }}>{level}</button>)}
      </div>
      <label className={css.search}><span>筛选</span><input value={query} placeholder="来源或内容"
        onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
      <button type="button" aria-pressed={paused} onClick={() => { setPaused(value => !value) }}>{paused ? '继续' : '暂停'}</button>
      <button type="button" aria-pressed={follow} onClick={() => { setFollow(value => !value) }}>跟随</button>
      <button type="button" onClick={() => { void copyText(filtered.map(lineOf).join('\n')).catch(showError) }}>复制当前视图</button>
      <button type="button" onClick={() => { setEntries([]); setSelected(undefined); setDropped(false) }}>清空视图</button>
      <button type="button" className={recording.active ? css.recording : undefined} onClick={() => { void toggleRecording() }}>
        <i />{recording.active ? '停止记录' : '记录到文件'}
      </button>
    </header>
    <div className={css.status}>
      <span><b>{filtered.length}</b> 条可见 / 内存保留 {entries.length}</span>
      <span>{paused ? '实时读取已暂停' : '实时读取中'}</span>
      <span>客户端最多保留 {MAX_CLIENT_ENTRIES.toLocaleString()} 条</span>
      {dropped && <strong>更早日志已按上限释放</strong>}
      {recording.path !== undefined && <button type="button" title={recording.path}
        onClick={() => { if (recording.path !== undefined) void openPath(recording.path).catch(showError) }}>{recording.active ? '正在写入：' : '记录文件：'}{recording.path}</button>}
    </div>
    {error !== '' && <div className={css.error} role="alert">{error}<button type="button" onClick={() => { setError('') }}>×</button></div>}
    <div ref={viewportRef} className={css.viewport} role="log" aria-live="off"
      onScroll={(event) => {
        const target = event.currentTarget
        setScrollTop(target.scrollTop)
        if (target.scrollHeight - target.scrollTop - target.clientHeight > ROW_HEIGHT * 2) setFollow(false)
      }}>
      <div style={{ height: startIndex * ROW_HEIGHT }} />
      {visible.map(entry => <button key={entry.sequence} type="button" className={css.row}
        data-level={entry.level} aria-selected={entry.sequence === selected}
        onClick={() => { setSelected(entry.sequence) }}>
        <time>{formatTime(entry.timestamp)}</time><span className={css.badge}>{entry.level}</span>
        <span className={css.source}>{entry.source}</span><span className={css.message}>{entry.message.replaceAll('\n', ' ↵ ')}</span>
      </button>)}
      <div style={{ height: bottomPadding }} />
      {filtered.length === 0 && <div className={css.empty}>当前筛选条件下没有日志。</div>}
    </div>
    {selectedEntry !== undefined && <aside className={css.detail} aria-label="日志详情">
      <div><time>{new Date(selectedEntry.timestamp).toLocaleString()}</time>
        <b data-level={selectedEntry.level}>{selectedEntry.level}</b>
        <strong>{selectedEntry.source}</strong>
        <button type="button" onClick={() => { void copyText(lineOf(selectedEntry)).catch(showError) }}>复制</button>
        <button type="button" onClick={() => { setSelected(undefined) }}>关闭</button></div>
      <pre>{selectedEntry.message}</pre>
    </aside>}
  </section>
}
