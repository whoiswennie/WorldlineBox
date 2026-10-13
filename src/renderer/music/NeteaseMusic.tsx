// Adapted from worldline-harness (MIT); see THIRD_PARTY_NOTICES.md.
// Source changes synchronize a persistent external HTMLAudioElement and reset its projections.
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  NeteaseLyricLine,
  NeteasePlaylistCatalog,
  NeteasePlaylistTrack,
  NeteaseTrackLyrics,
  NeteaseTrackStream,
} from '../../shared/music'
import { createPortal } from 'react-dom'
import { PlaylistSettingsRow } from './PlaylistSettingsRow'
import { MusicCover } from './MusicCover'
import type { MusicPreferenceStore } from './store'
import {
  DEFAULT_NETEASE_PLAYLIST_ID,
  resolveNeteasePlaylists,
  type PlaybackMode,
} from './store'
import css from './NeteaseMusic.module.css'

export const DEFAULT_PLAYLIST_ID = DEFAULT_NETEASE_PLAYLIST_ID
const PROGRESS_WRITE_INTERVAL_MS = 2_000
const PLAYBACK_MODES: readonly PlaybackMode[] = ['list', 'single', 'shuffle']
const PLAYBACK_MODE_LABELS: Readonly<Record<PlaybackMode, string>> = {
  list: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
}
const PLAYBACK_MODE_MARKS: Readonly<Record<PlaybackMode, string>> = {
  list: '循',
  single: '单',
  shuffle: '随',
}

export type NeteaseMusicProps =
  Pick<MusicPreferenceStore, 'useStore' | 'actions'> & { target: HTMLDivElement | null; 
    loadCatalog: (playlistId: string, signal: AbortSignal, refresh?: boolean) => Promise<NeteasePlaylistCatalog>
    resolveStream: (
      playlistId: string,
      trackId: string,
      signal: AbortSignal,
    ) => Promise<NeteaseTrackStream>
    loadLyrics: (
      playlistId: string,
      trackId: string,
      signal: AbortSignal,
    ) => Promise<NeteaseTrackLyrics>
  }

type CatalogState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly catalog: NeteasePlaylistCatalog }
  | { readonly phase: 'error'; readonly message: string }

