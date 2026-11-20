// Adapted from worldline-harness (MIT); see THIRD_PARTY_NOTICES.md.
// Source changes synchronize a persistent external HTMLAudioElement and reset its projections.
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  MusicControl,
  MusicLyricsWindowConfig,
  MusicShare,
  MusicQueuedTrack,
  NeteaseLyricLine,
  NeteasePlaylistCatalog,
  NeteasePlaylistTrack,
  NeteaseTrackLyrics,
  NeteaseTrackStream,
} from '../../shared/music'
import { loadMusicQueue } from '../../shared/music'
import { createPortal } from 'react-dom'
import { PlaylistSettingsRow } from './PlaylistSettingsRow'
import { MusicCover } from './MusicCover'
import { FloatingLyrics, useFloatingLyrics } from './FloatingLyrics'
import { BotIcon } from '../companion-bot/BotIcon'
import type { MusicEndpoint } from './music-endpoint'
import type { MusicPreferenceStore } from './store'
import {
  DEFAULT_NETEASE_PLAYLIST_ID,
  resolveNeteasePlaylists,
  type PlaybackMode,
} from './store'
import css from './NeteaseMusic.module.css'

export const DEFAULT_PLAYLIST_ID = DEFAULT_NETEASE_PLAYLIST_ID
const PROGRESS_WRITE_INTERVAL_MS = 2_000
const PLAYBACK_MODES: readonly PlaybackMode[] = ['list', 'single', 'shuffle', 'once']
const PLAYBACK_MODE_LABELS: Readonly<Record<PlaybackMode, string>> = {
  list: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
  once: '顺序播放一次',
}
const PLAYBACK_MODE_MARKS: Readonly<Record<PlaybackMode, string>> = {
  list: '循',
  single: '单',
  shuffle: '随',
  once: '顺',
}

