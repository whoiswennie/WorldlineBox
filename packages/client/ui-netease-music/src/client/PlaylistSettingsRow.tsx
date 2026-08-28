import { useMemo, useState } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createMusicPreferenceStore } from './store.ts'
import {
  DEFAULT_NETEASE_PLAYLIST_ID,
  resolveNeteasePlaylists,
} from './store.ts'
import css from './NeteaseMusic.module.css'

export type PlaylistSettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsStore<ReturnType<typeof createMusicPreferenceStore>>

/** General-settings manager for named, persistent public playlists. */
export function PlaylistSettingsRow({ useStore, actions }: PlaylistSettingsRowProps) {
  const playlistId = useStore(state => state.playlistId ?? DEFAULT_NETEASE_PLAYLIST_ID)
  const storedPlaylists = useStore(state => state.playlists)
  const playlists = useMemo(
    () => resolveNeteasePlaylists({ playlistId, playlists: storedPlaylists }),
    [playlistId, storedPlaylists],
  )
  const [nameDraft, setNameDraft] = useState('')
  const [idDraft, setIdDraft] = useState('')
  const validName = nameDraft.trim() !== ''
  const validId = /^\d+$/u.test(idDraft) && idDraft !== '0'

  return <section className={css.playlistSettings} aria-label="网易云音乐歌单管理">
    <header className={css.playlistSettingsHeader}>
      <div className={css.settingsCopy}>
        <strong>网易云音乐歌单</strong>
        <span>保存多个公开歌单并命名；切换后播放器会立即载入所选歌单。</span>
      </div>
      <button
        type="button"
        className={css.restorePlaylist}
        disabled={playlistId === DEFAULT_NETEASE_PLAYLIST_ID}
        onClick={() => { actions.restoreDefaultPlaylist() }}
      >恢复默认</button>
    </header>

    <div className={css.savedPlaylists} role="list" aria-label="已保存的网易云歌单">
      {playlists.map((playlist) => {
        const builtIn = playlist.id === DEFAULT_NETEASE_PLAYLIST_ID
        const active = playlist.id === playlistId
        return <article
          className={css.savedPlaylist}
          data-active={active || undefined}
          role="listitem"
          key={playlist.id}
        >
          <div>
            <strong>{playlist.name}</strong>
            <span>{playlist.id}</span>
          </div>
          <small>{builtIn ? '内置 · 不可删除' : '自定义歌单'}</small>
          <button
            type="button"
            disabled={active}
            aria-label={`切换到歌单 ${playlist.name}`}
            onClick={() => { actions.selectPlaylist(playlist.id) }}
          >{active ? '使用中' : '切换'}</button>
          {builtIn ? null : <button
            type="button"
            className={css.removePlaylist}
            aria-label={`删除歌单 ${playlist.name}`}
            onClick={() => { actions.removePlaylist(playlist.id) }}
          >删除</button>}
        </article>
      })}
    </div>

    <form
      className={css.playlistCreator}
      onSubmit={(event) => {
        event.preventDefault()
        if (!validName || !validId) return
        actions.savePlaylist(nameDraft.trim(), idDraft)
        setNameDraft('')
        setIdDraft('')
      }}
    >
      <label>
        <span>名称</span>
        <input
          value={nameDraft}
          maxLength={40}
          aria-label="歌单名称"
          placeholder="例如：学习音乐"
          aria-invalid={!validName && nameDraft !== ''}
          onChange={(event) => { setNameDraft(event.currentTarget.value) }}
        />
      </label>
      <label>
        <span>歌单 ID</span>
        <input
          value={idDraft}
          inputMode="numeric"
          aria-label="网易云歌单 ID"
          placeholder="输入数字 ID"
          aria-invalid={!validId && idDraft !== ''}
          onChange={(event) => { setIdDraft(event.currentTarget.value.trim()) }}
        />
      </label>
      <button type="submit" disabled={!validName || !validId}>保存并切换</button>
    </form>
  </section>
}
