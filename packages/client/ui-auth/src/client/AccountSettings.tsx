import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { authRequest, getAuthSnapshot, replaceAuthUser, setAuthSnapshot, subscribeAuth } from './auth-store.ts'
import { AvatarCropDialog } from './AvatarCropDialog.tsx'
import css from './AccountSettings.module.css'

function Icon({ kind }: { kind: 'user' | 'upload' | 'logout' | 'shield' | 'calendar' }) {
  const path = kind === 'user' ? <><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6"/></>
    : kind === 'upload' ? <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M5 14v5h14v-5"/></>
      : kind === 'logout' ? <><path d="M10 4H5v16h5M14 8l4 4-4 4m4-4H9"/></>
        : kind === 'shield' ? <><path d="M12 3 5.5 5.5v5.2c0 4.1 2.6 7.8 6.5 9.3 3.9-1.5 6.5-5.2 6.5-9.3V5.5L12 3Z"/><path d="m9.5 11.5 1.7 1.8 3.5-4"/></>
          : <><rect x="4" y="6" width="16" height="14" rx="2"/><path d="M8 3v6M16 3v6M4 10h16"/></>
  return <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>
}

function readAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) return Promise.reject(new Error('请选择图片文件'))
  if (file.size > 5 * 1_024 * 1_024) return Promise.reject(new Error('原始头像文件不能超过 5 MB'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('读取头像失败'))
    }
    reader.onerror = () => { reject(new Error('读取头像失败')) }
    reader.readAsDataURL(file)
  })
}

function formatDate(value: number | null): string {
  if (value === null) return '尚无记录'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

export function AccountSettings(_props: PropsRuntime<'settings.section'>) {
  const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot)
  const [displayName, setDisplayName] = useState(auth.user?.displayName ?? '')
  const [bio, setBio] = useState(auth.user?.bio ?? '')
  const [avatar, setAvatar] = useState(auth.user?.avatar ?? '')
  const [cropSource, setCropSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (auth.user === null) return
    setDisplayName(auth.user.displayName)
    setBio(auth.user.bio)
    setAvatar(auth.user.avatar)
  }, [auth.user])

  useEffect(() => {
    if (notice === '') return
    const timeout = window.setTimeout(() => { setNotice('') }, 3_200)
    return () => { window.clearTimeout(timeout) }
  }, [notice])

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setError('')
    try { setCropSource(await readAvatar(file)) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await authRequest('profile', { displayName, bio, avatar })
      if (response.user === undefined || response.user === null) throw new Error('服务器未返回账户资料')
      replaceAuthUser(response.user)
      setNotice('账户资料已保存')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }

  const logout = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await authRequest('logout', {})
      setAuthSnapshot({ loading: false, user: null, savedAccounts: auth.savedAccounts, error: '' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const user = auth.user
  if (user === null) return <section className={css.empty}><Icon kind="shield" /><h2>当前没有已登录账号</h2><p>请先完成登录，账号主页和独立数据空间随后可用。</p></section>

  return <div className={css.page}>
    {cropSource !== '' && <AvatarCropDialog imageUrl={cropSource} onCancel={() => { setCropSource('') }} onConfirm={(value) => { setAvatar(value); setCropSource('') }} />}
    <header className={css.heading}><span>ACCOUNT PROFILE</span><h2>账号主页</h2><p>管理这台设备上的用户资料。每个账号拥有独立的会话、设置、凭据、插件和运行数据。</p></header>
    {(error !== '' || notice !== '') && <div className={error !== '' ? css.error : css.notice} role={error !== '' ? 'alert' : 'status'} aria-live="polite">{error || notice}</div>}
    <form onSubmit={(event) => { void save(event) }}>
      <section className={css.profileCard}>
        <div className={css.avatarColumn}>
          <div className={css.avatar}>{avatar !== '' ? <img src={avatar} alt="用户头像" /> : <Icon kind="user" />}</div>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void onFile(event) }} />
          <button type="button" className={css.upload} onClick={() => { inputRef.current?.click() }}><Icon kind="upload" />上传并裁剪</button>
          {avatar !== '' && <button type="button" className={css.remove} onClick={() => { setAvatar('') }}>移除头像</button>}
          <small>PNG、JPEG 或 WebP，原图不超过 5 MB</small>
        </div>
        <div className={css.fields}>
          <label><span>显示名称</span><input aria-label="显示名称" value={displayName} maxLength={80} onChange={(event) => { setDisplayName(event.target.value) }} /></label>
          <label><span>登录用户名</span><input aria-label="登录用户名" value={user.username} readOnly aria-readonly="true" /><small>用户名是本地登录标识，目前不可修改。</small></label>
          <label><span>个人信息</span><textarea aria-label="个人信息" value={bio} maxLength={2000} rows={6} placeholder="介绍你的称呼、角色、长期目标或希望被如何协助……" onChange={(event) => { setBio(event.target.value) }} /><small>{bio.length.toLocaleString()} / 2,000</small></label>
          <div className={css.actions}><button type="submit" className={css.save} disabled={busy}>{busy ? '保存中…' : '保存资料'}</button></div>
        </div>
      </section>
    </form>
    <section className={css.accountCard}>
      <header><span className={css.cardIcon}><Icon kind="shield" /></span><div><h3>账号与数据空间</h3><p>账号数据由桌面运行时在物理目录层隔离，切换账号会切换整套应用数据。</p></div></header>
      <div className={css.facts}><span><Icon kind="calendar" /><i>创建时间</i><b>{formatDate(user.createdAt)}</b></span><span><Icon kind="calendar" /><i>最近登录</i><b>{formatDate(user.lastLoginAt)}</b></span><span><Icon kind="shield" /><i>账号编号</i><b>#{user.id}</b></span></div>
      <footer><div><strong>退出当前账号</strong><small>退出后会关闭当前账号的数据空间并返回登录页。</small></div><button type="button" disabled={busy} onClick={() => { void logout() }}><Icon kind="logout" />退出登录</button></footer>
    </section>
  </div>
}