type LyricsState =
  | { readonly phase: 'idle' | 'loading' }
  | { readonly phase: 'ready'; readonly lines: readonly NeteaseLyricLine[] }
  | { readonly phase: 'error'; readonly message: string }

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`
}

/** Find the final lyric timestamp at or before the current playback position. */
export function findActiveLyricIndex(
  lines: readonly NeteaseLyricLine[],
  currentTimeSeconds: number,
): number {
  const target = Math.max(0, currentTimeSeconds * 1_000)
  let low = 0
  let high = lines.length - 1
  let active = -1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const line = lines[middle]
    if (line !== undefined && line.timeMs <= target) {
      active = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return active
}

function trackArtists(track: NeteasePlaylistTrack | undefined): string {
  if (track === undefined) return '网易云音乐'
  return track.artists.length > 0 ? track.artists.join(' / ') : track.album || '未知作者'
}

/** Persistent custom player for every song exposed by the built-in public playlist. */
export function NeteaseMusic({
  target,
  useStore,
  actions,
  loadCatalog,
  resolveStream,
  loadLyrics,
}: NeteaseMusicProps) {
  const autoPlay = useStore(state => state.autoPlay)
  const storedTrackId = useStore(state => state.trackId)
  const storedPosition = useStore(state => state.positionSeconds ?? 0)
  const storedVolume = useStore(state => state.volume ?? 0.8)
  const playbackMode = useStore(state => state.playbackMode ?? 'list')
  const playlistId = useStore(state => state.playlistId ?? DEFAULT_PLAYLIST_ID)
  const storedPlaylists = useStore(state => state.playlists)
  const playlists = useMemo(
    () => resolveNeteasePlaylists({ playlistId, playlists: storedPlaylists }),
    [playlistId, storedPlaylists],
  )
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [catalogState, setCatalogState] = useState<CatalogState>({ phase: 'loading' })
  const [currentTrackId, setCurrentTrackId] = useState(storedTrackId ?? '')
  const [source, setSource] = useState<string>()
  const [streamError, setStreamError] = useState<string>()
  const [playing, setPlaying] = useState(false)
  const [playWhenReady, setPlayWhenReady] = useState(autoPlay)
  const [currentTime, setCurrentTime] = useState(storedPosition)
  const [duration, setDuration] = useState(0)
  const [query, setQuery] = useState('')
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [lyricsState, setLyricsState] = useState<LyricsState>({ phase: 'idle' })
  const [autoSkipTrackId, setAutoSkipTrackId] = useState<string>()
  const audio = useRef<HTMLAudioElement>(null)
  const activeLyric = useRef<HTMLButtonElement>(null)
  const restoredTrack = useRef<string | undefined>(undefined)
  const suppressNextPauseSave = useRef(false)
  const lastProgressWrite = useRef(0)
  const failedTracks = useRef(new Set<string>())

  useEffect(() => {
    const controller = new AbortController()
    setCatalogState({ phase: 'loading' })
    void loadCatalog(playlistId, controller.signal, catalogRevision > 0).then(
      (catalog) => { if (!controller.signal.aborted) setCatalogState({ phase: 'ready', catalog }) },
      (reason: unknown) => {
        if (!controller.signal.aborted) setCatalogState({ phase: 'error', message: messageOf(reason) })
      },
    )
    return () => { controller.abort() }
  }, [catalogRevision, loadCatalog, playlistId])

  useEffect(() => {
    suppressNextPauseSave.current = audio.current !== null && !audio.current.paused
    if (audio.current && !audio.current.paused) audio.current.pause()
    restoredTrack.current = undefined
    setCurrentTrackId('')
    setCurrentTime(0)
    setDuration(0)
    setSource(undefined)
    setStreamError(undefined)
    setAutoSkipTrackId(undefined)
    failedTracks.current.clear()
  }, [playlistId])

  const catalog = catalogState.phase === 'ready' && catalogState.catalog.id === playlistId ? catalogState.catalog : undefined
  const tracks = useMemo(() => catalog?.tracks ?? [], [catalog])

  useEffect(() => {
    if (tracks.length === 0) return
    const selected = tracks.some(track => track.id === currentTrackId)
      ? currentTrackId
      : tracks.some(track => track.id === storedTrackId)
        ? storedTrackId ?? ''
        : tracks[0]?.id ?? ''
    if (selected === '') return
    if (selected !== currentTrackId) setCurrentTrackId(selected)
    if (storedTrackId !== selected) actions.selectTrack(selected)
  }, [actions, currentTrackId, storedTrackId, tracks])

  const currentIndex = tracks.findIndex(track => track.id === currentTrackId)
  const currentTrack = currentIndex < 0 ? undefined : tracks[currentIndex]

  useEffect(() => {
    if (currentTrack === undefined) return
    const controller = new AbortController()
    setSource(undefined)
    setStreamError(undefined)
    setDuration(currentTrack.durationMs / 1000)
    void resolveStream(playlistId, currentTrack.id, controller.signal).then(
      (stream) => { if (!controller.signal.aborted) setSource(stream.url) },
      (reason: unknown) => {
        if (controller.signal.aborted) return
        failedTracks.current.add(currentTrack.id)
        setStreamError(`${messageOf(reason)}；正在自动跳过。`)
        setAutoSkipTrackId(currentTrack.id)
      },
    )
    return () => { controller.abort() }
  }, [currentTrack, playlistId, resolveStream])

  useEffect(() => {
    if (currentTrack === undefined) {
      setLyricsState({ phase: 'idle' })
      return
    }
    const controller = new AbortController()
    setLyricsState({ phase: 'loading' })
    void loadLyrics(playlistId, currentTrack.id, controller.signal).then(
      (lyrics) => {
        if (!controller.signal.aborted) setLyricsState({ phase: 'ready', lines: lyrics.lines })
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setLyricsState({ phase: 'error', message: messageOf(reason) })
        }
      },
    )
    return () => { controller.abort() }
  }, [currentTrack, loadLyrics, playlistId])

  const remember = useCallback(() => {
    const player = audio.current
    if (player === null || currentTrackId === '' || restoredTrack.current !== currentTrackId) return
    actions.rememberProgress(currentTrackId, player.currentTime)
    lastProgressWrite.current = Date.now()
  }, [actions, currentTrackId])

  const rememberRef = useRef(remember)
  useLayoutEffect(() => { rememberRef.current = remember }, [remember])
  useEffect(() => {
    const save = (): void => { rememberRef.current() }
    const visibility = (): void => { if (document.visibilityState === 'hidden') save() }
    window.addEventListener('beforeunload', save)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      save()
      window.removeEventListener('beforeunload', save)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  const selectTrack = useCallback((trackId: string, keepPlaying = playing) => {
    const player = audio.current
    suppressNextPauseSave.current = player !== null && !player.paused
    player?.pause()
    if (player !== null) player.currentTime = 0
    restoredTrack.current = undefined
    setCurrentTrackId(trackId)
    setCurrentTime(0)
    setDuration(0)
    setPlayWhenReady(keepPlaying)
    actions.selectTrack(trackId)
  }, [actions, playing])

  const move = useCallback((offset: number) => {
    if (tracks.length === 0) return
    const sequential = currentIndex < 0 ? 0 : (currentIndex + offset + tracks.length) % tracks.length
    const random = tracks.length < 2
      ? sequential
      : Math.floor(Math.random() * (tracks.length - 1))
    const index = playbackMode === 'shuffle'
      ? random >= currentIndex ? random + 1 : random
      : sequential
    const target = tracks[index]
    if (target !== undefined) selectTrack(target.id, true)
  }, [currentIndex, playbackMode, selectTrack, tracks])

  const cyclePlaybackMode = useCallback(() => {
    const current = PLAYBACK_MODES.indexOf(playbackMode)
    actions.setPlaybackMode(PLAYBACK_MODES[(current + 1) % PLAYBACK_MODES.length] ?? 'list')
  }, [actions, playbackMode])

  useEffect(() => {
    if (autoSkipTrackId === undefined || currentIndex < 0) return
    if (tracks.length < 2) {
      setStreamError('当前歌单中的歌曲暂时无法播放，请稍后重试或切换歌单。')
      setAutoSkipTrackId(undefined)
      return
    }
    const target = Array.from({ length: tracks.length - 1 }, (_, offset) => (
      tracks[(currentIndex + offset + 1) % tracks.length]
    )).find(track => track !== undefined && !failedTracks.current.has(track.id))
    if (target === undefined) {
      setStreamError('当前歌单中的歌曲都暂时无法播放，请稍后重试或切换歌单。')
      setAutoSkipTrackId(undefined)
      return
    }
    const timer = window.setTimeout(() => {
      setAutoSkipTrackId(undefined)
      selectTrack(target.id, playWhenReady || playing)
    }, 650)
    return () => { window.clearTimeout(timer) }
  }, [autoSkipTrackId, currentIndex, selectTrack, tracks, playWhenReady, playing])

  const seekTo = useCallback((seconds: number) => {
    const player = audio.current
    const upper = Number.isFinite(player?.duration) && (player?.duration ?? 0) > 0
      ? player?.duration ?? duration
      : duration
    const next = Math.max(0, Math.min(seconds, Math.max(upper, 0)))
    if (player !== null) player.currentTime = next
    setCurrentTime(next)
    if (currentTrackId !== '') actions.rememberProgress(currentTrackId, next)
  }, [actions, currentTrackId, duration])

  const seekBy = useCallback((seconds: number) => {
    seekTo((audio.current?.currentTime ?? currentTime) + seconds)
  }, [currentTime, seekTo])

  const requestPlay = useCallback(() => {
    const player = audio.current
    if (player === null) return
    if (!player.paused) {
      setPlayWhenReady(false)
      player.pause()
      return
    }
    setPlayWhenReady(true)
    void player.play().catch(() => {
      setStreamError('浏览器阻止了自动播放，请再次点击播放按钮。')
    })
  }, [])

  const filteredTracks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (needle === '') return tracks
    return tracks.filter(track => `${track.name} ${track.artists.join(' ')} ${track.album}`
      .toLocaleLowerCase().includes(needle))
  }, [query, tracks])
  const lyricLines = useMemo(() => lyricsState.phase === 'ready' ? lyricsState.lines : [], [lyricsState])
  const activeLyricIndex = useMemo(
    () => findActiveLyricIndex(lyricLines, currentTime),
    [currentTime, lyricLines],
  )

  useEffect(() => {
    if (!lyricsOpen || activeLyricIndex < 0) return
    activeLyric.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeLyricIndex, lyricsOpen])

  const onLoadedMetadata = (): void => {
    const player = audio.current
    if (player === null || currentTrack === undefined) return
    player.volume = storedVolume
    setDuration(Number.isFinite(player.duration) ? player.duration : currentTrack.durationMs / 1000)
    if (restoredTrack.current !== currentTrack.id) {
      const resume = storedTrackId === currentTrack.id ? storedPosition : 0
      const safeResume = resume > 0
        && (!Number.isFinite(player.duration) || resume < player.duration - 1)
        ? resume
        : 0
      player.currentTime = safeResume
      setCurrentTime(safeResume)
      restoredTrack.current = currentTrack.id
    }
    if (playWhenReady) void player.play().catch(() => {
      setStreamError('浏览器阻止了自动播放，请点击播放按钮继续。')
    })
  }

  return (
    <>
      <audio
        ref={audio}
        data-global-music-audio
        src={source}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onPlay={() => {
          failedTracks.current.clear()
          setAutoSkipTrackId(undefined)
          setPlaying(true)
          setStreamError(undefined)
        }}
        onPause={() => {
          setPlaying(false)
          if (suppressNextPauseSave.current) {
            suppressNextPauseSave.current = false
          } else {
            remember()
          }
        }}
        onEnded={() => {
          if (playbackMode === 'single') {
            seekTo(0)
            setPlayWhenReady(true)
            void audio.current?.play().catch(() => {
              setStreamError('浏览器阻止了自动播放，请点击播放按钮继续。')
            })
          } else {
            move(1)
          }
        }}
        onError={() => {
          if (source === undefined || currentTrack === undefined) return
          failedTracks.current.add(currentTrack.id)
          setStreamError('歌曲不可播放，可能受 VIP、版权或地区限制；正在自动跳过。')
          setAutoSkipTrackId(currentTrack.id)
        }}
        onTimeUpdate={(event) => {
          const next = event.currentTarget.currentTime
          setCurrentTime(next)
          if (Date.now() - lastProgressWrite.current >= PROGRESS_WRITE_INTERVAL_MS) remember()
        }}
      />
      {target ? createPortal(<div className={css.root}>
      <PlaylistSettingsRow useStore={useStore} actions={actions} />
      <section
        id="worldline-netease-music-panel"
        className={css.panel}
        aria-label="网易云音乐歌单播放器"
      >
        <header className={css.header}>
          <MusicCover key={catalogRevision} url={catalog?.coverUrl} title={catalog?.name} kind="playlist" compact />
          <div>
            <strong>{catalog?.name ?? '网易云歌单'}</strong>
            <div className={css.playlistSwitcher}>
              <select
                aria-label="切换网易云歌单"
                value={playlistId}
                onChange={(event) => { actions.selectPlaylist(event.currentTarget.value) }}
              >
                {playlists.map(playlist => <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>)}
              </select>
              <small>{catalog === undefined
                ? '正在读取完整歌单…'
                : `${String(tracks.length)} 首 · 完整歌单`}</small>
            </div>
          </div>
          <button type="button" className={css.refresh} aria-label="刷新歌单" onClick={() => setCatalogRevision(value => value + 1)}>刷新</button>
        </header>

        {catalogState.phase === 'error' ? <div className={css.loadState} role="alert">
          <strong>歌单加载失败</strong><span>{catalogState.message}</span>
          <button type="button" onClick={() => { setCatalogRevision(value => value + 1) }}>
            重新加载
          </button>
        </div> : <>
          <div className={css.nowPlaying}>
            <MusicCover key={catalogRevision} url={currentTrack?.coverUrl || catalog?.coverUrl} title={currentTrack?.name} kind="current-track" />
            <div className={css.trackInfo}>
              <strong title={currentTrack?.name}>{currentTrack?.name ?? '正在加载歌单'}</strong>
              <span title={trackArtists(currentTrack)}>{trackArtists(currentTrack)}</span>
              <input
                className={css.progress}
                type="range"
                aria-label="播放进度"
                min="0"
                max={Math.max(duration, 1)}
                step="0.1"
                value={Math.min(currentTime, Math.max(duration, 1))}
                disabled={currentTrack === undefined}
                onChange={(event) => {
                  seekTo(Number(event.currentTarget.value))
                }}
              />
              <div className={css.timeRow}>
                <span>{formatPlaybackTime(currentTime)}</span>
                <span>{formatPlaybackTime(duration)}</span>
              </div>
            </div>
          </div>
          <div className={css.controls}>
            <button
              type="button"
              className={css.lyricsToggle}
              aria-label={lyricsOpen ? '关闭滚动歌词' : '打开滚动歌词'}
              data-active={lyricsOpen || undefined}
              disabled={currentTrack === undefined}
              onClick={() => { setLyricsOpen(value => !value) }}
            >词</button>
            <button
              type="button"
              className={css.modeToggle}
              aria-label={`播放模式：${PLAYBACK_MODE_LABELS[playbackMode]}`}
              title={`播放模式：${PLAYBACK_MODE_LABELS[playbackMode]}`}
              data-mode={playbackMode}
              onClick={cyclePlaybackMode}
            >{PLAYBACK_MODE_MARKS[playbackMode]}</button>
            <button
              type="button"
              aria-label="上一首"
              disabled={tracks.length === 0}
              onClick={() => { move(-1) }}
            >◀</button>
            <button
              type="button"
              aria-label="快退 10 秒"
              disabled={currentTrack === undefined}
              onClick={() => { seekBy(-10) }}
            >−10</button>
            <button
              type="button"
              className={css.play}
              aria-label={playing ? '暂停' : '播放'}
              disabled={currentTrack === undefined || source === undefined}
              onClick={requestPlay}
            >{playing ? 'Ⅱ' : '▶'}</button>
            <button
              type="button"
              aria-label="快进 10 秒"
              disabled={currentTrack === undefined}
              onClick={() => { seekBy(10) }}
            >+10</button>
            <button
              type="button"
              aria-label="下一首"
              disabled={tracks.length === 0}
              onClick={() => { move(1) }}
            >▶</button>
            <label className={css.volume}>
              <span aria-hidden="true">♪</span>
              <input
                type="range"
                aria-label="音量"
                min="0"
                max="1"
                step="0.05"
                value={storedVolume}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value)
                  if (audio.current !== null) audio.current.volume = next
                  actions.setVolume(next)
                }}
              />
            </label>
          </div>
          {<div className={css.streamError} role="status" data-error={Boolean(streamError)}> 
            <span>{streamError ?? (playing ? '正在播放 · 切换页面后继续播放' : '已暂停 · 播放进度自动保存')}</span>
            {streamError ? <button type="button" onClick={() => { move(1) }}>下一首</button> : null}
          </div>}
          {lyricsOpen ? <>
            <div className={css.listHeader}>
              <strong>滚动歌词 <span>{currentTrack?.name ?? ''}</span></strong>
              <button type="button" onClick={() => { setLyricsOpen(false) }}>返回歌单</button>
            </div>
            <div className={css.lyrics} aria-label="滚动歌词" aria-live="off">
              {lyricsState.phase === 'loading' || lyricsState.phase === 'idle'
                ? <p className={css.lyricState}>正在加载歌词…</p>
                : lyricsState.phase === 'error'
                  ? <p className={css.lyricState}>歌词加载失败：{lyricsState.message}</p>
                  : lyricLines.length === 0
                    ? <p className={css.lyricState}>这首歌暂无滚动歌词</p>
                    : lyricLines.map((line, index) => <button
                      key={`${String(line.timeMs)}-${String(index)}`}
                      ref={index === activeLyricIndex ? activeLyric : undefined}
                      type="button"
                      aria-current={index === activeLyricIndex ? 'true' : undefined}
                      onClick={() => { seekTo(line.timeMs / 1_000) }}
                    >
                      <span>{line.text}</span>
                      {line.translatedText === undefined
                        ? null
                        : <small>{line.translatedText}</small>}
                    </button>)}
            </div>
          </> : <>
            <div className={css.listHeader}>
              <strong>全部歌曲 <span>{String(tracks.length)}</span></strong>
              <input
                value={query}
                aria-label="搜索歌单"
                placeholder="搜索歌曲"
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </div>
            <ol className={css.trackList} aria-label="完整歌单">
              {filteredTracks.map(track => <li
                key={track.id}
                data-current={track.id === currentTrackId || undefined}
              >
                <button type="button" onClick={() => { selectTrack(track.id) }}>
                  <span className={css.index}>{String(tracks.indexOf(track) + 1)}</span>
                  <MusicCover key={catalogRevision} url={track.coverUrl} title={track.name} kind="queue-track" compact />
                  <span className={css.trackText}>
                    <strong>{track.name}</strong><small>{trackArtists(track)}</small>
                  </span>
                  <span className={css.trackDuration}>{formatPlaybackTime(track.durationMs / 1000)}</span>
                </button>
              </li>)}
            </ol>
          </>}
        </>}

        <footer className={css.footer}>
          <label className={css.autoPlay}>
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={(event) => { actions.setAutoPlay(event.currentTarget.checked) }}
            />
            <span aria-hidden="true" />
            <strong>启动时自动播放</strong>
          </label>
          <p>歌曲、播放位置与音量会持久保存；关闭软件后重新打开也可恢复。</p>
          <a
            href={`https://music.163.com/#/playlist?id=${playlistId}`}
            target="_blank"
            rel="noreferrer"
          >在网易云中打开</a>
        </footer>
      </section>
    </div>, target) : null}
    </>
  )
}