export type NeteaseMusicProps =
  Pick<MusicPreferenceStore, 'useStore' | 'actions'> & { target: HTMLDivElement | null; endpoint?: MusicEndpoint; inline?: boolean; onClose?(): void; configureLyrics?(config: MusicLyricsWindowConfig): void;
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
  endpoint,
  inline = false,
  onClose,
  configureLyrics,
}: NeteaseMusicProps) {
  const autoPlay = useStore(state => state.autoPlay)
  const desktopLyricsVisible = useStore(state => state.desktopLyricsVisible)
  const storedTrackId = useStore(state => state.trackId)
  const storedPosition = useStore(state => state.positionSeconds ?? 0)
  const storedVolume = useStore(state => state.volume ?? 0.8)
  const playbackMode = useStore(state => state.playbackMode ?? 'list')
  const playlistId = useStore(state => state.playlistId ?? DEFAULT_PLAYLIST_ID)
  const storedPlaylists = useStore(state => state.playlists)
  const playlists = useMemo(
    () => resolveNeteasePlaylists({ playlists: storedPlaylists }),
    [storedPlaylists],
  )
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [catalogState, setCatalogState] = useState<CatalogState>({ phase: 'loading' })
  const [streamSource, setStreamSource] = useState<{ playlistId: string; trackId: string; url: string }>()
  const [streamError, setStreamError] = useState<string>()
  const [playing, setPlaying] = useState(false)
  const [playWhenReady, setPlayWhenReady] = useState(autoPlay)
  const [currentTime, setCurrentTime] = useState(storedPosition)
  const [duration, setDuration] = useState(0)
  const [query, setQuery] = useState('')
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(!inline)
  const [sharedQueue, setSharedQueue] = useState<{ card: MusicShare; tracks: MusicQueuedTrack[]; coverUrl: string }>()
  const reportLyricsError = useCallback((error: unknown) => setStreamError(messageOf(error)), [])
  const floating = useFloatingLyrics({
    restore: !inline && desktopLyricsVisible, rememberVisibility: actions.setDesktopLyricsVisible,
    reportError: reportLyricsError, configure: configureLyrics,
  })
  const [lyricsState, setLyricsState] = useState<LyricsState>({ phase: 'idle' })
  const [autoSkipTrackId, setAutoSkipTrackId] = useState<string>()
  const audio = useRef<HTMLAudioElement>(null)
  const activeLyric = useRef<HTMLButtonElement>(null)
  const playlistManager = useRef<HTMLDetailsElement>(null)
  const restoredTrack = useRef<string | undefined>(undefined)
  const suppressNextPauseSave = useRef(false)
  const lastProgressWrite = useRef(0)
  const failedTracks = useRef(new Set<string>())

  useLayoutEffect(() => {
    const player = audio.current
    return () => { player?.pause() }
  }, [])

  useEffect(() => {
    if (inline) return;
    const controller = new AbortController()
    setCatalogState({ phase: 'loading' })
    void loadCatalog(playlistId, controller.signal, catalogRevision > 0).then(
      (catalog) => { if (!controller.signal.aborted) setCatalogState({ phase: 'ready', catalog }) },
      (reason: unknown) => {
        if (!controller.signal.aborted) setCatalogState({ phase: 'error', message: messageOf(reason) })
      },
    )
    return () => { controller.abort() }
  }, [catalogRevision, inline, loadCatalog, playlistId])

  useEffect(() => {
    suppressNextPauseSave.current = audio.current !== null && !audio.current.paused
    if (audio.current && !audio.current.paused) audio.current.pause()
    restoredTrack.current = undefined
    setCurrentTime(0)
    setDuration(0)
    setStreamSource(undefined)
    setStreamError(undefined)
    setAutoSkipTrackId(undefined)
    failedTracks.current.clear()
  }, [playlistId])

  const catalog = catalogState.phase === 'ready' && catalogState.catalog.id === playlistId ? catalogState.catalog : undefined
  const tracks = useMemo(() => sharedQueue?.tracks ?? catalog?.tracks ?? [], [catalog, sharedQueue])
  const currentTrackId = tracks.some(track => track.id === storedTrackId) ? storedTrackId! : tracks[0]?.id ?? ''

  useEffect(() => {
    if (currentTrackId && storedTrackId !== currentTrackId) actions.initializeTrack(playlistId, storedTrackId, currentTrackId)
  }, [actions, currentTrackId, playlistId, storedTrackId])

  const currentIndex = tracks.findIndex(track => track.id === currentTrackId)
  const currentTrack = currentIndex < 0 ? undefined : tracks[currentIndex]
  const trackPlaylistId = sharedQueue?.tracks[currentIndex]?.playlistId ?? playlistId;
  const source = streamSource?.playlistId === trackPlaylistId && streamSource?.trackId === currentTrack?.id ? streamSource?.url : undefined;

  useEffect(() => {
    if (currentTrack === undefined) return
    const controller = new AbortController()
    setStreamSource(undefined)
    setStreamError(undefined)
    setDuration(currentTrack.durationMs / 1000)
    void resolveStream(trackPlaylistId, currentTrack.id, controller.signal).then(
      (stream) => {
        if (!controller.signal.aborted && stream.trackId === currentTrack.id) setStreamSource({ playlistId: trackPlaylistId, ...stream });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return
        failedTracks.current.add(currentTrack.id)
        setStreamError(`${messageOf(reason)}；正在自动跳过。`)
        setAutoSkipTrackId(currentTrack.id)
      },
    )
    return () => { controller.abort() }
  }, [currentTrack, trackPlaylistId, resolveStream])

  useEffect(() => {
    if (currentTrack === undefined) {
      setLyricsState({ phase: 'idle' })
      return
    }
    const controller = new AbortController()
    setLyricsState({ phase: 'loading' })
    void loadLyrics(trackPlaylistId, currentTrack.id, controller.signal).then(
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
  }, [currentTrack, loadLyrics, trackPlaylistId])

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

  const startAudio = useCallback((player: HTMLAudioElement) => {
    void player.play().catch((error: unknown) => {
      // Switching the source or pausing while the stream loads cancels play().
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        setPlayWhenReady(false)
        setStreamError('自动播放被阻止，请点击播放按钮继续。')
      }
    })
  }, [])

  const selectTrack = useCallback((trackId: string, keepPlaying = playing) => {
    const player = audio.current
    if (trackId === currentTrackId && player?.hasAttribute('src')) {
      player.currentTime = 0
      setPlayWhenReady(keepPlaying)
      if (keepPlaying && player.paused) startAudio(player)
      return
    }
    suppressNextPauseSave.current = player !== null && !player.paused
    player?.pause()
    if (player !== null) player.currentTime = 0
    restoredTrack.current = undefined
    setCurrentTime(0)
    setDuration(0)
    setPlayWhenReady(keepPlaying)
    actions.selectTrack(trackId)
  }, [actions, currentTrackId, playing, startAudio])

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
    const remaining = playbackMode === 'once' ? tracks.length - currentIndex - 1 : tracks.length - 1
    const target = Array.from({ length: remaining }, (_, offset) => (
      tracks[(currentIndex + offset + 1) % tracks.length]
    )).find(track => track !== undefined && !failedTracks.current.has(track.id))
    if (target === undefined) {
      setStreamError('没有下一首可播放的歌曲。')
      setPlayWhenReady(false)
      setAutoSkipTrackId(undefined)
      return
    }
    const timer = window.setTimeout(() => {
      setAutoSkipTrackId(undefined)
      selectTrack(target.id, playWhenReady || playing)
    }, 650)
    return () => { window.clearTimeout(timer) }
  }, [autoSkipTrackId, currentIndex, selectTrack, tracks, playWhenReady, playing, playbackMode])

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

  const requestPlay = useCallback((requested?: boolean) => {
    const player = audio.current
    if (player === null) return
    const play = requested ?? player.paused
    if (!play) {
      setPlayWhenReady(false)
      player.pause()
      return
    }
    setPlayWhenReady(true)
    if (player.paused && player.hasAttribute('src')) startAudio(player)
  }, [startAudio])

  // Tool commands can request playback before the stream URL is available.
  // Start as soon as React attaches that URL, including if metadata is cached.
  useEffect(() => {
    const player = audio.current
    if (source && playWhenReady && player?.paused) startAudio(player)
  }, [source, playWhenReady, startAudio])

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
  const activeLyricLine = lyricLines[activeLyricIndex]
  const lyricText = activeLyricLine?.text
    ?? (currentTrack ? lyricsState.phase === 'loading' ? '正在加载歌词…' : currentTrack.name : '桌面歌词')
  const managedPlaylist = playlists.find(item => item.id === playlistId)
  const runControl = async (control: MusicControl, active: AbortSignal): Promise<Record<string, unknown>> => {
    // The provider owns command/session cancellation. A development Strict Mode
    // effect replay still belongs to the same playback session.
    active.throwIfAborted();
    switch (control.action) {
      case 'playlists': return { activePlaylistId: playlistId, playlists };
      case 'save_playlist': actions.savePlaylist(control.playlist.name, control.playlist.id, control.playlist.description, false); return { saved: control.playlist };
      case 'remove_playlist': {
        if (!playlists.some(item => item.id === control.playlistId)) throw Error('没有找到这个已保存的歌单。');
        actions.removePlaylist(control.playlistId); return { removed: control.playlistId };
      }
      case 'select_playlist': actions.selectPlaylist(control.playlistId); return { selectedPlaylistId: control.playlistId };
      case 'present': {
        if (!inline) throw Error('分享的音乐需要在对话播放器中打开。');
        const { tracks, coverUrl } = await loadMusicQueue(control.card.queue, id => loadCatalog(id, active), active);
        active.throwIfAborted();
        const first = tracks[0];
        if (!first) throw Error('这份播放列表没有可用曲目。');
        failedTracks.current.clear();
        setAutoSkipTrackId(undefined);
        setSharedQueue({ card: control.card, tracks, coverUrl });
        actions.setPlaybackMode(control.card.mode);
        selectTrack(first.id, true);
        return { accepted: true, cardId: control.card.id, trackId: first.id, trackCount: tracks.length,
          mode: control.card.mode, message: '已提交卡片播放，status 可查询实际播放状态。' };
      }
      case 'play': {
        if (inline) {
          if (!sharedQueue) throw Error('请先在消息中选择要播放的音乐。');
          if (control.playlistId && !control.trackId &&
            (sharedQueue.card.queue.kind !== 'playlist' || sharedQueue.card.queue.playlistId !== control.playlistId))
            throw Error('请通过分享音乐在对话中打开新的歌单。');
          if (!control.trackId) { requestPlay(true); return { accepted: true }; }
          const track = sharedQueue.tracks.find(item => item.id === control.trackId && (!control.playlistId || item.playlistId === control.playlistId));
          if (!track) throw Error('这首歌不在当前对话播放列表。');
          selectTrack(track.id, true);
          return { accepted: true, playlistId: track.playlistId, trackId: track.id, trackName: track.name };
        }
        const id = control.playlistId ?? playlistId;
        const list = catalog?.id === id ? catalog : await loadCatalog(id, active);
        active.throwIfAborted();
        const track = control.trackId ? list.tracks.find(item => item.id === control.trackId)
          : id === playlistId ? list.tracks.find(item => item.id === currentTrackId) ?? list.tracks[0] : list.tracks[0];
        if (!track) throw Error(control.trackId ? '歌曲不属于指定歌单。' : '这个歌单没有可供选择的曲目。');
        if (id === playlistId && control.trackId) selectTrack(track.id, true);
        else if (id === playlistId && track.id === currentTrackId) requestPlay(true);
        else { actions.playTrack(id, track.id); setPlayWhenReady(true); }
        return { accepted: true, playlistId: id, trackId: track.id, trackName: track.name, message: '已提交播放，status 可查询实际播放状态。' };
      }
      case 'pause': requestPlay(false); return { paused: true };
      case 'resume': requestPlay(true); return { accepted: true };
      case 'previous': case 'next':
        if (!tracks.length) throw Error('当前歌单尚无曲目。');
        move(control.action === 'next' ? 1 : -1); return { accepted: true };
      case 'seek':
        if (!currentTrack) throw Error('当前没有歌曲。');
        seekTo(control.seconds); return { accepted: true };
      case 'volume':
        if (audio.current) audio.current.volume = control.volume;
        actions.setVolume(control.volume); return { volume: control.volume };
      case 'mode': actions.setPlaybackMode(control.mode); return { mode: control.mode };
      case 'lyrics':
        if (inline) setLyricsOpen(control.visible); else floating.show(control.visible);
        return { visible: control.visible };
      case 'status': {
        const player = audio.current;
        return {
          playlistId: trackPlaylistId, playlistName: inline ? sharedQueue?.card.title : managedPlaylist?.name ?? catalog?.name,
          trackCount: inline ? sharedQueue?.tracks.length : catalog?.trackCount,
          cardId: sharedQueue?.card.id, trackId: currentTrack?.id ?? storedTrackId, trackName: currentTrack?.name,
          artists: currentTrack?.artists, positionSeconds: source ? player?.currentTime ?? currentTime : storedPosition,
          durationSeconds: duration,
          playing: !!player && !player.paused && player.readyState >= 2,
          loading: !streamError && ((inline ? !sharedQueue : catalogState.phase === 'loading') ||
            !!currentTrack && (!source || playWhenReady && (player?.readyState ?? 0) < 2)),
          volume: storedVolume, mode: playbackMode, lyricsVisible: inline ? lyricsOpen : !!floating.target, error: streamError,
        };
      }
    }
  };
  useLayoutEffect(() => endpoint?.register(runControl))

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
  }

  return (
    <>
      <audio
        ref={audio}
        data-global-music-audio={inline ? undefined : true}
        data-inline-music-audio={inline || undefined}
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
            if (audio.current) startAudio(audio.current)
          } else if (playbackMode === 'once' && currentIndex >= tracks.length - 1) {
            setPlayWhenReady(false)
            setPlaying(false)
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
      {!inline && floating.target ? <FloatingLyrics target={floating.target} text={lyricText} translation={activeLyricLine?.translatedText}
        layout={floating.layout} captions={floating.captions} change={floating.setLayout} close={() => floating.show(false)}
        playing={playing} canPlay={currentTrack !== undefined && source !== undefined} canSkip={tracks.length > 0}
        togglePlayback={() => requestPlay()} skip={move} /> : null}
      {target ? createPortal(<div className={`${css.root} ${inline ? css.inline : css.settingsRoot}`}>
      <section
        id={inline ? undefined : 'worldline-netease-music-panel'}
        className={css.panel}
        data-inline-player={inline || undefined}
        aria-label={inline ? '对话音乐播放器' : '网易云音乐歌单播放器'}
      >
        {!inline && <header className={css.header}>
          <MusicCover key={catalogRevision} url={catalog?.coverUrl} title={catalog?.name} kind="playlist" compact />
          <div>
            <div className={css.playlistSwitcher}>
              <label className={css.playlistSelect} title={managedPlaylist?.description || undefined}><select
                aria-label="切换网易云歌单"
                value={playlistId}
                onChange={(event) => { actions.selectPlaylist(event.currentTarget.value) }}
              >
                {playlists.map(playlist => <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>)}
                {!managedPlaylist && <option value={playlistId}>{catalog?.name ?? playlistId}</option>}
              </select><BotIcon name="chevron-down" /></label>
              <small>{catalog === undefined
                ? '正在读取完整歌单…'
                : `${String(tracks.length)} 首${catalog.stale ? ' · 缓存' : tracks.length < catalog.trackCount ? ' · 部分曲目' : ' · 完整歌单'}`}</small>
            </div>
          </div>
          <div className={css.playlistTools}>
              <button type="button" aria-label="管理歌单" title="管理歌单" onClick={() => {
                const manager = playlistManager.current
                if (!manager) return
                manager.open = true
                manager.scrollIntoView({ block: 'start' })
                manager.querySelector('summary')?.focus({ preventScroll: true })
              }}><BotIcon name="settings" /></button>
              <button type="button" aria-label="刷新歌单" title="刷新歌单" onClick={() => setCatalogRevision(value => value + 1)}><BotIcon name="replay" /></button>
          </div>
        </header>}

        {!inline && catalogState.phase === 'error' ? <div className={css.loadState} role="alert">
          <strong>歌单加载失败</strong><span>{catalogState.message}</span>
          <button type="button" onClick={() => { setCatalogRevision(value => value + 1) }}>
            重新加载
          </button>
        </div> : <>
          <div className={css.playerDeck}>
          <div className={css.nowPlaying}>
            <MusicCover key={catalogRevision} url={currentTrack?.coverUrl || sharedQueue?.coverUrl || catalog?.coverUrl} title={currentTrack?.name} kind="current-track" />
            <div className={css.trackInfo}>
              {!inline && <small className={css.playbackStatus} data-playing={playing || undefined}>
                {playing ? '正在播放' : currentTrack && !source && !streamError ? '正在加载音频' : currentTrack ? '已暂停' : ''}
              </small>}
              {inline && sharedQueue && sharedQueue.card.title !== currentTrack?.name && <small className={css.sharedTitle} title={sharedQueue.card.title}>{sharedQueue.card.title}</small>}
              <strong title={currentTrack?.name}>{currentTrack?.name ?? (inline ? '正在加载音乐…' : catalog ? '歌单中暂无曲目' : '正在加载歌单')}</strong>
              <span title={trackArtists(currentTrack)}>{trackArtists(currentTrack)}</span>
              <input
                className={css.progress}
                type="range"
                aria-label="播放进度"
                min="0"
                max={Math.max(duration, 1)}
                step="0.1"
                value={Math.min(currentTime, Math.max(duration, 1))}
                style={{ '--filled': `${Math.min(100, currentTime / Math.max(duration, 1) * 100)}%` } as CSSProperties}
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
            {inline && <button type="button" className={css.finish} aria-label="关闭对话音乐播放器" title="收起播放器" onClick={onClose}><BotIcon name="close" /></button>}
          </div>
          <div className={css.controls}>
            <div className={css.utilityControls}>
            <button
              type="button"
              className={css.lyricsToggle}
              aria-label={lyricsOpen ? '关闭滚动歌词' : '打开滚动歌词'}
              data-active={lyricsOpen || undefined}
              disabled={currentTrack === undefined}
              onClick={() => { setLyricsOpen(value => !value) }}
              title={lyricsOpen ? '关闭滚动歌词' : '打开滚动歌词'}
              aria-pressed={lyricsOpen}
            ><BotIcon name={inline ? 'lyrics' : 'list'} />{!inline && <span>歌词</span>}</button>
            {inline ? <button type="button" aria-label="切换播放列表" aria-expanded={queueOpen && !lyricsOpen}
              title="播放列表" onClick={() => { setLyricsOpen(false); setQueueOpen(value => lyricsOpen || !value); }}><BotIcon name="list" /></button>
              : <button type="button" className={css.floatingToggle} aria-label={floating.target ? '关闭桌面歌词' : '打开桌面歌词'}
                aria-pressed={!!floating.target} title="桌面歌词" data-active={floating.target ? true : undefined}
                onClick={() => { try { floating.show(!floating.target); } catch (error) { setStreamError(messageOf(error)); } }}><BotIcon name="screen" /><span>桌面歌词</span></button>}
            <button
              type="button"
              className={css.modeToggle}
              aria-label={`播放模式：${PLAYBACK_MODE_LABELS[playbackMode]}`}
              title={`播放模式：${PLAYBACK_MODE_LABELS[playbackMode]}`}
              data-mode={playbackMode}
              onClick={cyclePlaybackMode}
            >{PLAYBACK_MODE_MARKS[playbackMode]}</button>
            </div>
            <div className={css.transport}>
            <button
              type="button"
              aria-label="上一首"
              disabled={tracks.length === 0}
              onClick={() => { move(-1) }}
            ><BotIcon name="skip-back" /></button>
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
              onClick={() => requestPlay()}
            ><BotIcon name={playing ? 'pause' : 'play'} /></button>
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
            ><BotIcon name="skip-forward" /></button>
            </div>
            <label className={css.volume}>
              <BotIcon name={storedVolume === 0 ? 'volume-off' : 'volume'} />
              <input
                type="range"
                aria-label="音量"
                min="0"
                max="1"
                step="0.05"
                value={storedVolume}
                style={{ '--filled': `${storedVolume * 100}%` } as CSSProperties}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value)
                  if (audio.current !== null) audio.current.volume = next
                  actions.setVolume(next)
                }}
              />
            </label>
          </div>
          {streamError && <div className={css.streamError} role="status" data-error="true">
            <BotIcon name="info" /><span>{streamError}</span>
          </div>}
          </div>
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
          </> : queueOpen ? <>
            <div className={css.listHeader}>
              <strong>全部歌曲 <span>{String(tracks.length)}</span></strong>
              <label className={css.trackSearch}><BotIcon name="search" /><input
                value={query}
                aria-label="搜索歌单"
                placeholder="搜索歌曲"
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              /></label>
            </div>
            <ol className={css.trackList} aria-label="完整歌单">
              {filteredTracks.map(track => <li
                key={track.id}
                data-current={track.id === currentTrackId || undefined}
              >
                <button type="button" onClick={() => { selectTrack(track.id, true) }}>
                  <span className={css.index}>{track.id === currentTrackId ? <BotIcon name={playing ? 'volume' : 'play'} /> : String(tracks.indexOf(track) + 1)}</span>
                  <MusicCover key={catalogRevision} url={track.coverUrl} title={track.name} kind="queue-track" compact />
                  <span className={css.trackText}>
                    <strong>{track.name}</strong><small>{trackArtists(track)}</small>
                  </span>
                  <span className={css.trackDuration}>{formatPlaybackTime(track.durationMs / 1000)}</span>
                </button>
              </li>)}
            </ol>
            {query.trim() && !filteredTracks.length && <p className={css.lyricState}>未找到匹配的歌曲</p>}
          </> : null}
        </>}

        {!inline && <footer className={css.footer}>
          <label className={css.autoPlay}>
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={(event) => { actions.setAutoPlay(event.currentTarget.checked) }}
            />
            <strong>启动时自动播放</strong>
          </label>
          <a
            href={`https://music.163.com/#/playlist?id=${playlistId}`}
            target="_blank"
            rel="noreferrer"
          >在网易云中打开 <BotIcon name="external" /></a>
        </footer>}
      </section>
      {!inline && <PlaylistSettingsRow useStore={useStore} actions={actions} detailsRef={playlistManager} />}
    </div>, target) : null}
    </>
  )
}
