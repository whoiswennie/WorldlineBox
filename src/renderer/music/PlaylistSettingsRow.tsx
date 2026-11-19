// Adapted from worldline-harness (MIT); see THIRD_PARTY_NOTICES.md.
import { useMemo, useState, type Ref } from 'react'
import type { MusicPreferenceStore } from './store'
import { BotIcon } from '../companion-bot/BotIcon'
import {
  DEFAULT_NETEASE_PLAYLIST_ID,
  resolveNeteasePlaylists,
} from './store'
import css from './NeteaseMusic.module.css'

export type PlaylistSettingsRowProps =
  Pick<MusicPreferenceStore, 'useStore' | 'actions'> & { detailsRef?: Ref<HTMLDetailsElement> }

/** General-settings manager for named, persistent public playlists. */
export function PlaylistSettingsRow({ useStore, actions, detailsRef }: PlaylistSettingsRowProps) {
  const playlistId = useStore(state => state.playlistId ?? DEFAULT_NETEASE_PLAYLIST_ID)
  const storedPlaylists = useStore(state => state.playlists)
  const playlists = useMemo(
    () => resolveNeteasePlaylists({ playlists: storedPlaylists }),
    [storedPlaylists],
  )
  const [nameDraft, setNameDraft] = useState('')
  const [idDraft, setIdDraft] = useState('')
  const [description, setDescription] = useState('')
  const [editing, setEditing] = useState('')
  const clear = () => { setNameDraft(''); setIdDraft(''); setDescription(''); setEditing(''); }
  const validName = nameDraft.trim() !== ''
  const validId = /^[1-9]\d{0,19}$/u.test(idDraft) && idDraft !== DEFAULT_NETEASE_PLAYLIST_ID
  const canSave = validName && validId && (storedPlaylists.length < 100 || storedPlaylists.some(item => item.id === idDraft))

  return <details ref={detailsRef} className={css.playlistSettings} aria-label="网易云音乐歌单管理">
    <summary className={css.playlistSettingsHeader}>
      <div className={css.settingsCopy}>
        <strong>网易云音乐歌单</strong>
        <span>管理公开歌单的名称、简介和网易云歌单 ID</span>
      </div>
      <BotIcon name="chevron-down" />
    </summary>
    <div className={css.playlistActions}>
      <button
        type="button"
        className={css.restorePlaylist}
        disabled={playlistId === DEFAULT_NETEASE_PLAYLIST_ID}
        onClick={() => { actions.restoreDefaultPlaylist() }}
      >恢复默认</button>
    </div>

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
            {playlist.description && <p>{playlist.description}</p>}
          </div>
          <small>{builtIn ? '内置 · 不可删除' : '自定义歌单'}</small>
          <button
            type="button"
            disabled={active}
            aria-label={`切换到歌单 ${playlist.name}`}
            onClick={() => { actions.selectPlaylist(playlist.id) }}
          >{active ? '使用中' : '切换'}</button>
          {!builtIn && <button type="button" aria-label={`编辑歌单 ${playlist.name}`} onClick={() => {
            setEditing(playlist.id); setIdDraft(playlist.id); setNameDraft(playlist.name); setDescription(playlist.description);
          }}>编辑</button>}
          {builtIn ? null : <button
            type="button"
            className={css.removePlaylist}
            aria-label={`删除歌单 ${playlist.name}`}
            onClick={() => { actions.removePlaylist(playlist.id); if (editing === playlist.id) clear(); }}
          >删除</button>}
        </article>
      })}
    </div>

    <form
      className={css.playlistCreator}
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSave) return
        actions.savePlaylist(nameDraft.trim(), idDraft, description, !editing)
        clear()
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
          readOnly={!!editing}
          aria-invalid={!validId && idDraft !== ''}
          onChange={(event) => { setIdDraft(event.currentTarget.value.trim()) }}
        />
      </label>
      <label className={css.playlistDescription}>
        <span>简介</span>
        <input value={description} maxLength={500} aria-label="歌单简介" placeholder="介绍这份歌单" onChange={event => setDescription(event.currentTarget.value)} />
      </label>
      {editing && <button type="button" onClick={clear}>取消</button>}
      <button type="submit" disabled={!canSave}>{editing ? '保存修改' : '保存并切换'}</button>
    </form>
  </details>
}
