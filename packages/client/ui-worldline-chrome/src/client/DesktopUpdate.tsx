import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdateSnapshot } from './desktop-update-controller.ts'
import css from './DesktopUpdate.module.css'

export interface ProductStatusInjected {
  hooks: { update: HostObservable<DesktopUpdateSnapshot> }
  checkUpdate(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
}

export type ProductStatusProps = PropsRuntime<'worldline.status.right'>
  & InjectFace<ProductStatusInjected>

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${Math.round(value)} B`
}

function statusCopy(state: DesktopUpdateSnapshot): string {
  if (state.phase === 'available') return `发现新版本 v${state.latestVersion ?? ''}`
  if (state.phase === 'downloading') return `正在更新 ${Math.round(state.percent ?? 0)}%`
  if (state.phase === 'ready') return '新版已下载，等待安装'
  return `世界线 v${state.currentVersion}`
}

function actionable(state: DesktopUpdateSnapshot): boolean {
  return state.phase === 'available' || state.phase === 'downloading' || state.phase === 'ready'
}

export function ProductStatus({
  useUpdate,
  checkUpdate,
  downloadUpdate,
  installUpdate,
}: ProductStatusProps) {
  const state = useUpdate(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const promptedVersion = useRef<string | undefined>(undefined)
  const installAfterDownload = useRef(false)

  useEffect(() => {
    if (
      (state.phase !== 'available' && state.phase !== 'ready')
      || state.latestVersion === undefined
      || promptedVersion.current === state.latestVersion
    ) return
    promptedVersion.current = state.latestVersion
    setOpen(true)
  }, [state.latestVersion, state.phase])

  useEffect(() => {
    if (state.phase !== 'ready' || !installAfterDownload.current) return
    installAfterDownload.current = false
    const timer = window.setTimeout(() => { void installUpdate() }, 500)
    return () => { window.clearTimeout(timer) }
  }, [installUpdate, state.phase])

  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key) }
  }, [open])

  if (state.phase === 'unsupported') {
    return <div className={css.product}><span>◇</span>世界线 <strong>v{state.currentVersion}</strong></div>
  }

  const isActionable = actionable(state)
  const notes = state.releaseNotes?.split('\n').filter(line => line.trim() !== '') ?? []
  const title = state.phase === 'current'
    ? '你正在使用最新版本'
    : state.phase === 'checking' || state.phase === 'idle'
      ? '正在检查新版本'
      : state.phase === 'error'
        ? '更新服务暂时不可用'
        : state.phase === 'ready'
          ? '新版本已经准备好'
          : '发现 WorldlineBox 新版本'

  const startDownload = (): void => {
    installAfterDownload.current = true
    void downloadUpdate()
  }

  return <>
    <button
      type="button"
      className={css.statusButton}
      data-actionable={isActionable || undefined}
      aria-label={statusCopy(state)}
      onClick={() => { setOpen(true) }}
    >
      <span className={css.statusGlyph}>{isActionable ? '◆' : '◇'}</span>
      <span>{state.phase === 'available' ? '新版本' : '世界线'}</span>
      <strong>{state.phase === 'downloading' ? `${Math.round(state.percent ?? 0)}%` : `v${state.latestVersion ?? state.currentVersion}`}</strong>
    </button>
    {open && createPortal(<div
      className={css.backdrop}
      role="presentation"
      data-native-browser-occluder
      onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}
    >
      <section className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header className={css.hero}>
          <div className={css.logo} aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M5 20c4-8 8-8 12-1s7 6 10-2" /><path d="M5 13c4-6 8-6 12 0s7 5 10-1" /></svg>
          </div>
          <div className={css.heroCopy}>
            <span className={css.eyebrow}>WORLDLINEBOX UPDATE</span>
            <h2 id="update-title">{title}</h2>
            <p>当前版本 v{state.currentVersion}{state.latestVersion === undefined ? '' : ` · 最新版本 v${state.latestVersion}`}</p>
          </div>
          <button type="button" className={css.close} aria-label="关闭更新窗口" onClick={() => { setOpen(false) }}>×</button>
        </header>

        <div className={css.body}>
          {state.phase === 'checking' || state.phase === 'idle' ? <div className={css.checking}><i />正在连接 GitHub 并读取最新版本信息…</div> : null}
          {state.phase === 'current' ? <div className={css.currentCard}><span>✓</span><div><strong>无需更新</strong><p>v{state.currentVersion} 是目前规定的最新稳定版本。</p></div></div> : null}
          {state.phase === 'error' ? <div className={css.errorCard}><span>!</span><div><strong>未能完成更新操作</strong><p>{state.message ?? '请检查网络连接后重试。'}</p></div></div> : null}
          {isActionable ? <>
            <div className={css.versionRoute}>
              <span>v{state.currentVersion}</span><i /><b>v{state.latestVersion}</b>
              <em>{state.phase === 'ready' ? '已校验' : state.phase === 'downloading' ? '下载中' : '可更新'}</em>
            </div>
            {state.phase === 'downloading' || state.phase === 'ready' ? <div className={css.progressCard}>
              <div><strong>{state.phase === 'ready' ? '安装包校验完成' : '正在安全下载更新包'}</strong><span>{formatBytes(state.downloadedBytes)} / {formatBytes(state.totalBytes)}</span></div>
              <div className={css.progressTrack}><i style={{ width: `${Math.max(0, Math.min(100, state.percent ?? 0))}%` }} /></div>
              <footer><span>{Math.round(state.percent ?? 0)}%</span><span>{state.phase === 'ready' ? 'SHA-512 校验通过' : `${formatBytes(state.bytesPerSecond)}/s`}</span></footer>
            </div> : null}
            <article className={css.notes}>
              <header><strong>本次更新</strong><span>{state.releaseDate === undefined ? '' : new Date(state.releaseDate).toLocaleDateString('zh-CN')}</span></header>
              {notes.length === 0 ? <p>稳定性与体验改进。</p> : <ul>{notes.map((line, index) => <li key={`${String(index)}-${line}`}>{line.replace(/^[-*]\s*/u, '')}</li>)}</ul>}
            </article>
            <p className={css.security}>安装包来自 WorldlineBox 官方 GitHub Release，并在本机通过 SHA-512 完整性校验。更新会沿用当前安装路径和用户数据。</p>
          </> : null}
        </div>

        <footer className={css.actions}>
          <button type="button" className={css.secondary} onClick={() => { setOpen(false) }}>
            {state.phase === 'downloading' ? '后台下载' : state.phase === 'ready' ? '暂后安装' : '暂不更新'}
          </button>
          {state.phase === 'available' ? <button type="button" className={css.primary} onClick={startDownload}>立即更新</button> : null}
          {state.phase === 'ready' ? <button type="button" className={css.primary} onClick={() => { void installUpdate() }}>立即安装并重启</button> : null}
          {state.phase === 'current' || state.phase === 'error' ? <button type="button" className={css.primary} onClick={() => { void checkUpdate() }}>重新检查</button> : null}
        </footer>
      </section>
    </div>, document.body)}
  </>
}
