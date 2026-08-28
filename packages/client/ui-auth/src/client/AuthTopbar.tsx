import { useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { authRequest, getAuthSnapshot, refreshAuth, reloadAfterManagedRestart, subscribeAuth } from './auth-store.ts'
import css from './AuthTopbar.module.css'

export function AuthTopbar(_props: PropsRuntime<'worldline.topbar.trailing'>) {
  const auth = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot)
  const [open, setOpen] = useState(false)
  if (auth.user === null) return null
  return <div className={css.wrap}>
    <button type="button" className={css.avatar} aria-label="账号菜单" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>{auth.user.username.slice(0, 1).toUpperCase()}</button>
    {open ? <div className={css.menu}><strong>{auth.user.username}</strong><small>本地账号</small><button type="button" onClick={() => {
      void authRequest('logout', {}).then(async (response) => {
        if (response.restart === true) await reloadAfterManagedRestart()
        else await refreshAuth()
      })
      setOpen(false)
    }}>退出登录</button></div> : null}
  </div>
}
