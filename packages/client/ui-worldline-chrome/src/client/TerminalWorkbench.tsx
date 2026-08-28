import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { TerminalRawReadView, TerminalSessionView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import './XtermBase.module.css'
import css from './TerminalWorkbench.module.css'

interface Injected {
  list: (sessionId: string) => Promise<{ backends: string[]; sessions: TerminalSessionView[] }>
  spawn: (sessionId: string, type: string, cwd?: string) => Promise<TerminalSessionView & { motd: string }>
  readRaw: (sessionId: string, terminalId: string, cursor: number) => Promise<TerminalRawReadView>
  write: (sessionId: string, terminalId: string, data: string) => Promise<void>
  resize: (sessionId: string, terminalId: string, cols: number, rows: number) => Promise<void>
  interrupt: (sessionId: string, terminalId: string) => Promise<void>
  kill: (sessionId: string, terminalId: string) => Promise<void>
}

type Props = ConvViewProps & InjectFace<Injected>

function labelOf(terminal: TerminalSessionView, index: number): string {
  return terminal.name ?? `${terminal.type} ${index + 1}`
}

export function TerminalWorkbench({
  sessionId, useSessions, list, spawn, readRaw, write, resize, interrupt, kill,
}: Props) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const [backends, setBackends] = useState<string[]>([])
  const [backend, setBackend] = useState('')
  const [terminals, setTerminals] = useState<TerminalSessionView[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const emulatorRef = useRef<Terminal>()
  const fitRef = useRef<FitAddon>()
  const cursorRef = useRef(0)
  const activeIdRef = useRef(activeId)
  const stopped = useRef(false)
  const inputQueue = useRef(Promise.resolve())
  const active = terminals.find(terminal => terminal.sessionId === activeId)

  const showError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason))
  }, [])

  const refreshSessions = useCallback(async () => {
    const snapshot = await list(sessionId)
    if (stopped.current) return snapshot
    setBackends(snapshot.backends)
    setBackend(current => snapshot.backends.includes(current) ? current : snapshot.backends[0] ?? '')
    setTerminals(snapshot.sessions)
    return snapshot
  }, [list, sessionId])

  const createTerminal = useCallback(async (type?: string) => {
    const selected = type ?? backend
    if (selected === '') return
    setError('')
    setLoading(true)
    try {
      const created = await spawn(sessionId, selected, cwd)
      if (stopped.current) return
      setTerminals(current => [...current, created])
      setActiveId(created.sessionId)
    } catch (reason: unknown) {
      showError(reason)
    } finally {
      if (!stopped.current) setLoading(false)
    }
  }, [backend, cwd, sessionId, showError, spawn])

  useEffect(() => {
    stopped.current = false
    setLoading(true)
    void refreshSessions().then(async (snapshot) => {
      if (stopped.current) return
      const first = snapshot.sessions[0]
      if (first !== undefined) setActiveId(first.sessionId)
      else if (snapshot.backends[0] !== undefined) {
        const created = await spawn(sessionId, snapshot.backends[0], cwd)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cleanup can flip this ref while spawn awaits.
        if (!stopped.current) {
          setTerminals([created])
          setActiveId(created.sessionId)
        }
      }
    }).catch(showError).finally(() => { if (!stopped.current) setLoading(false) })
    return () => { stopped.current = true }
  }, [cwd, refreshSessions, sessionId, showError, spawn])

  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const emulator = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8_000,
      smoothScrollDuration: 80,
      theme: {
        background: '#ffffff', foreground: '#26364a', cursor: '#4776e6',
        cursorAccent: '#ffffff', selectionBackground: '#b9cdfb88',
        black: '#334155', red: '#d14d41', green: '#2f855a', yellow: '#9a6700',
        blue: '#356ad8', magenta: '#8957b2', cyan: '#167d8d', white: '#e5eaf2',
        brightBlack: '#718096', brightRed: '#e2554f', brightGreen: '#38a169',
        brightYellow: '#b7791f', brightBlue: '#4c7ee8', brightMagenta: '#9f6bc4',
        brightCyan: '#2397a8', brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    emulator.loadAddon(fit)
    emulator.open(viewport)
    emulatorRef.current = emulator
    fitRef.current = fit

    const queueInput = (data: string): void => {
      const terminalId = activeIdRef.current
      if (terminalId === undefined) return
      inputQueue.current = inputQueue.current
        .then(() => write(sessionId, terminalId, data))
        .catch(showError)
    }
    const dataDisposable = emulator.onData(queueInput)
    emulator.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true
      if (event.key.toLowerCase() === 'c') {
        const selection = emulator.getSelection()
        if (selection !== '') void navigator.clipboard.writeText(selection).catch(showError)
        return false
      }
      // Let xterm's native paste event deliver Ctrl+Shift+V through onData.
      // Reading the clipboard here as well would enqueue the same text twice.
      return true
    })

    let resizeFrame = 0
    let lastSize = ''
    const fitTerminal = (): void => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return
        try { fit.fit() } catch { return }
        const terminalId = activeIdRef.current
        const size = `${emulator.cols}x${emulator.rows}`
        if (terminalId === undefined || size === lastSize) return
        lastSize = size
        void resize(sessionId, terminalId, emulator.cols, emulator.rows).catch(showError)
      })
    }
    const observer = new ResizeObserver(fitTerminal)
    observer.observe(viewport)
    fitTerminal()
    return () => {
      cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      dataDisposable.dispose()
      emulator.dispose()
      emulatorRef.current = undefined
      fitRef.current = undefined
    }
  }, [resize, sessionId, showError, write])

  useEffect(() => {
    activeIdRef.current = activeId
    cursorRef.current = 0
    setTruncated(false)
    const emulator = emulatorRef.current
    emulator?.reset()
    try { fitRef.current?.fit() } catch { /* hidden view; ResizeObserver retries */ }
    if (activeId === undefined) return
    emulator?.focus()
    let cancelled = false
    let timer = 0
    const poll = async (): Promise<void> => {
      if (cancelled) return
      try {
        const page = await readRaw(sessionId, activeId, cursorRef.current)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cleanup can cancel while readRaw awaits.
        if (cancelled || activeIdRef.current !== activeId) return
        cursorRef.current = page.cursor
        setTruncated(page.truncated)
        if (page.reset) emulator?.reset()
        if (page.data !== '') emulator?.write(page.data)
        timer = window.setTimeout(() => { void poll() }, page.data === '' ? 120 : 32)
      } catch (reason: unknown) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cleanup can cancel while readRaw awaits.
        if (!cancelled) {
          showError(reason)
          timer = window.setTimeout(() => { void poll() }, 1_000)
        }
      }
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeId, readRaw, sessionId, showError])

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshSessions().catch(() => undefined) }, 2_000)
    return () => { window.clearInterval(timer) }
  }, [refreshSessions])

  const closeTerminal = useCallback(async (terminalId: string) => {
    setError('')
    try {
      await kill(sessionId, terminalId)
      const remaining = terminals.filter(terminal => terminal.sessionId !== terminalId)
      setTerminals(remaining)
      setActiveId(current => current === terminalId ? remaining[0]?.sessionId : current)
    } catch (reason: unknown) {
      showError(reason)
    }
  }, [kill, sessionId, showError, terminals])

  const copySelection = useCallback(async () => {
    const selection = emulatorRef.current?.getSelection() ?? ''
    if (selection === '') return
    try { await navigator.clipboard.writeText(selection) } catch (reason: unknown) { showError(reason) }
  }, [showError])

  const pasteClipboard = useCallback(async () => {
    if (activeId === undefined) return
    try { await write(sessionId, activeId, await navigator.clipboard.readText()) } catch (reason: unknown) { showError(reason) }
  }, [activeId, sessionId, showError, write])

  return <section className={css.root} data-conversation-composer-overlay="" data-worldline-terminal="">
    <header className={css.tabBar}>
      <div className={css.tabs} role="tablist" aria-label="终端会话">
        {terminals.map((terminal, index) => <button key={terminal.sessionId} type="button" role="tab"
          aria-selected={terminal.sessionId === activeId} onClick={() => { setActiveId(terminal.sessionId) }}>
          <i data-status={terminal.status.kind} />{labelOf(terminal, index)}<span role="button" tabIndex={0}
            title="关闭终端" onClick={(event) => { event.stopPropagation(); void closeTerminal(terminal.sessionId) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault(); event.stopPropagation(); void closeTerminal(terminal.sessionId)
              }
            }}>×</span>
        </button>)}
      </div>
      <div className={css.actions}>
        <button type="button" title="复制所选文本" onClick={() => { void copySelection() }}>复制</button>
        <button type="button" title="粘贴剪贴板" disabled={activeId === undefined} onClick={() => { void pasteClipboard() }}>粘贴</button>
        <button type="button" title="清空本地显示" onClick={() => { emulatorRef.current?.clear() }}>清屏</button>
        <button type="button" title="中断前台程序" disabled={activeId === undefined} onClick={() => {
          if (activeId !== undefined) void interrupt(sessionId, activeId).catch(showError)
        }}>中断</button>
        <select aria-label="终端后端" value={backend} disabled={backends.length === 0} onChange={(event) => { setBackend(event.currentTarget.value) }}>
          {backends.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
        <button type="button" disabled={backends.length === 0 || loading} onClick={() => { void createTerminal() }}>＋ 新建终端</button>
      </div>
    </header>
    <div className={css.meta}>
      <span>{cwd ?? '未选择工作区'}</span>
      {active?.pid !== undefined && <span>PID {active.pid}</span>}
      <span>{active === undefined ? '未连接' : active.status.kind === 'running' ? 'PTY 已连接' : '会话已退出'}</span>
      {truncated && <strong>较早输出已释放</strong>}
      <span className={css.shortcut}>Ctrl+Shift+C / V 复制与粘贴</span>
    </div>
    {error !== '' && <div className={css.error} role="alert">{error}<button type="button" onClick={() => { setError('') }}>×</button></div>}
    <div className={css.viewport} ref={viewportRef} aria-label="终端输出" onClick={() => { emulatorRef.current?.focus() }}>
      {loading && activeId === undefined && <span className={css.loading}>正在连接终端…</span>}
    </div>
  </section>
}
