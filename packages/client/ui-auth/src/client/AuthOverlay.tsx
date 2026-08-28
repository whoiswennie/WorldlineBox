import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  authRequest,
  getAuthSnapshot,
  initializeAuth,
  refreshAuth,
  reloadAfterManagedRestart,
  setAuthSnapshot,
  subscribeAuth,
} from './auth-store.ts'
import css from './AuthOverlay.module.css'

function Icon({ kind }: { kind: 'user' | 'lock' | 'shield' | 'eye' | 'trash' | 'plus' | 'zap' }) {
  const path = kind === 'user' ? <><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6"/></>
    : kind === 'lock' ? <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>
      : kind === 'shield' ? <path d="M12 3 5.5 5.5v5.2c0 4.1 2.6 7.8 6.5 9.3 3.9-1.5 6.5-5.2 6.5-9.3V5.5L12 3Zm-2.5 8 1.7 1.8 3.5-4"/>
        : kind === 'eye' ? <><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z"/><circle cx="12" cy="12" r="2"/></>
          : kind === 'trash' ? <><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7"/></>
            : kind === 'plus' ? <path d="M12 5v14M5 12h14"/>
              : <path d="m13 2-7 12h6l-1 8 7-12h-6l1-8Z"/>
  return <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>
}

export function AuthOverlay(_props: PropsRuntime<'shell.overlay'>) {
  const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
  const [autoLogin, setAutoLogin] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = auth.loading || auth.user === null

  useEffect(() => { void initializeAuth() }, [])
  useEffect(() => {
    if (username !== '' || auth.savedAccounts.length === 0) return
    setUsername(auth.savedAccounts[0]?.username ?? '')
    setSelectedAccount(auth.savedAccounts[0]?.id ?? null)
  }, [auth.savedAccounts, username])
  useEffect(() => {
    if (!active) return
    const frame = document.querySelector<HTMLElement>('[data-worldline-app-frame]')
    if (frame === null) return
    const wasInert = frame.inert
    if (document.activeElement instanceof HTMLElement && frame.contains(document.activeElement)) {
      document.activeElement.blur()
    }
    frame.inert = true
    return () => { frame.inert = wasInert }
  }, [active])
  if (!active) return null

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (username.trim().length < 3 || username.trim().length > 32) { setError('用户名长度必须为 3–32 个字符。'); return }
    if (password.length === 0 || password.length > 256) { setError('密码不能为空且不能超过 256 个字符。'); return }
    if (mode === 'register' && password !== confirmPassword) { setError('两次输入的密码不一致。'); return }
    setBusy(true)
    setError('')
    try {
      const response = await authRequest(mode, { username, password, remember, autoLogin: remember && autoLogin })
      if (response.restart === true) {
        await reloadAfterManagedRestart()
        return
      }
      setAuthSnapshot({ loading: false, user: response.user ?? null, savedAccounts: auth.savedAccounts, error: '' })
      setPassword('')
      setConfirmPassword('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (next: 'login' | 'register') => {
    setMode(next); setPassword(''); setConfirmPassword(''); setError(''); setSelectedAccount(null)
    if (next === 'register') setUsername('')
  }
  const useOther = () => { setUsername(''); setPassword(''); setSelectedAccount(null); setAutoLogin(false); setError('') }
  const removeSaved = async (userId: number) => {
    await authRequest('saved/remove', { userId })
    if (selectedAccount === userId) useOther()
    await refreshAuth()
  }

  return createPortal(<main className={css.overlay} role="dialog" aria-modal="true" aria-label="世界线本地账户">
    <div className={css.glowOne} /><div className={css.glowTwo} />
    <section className={css.card}>
      <header className={css.title}>
        <img src="/worldline-icon.png" alt="世界线" />
        <h1>世界线本地账户</h1>
        <p>账户与凭据仅保存在这台设备上，不连接任何外部账户系统</p>
      </header>
      <div className={css.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'login'} data-active={mode === 'login' || undefined} onClick={() => { switchMode('login') }}>登录</button>
        <button type="button" role="tab" aria-selected={mode === 'register'} data-active={mode === 'register' || undefined} onClick={() => { switchMode('register') }}>注册</button>
      </div>
      {mode === 'login' && auth.savedAccounts.length > 0 ? <section className={css.saved}>
        <header><strong>已保存账户</strong><button type="button" onClick={useOther}><Icon kind="plus" />使用其他账户</button></header>
        <div>{auth.savedAccounts.map(account => <article key={account.id} data-selected={selectedAccount === account.id || undefined}>
          <button type="button" className={css.account} onClick={() => { setSelectedAccount(account.id); setUsername(account.username); setPassword('') }}><span>{account.avatar !== '' ? <img src={account.avatar} alt="" /> : account.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{account.displayName}</strong><small>@{account.username} · 独立数据空间</small></span>{selectedAccount === account.id ? <b>✓</b> : null}</button>
          <button type="button" className={css.remove} aria-label="移除已保存账户" title="移除已保存账户" onClick={() => { void removeSaved(account.id) }}><Icon kind="trash" /></button>
        </article>)}</div>
      </section> : null}
      <form onSubmit={(event) => { void submit(event) }}>
        <label><span>用户名</span><i><Icon kind="user" /><input autoFocus value={username} autoComplete="username" disabled={busy} onChange={(event) => { setUsername(event.target.value); setSelectedAccount(null) }} placeholder="请输入 3–32 个字符" /></i></label>
        <label><span>密码</span><i><Icon kind="lock" /><input type={showPassword ? 'text' : 'password'} value={password} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} disabled={busy} onChange={(event) => { setPassword(event.target.value) }} placeholder="请输入密码" /><button type="button" aria-label="显示或隐藏密码" onClick={() => { setShowPassword(value => !value) }}><Icon kind="eye" /></button></i></label>
        {mode === 'register' ? <label><span>确认密码</span><i><Icon kind="shield" /><input type={showPassword ? 'text' : 'password'} value={confirmPassword} autoComplete="new-password" disabled={busy} onChange={(event) => { setConfirmPassword(event.target.value) }} placeholder="请再次输入密码" /></i></label> : null}
        <div className={css.preferences}><label><input type="checkbox" checked={remember} disabled={busy} onChange={(event) => { setRemember(event.target.checked); if (!event.target.checked) setAutoLogin(false) }} />记住账号</label><label data-disabled={!remember || undefined}><input type="checkbox" checked={autoLogin} disabled={busy || !remember} onChange={(event) => { setAutoLogin(event.target.checked) }} /><Icon kind="zap" />两种入口自动登录</label></div>
        {error !== '' || auth.error !== '' ? <div className={css.error} role="alert">{error || auth.error}</div> : null}
        <button className={css.submit} type="submit" disabled={busy || auth.loading}>{busy ? '请稍候…' : mode === 'login' ? '登录本地账户' : '注册本地账户'}</button>
      </form>
      <div className={css.security}><Icon kind="shield" /><span>账户密码使用随机盐和 scrypt 哈希，仅保存在本机。</span></div>
    </section>
  </main>, document.body)
}
