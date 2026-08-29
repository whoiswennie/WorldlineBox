// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { NeteasePlaylistCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { NeteaseMusic } from '../src/client/NeteaseMusic.tsx'
import type { NeteaseMusicProps } from '../src/client/NeteaseMusic.tsx'
import type { MusicPreferences } from '../src/client/store.ts'

const catalog: NeteasePlaylistCatalog = {
  id: '18322613388',
  name: '这就是天幻呀的歌单',
  coverUrl: 'https://p1.music.126.net/playlist.jpg',
  trackCount: 12,
  tracks: Array.from({ length: 12 }, (_, index) => ({
    id: String(1000 + index),
    name: `歌曲 ${String(index + 1)}`,
    artists: ['这就是天幻呀'],
    album: '作品集',
    coverUrl: `https://p1.music.126.net/${String(index + 1)}.jpg`,
    durationMs: 120_000 + index * 1_000,
  })),
}

let play = vi.fn<() => Promise<void>>()

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  play = vi.fn<() => Promise<void>>().mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function props(state: MusicPreferences = { autoPlay: true }): NeteaseMusicProps {
  const useStore = <T,>(selector: (value: MusicPreferences) => T): T => selector(state)
  return {
    useStore,
    actions: {
      setAutoPlay: vi.fn(),
      selectTrack: vi.fn(),
      rememberProgress: vi.fn(),
      setVolume: vi.fn(),
      setPlaybackMode: vi.fn(),
      savePlaylist: vi.fn(),
      removePlaylist: vi.fn(),
      selectPlaylist: vi.fn(),
      restoreDefaultPlaylist: vi.fn(),
      setPlaylistId: vi.fn(),
    },
    loadCatalog: vi.fn(async () => catalog),
    resolveStream: vi.fn(async (_playlistId: string, trackId: string) => ({
      trackId,
      url: `https://m801.music.126.net/${trackId}.mp3`,
    })),
    loadLyrics: vi.fn(async (_playlistId: string, trackId: string) => ({
      trackId,
      lines: [
        { timeMs: 1_000, text: '第一句', translatedText: 'First line' },
        { timeMs: 10_000, text: '第二句' },
        { timeMs: 30_000, text: '第三句' },
      ],
    })),
  } as unknown as NeteaseMusicProps
}

describe('built-in complete NetEase music surface', () => {
  it('renders songs beyond the official ten-row limit and keeps one audio element mounted', async () => {
    const view = render(<NeteaseMusic {...props({ autoPlay: false })} />)
    const audio = view.container.querySelector('audio')
    expect(audio).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    expect(await screen.findByText('歌曲 12')).toBeTruthy()
    expect(screen.getByText('12 首 · 完整歌单')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '关闭歌单' }))
    expect(view.container.querySelector('audio')).toBe(audio)
    expect(screen.getByLabelText('网易云音乐歌单播放器').getAttribute('data-open')).toBe('false')
  })

  it('marks the open panel as a native-browser occluder', () => {
    render(<NeteaseMusic {...props({ autoPlay: false })} />)

    const panel = screen.getByLabelText('网易云音乐歌单播放器')
    expect(panel.hasAttribute('data-native-browser-occluder')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    expect(panel.getAttribute('data-native-browser-occluder')).toBe('true')
  })

  it('switches immediately between every saved named playlist', async () => {
    const input = props({
      autoPlay: false,
      playlistId: '18322613388',
      playlists: [{ id: '222222', name: '通勤' }],
    })
    render(<NeteaseMusic {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    await screen.findByText('歌曲 12')

    const switcher = screen.getByRole('combobox', { name: '切换网易云歌单' })
    expect(screen.getByRole('option', { name: '默认' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '通勤' })).toBeTruthy()
    fireEvent.change(switcher, { target: { value: '222222' } })
    expect(input.actions.selectPlaylist).toHaveBeenCalledWith('222222')
  })

  it('restores the saved track, timestamp and volume before default autoplay', async () => {
    const input = props({
      autoPlay: true,
      trackId: '1005',
      positionSeconds: 42.5,
      volume: 0.35,
    })
    const view = render(<NeteaseMusic {...input} />)
    await waitFor(() => {
      expect(input.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1005',
        expect.any(AbortSignal),
      )
    })
    const audio = view.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 125 })
    fireEvent.loadedMetadata(audio)

    expect(audio.currentTime).toBe(42.5)
    expect(audio.volume).toBe(0.35)
    expect(play).toHaveBeenCalled()
  })

  it('honors a persisted autoplay opt-in while restoring its checkpoint', async () => {
    const input = props({ autoPlay: true, trackId: '1005', positionSeconds: 42.5 })
    const view = render(<NeteaseMusic {...input} />)
    await waitFor(() => {
      expect(input.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1005',
        expect.any(AbortSignal),
      )
    })
    const audio = view.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 125 })
    fireEvent.loadedMetadata(audio)

    expect(audio.currentTime).toBe(42.5)
    expect(play).toHaveBeenCalled()
    expect((view.container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked)
      .toBe(true)
  })

  it('persists progress and can select any song in the complete list', async () => {
    const input = props({ autoPlay: false })
    const view = render(<NeteaseMusic {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    await screen.findByText('歌曲 12')
    const audio = view.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      writable: true,
      value: 17,
    })
    fireEvent.timeUpdate(audio)
    expect(input.actions.rememberProgress).toHaveBeenCalledWith('1000', 17)

    fireEvent.click(screen.getByRole('button', { name: /歌曲 12/ }))
    expect(input.actions.selectTrack).toHaveBeenCalledWith('1011')
    await waitFor(() => {
      expect(input.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1011',
        expect.any(AbortSignal),
      )
    })
  })

  it('resets playback to zero when switching tracks without restoring the previous position', async () => {
    const input = props({ autoPlay: false, trackId: '1000', positionSeconds: 45 })
    const view = render(<NeteaseMusic {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    await screen.findByText('歌曲 12')
    const audio = view.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      writable: true,
      value: 45,
    })
    Object.defineProperty(audio, 'paused', { configurable: true, value: false })
    fireEvent.loadedMetadata(audio)
    expect(audio.currentTime).toBe(45)

    vi.mocked(input.actions.rememberProgress).mockClear()
    fireEvent.click(screen.getByRole('button', { name: /歌曲 12/ }))
    expect(audio.currentTime).toBe(0)
    await waitFor(() => {
      expect(input.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1011',
        expect.any(AbortSignal),
      )
    })

    audio.currentTime = 45
    fireEvent.pause(audio)
    fireEvent.loadedMetadata(audio)
    expect(audio.currentTime).toBe(0)
    expect(input.actions.rememberProgress).not.toHaveBeenCalledWith('1011', 45)
    expect(input.actions.rememberProgress).not.toHaveBeenCalledWith('1000', 45)
    expect(input.actions.selectTrack).toHaveBeenCalledWith('1011')
  })

  it('persists the autoplay toggle without replacing the active audio element', async () => {
    const input = props({ autoPlay: false })
    const view = render(<NeteaseMusic {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    await screen.findByText('歌曲 1')
    const audio = view.container.querySelector('audio')

    fireEvent.click(screen.getByRole('checkbox', { name: '启动时自动播放' }))
    expect(input.actions.setAutoPlay).toHaveBeenCalledWith(true)
    expect(view.container.querySelector('audio')).toBe(audio)
  })

  it('opens and closes synchronized lyrics and follows progress changes', async () => {
    const input = props({ autoPlay: false })
    const view = render(<NeteaseMusic {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    await screen.findByText('歌曲 1')
    fireEvent.click(screen.getByRole('button', { name: '打开滚动歌词' }))
    expect(await screen.findByText('第二句')).toBeTruthy()

    const audio = view.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 11 })
    fireEvent.timeUpdate(audio)
    expect(screen.getByText('第二句').closest('button')?.getAttribute('aria-current')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '关闭滚动歌词' }))
    expect(screen.getByLabelText('完整歌单')).toBeTruthy()
    expect(view.container.querySelector('audio')).toBe(audio)
  })

  it('supports ten-second rewind and fast-forward and saves the new position', async () => {
    const input = props({ autoPlay: false })
    const view = render(<NeteaseMusic {...input} />)
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    await screen.findByText('歌曲 1')
    const audio = view.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
    Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 50 })

    fireEvent.click(screen.getByRole('button', { name: '快退 10 秒' }))
    expect(audio.currentTime).toBe(40)
    fireEvent.click(screen.getByRole('button', { name: '快进 10 秒' }))
    expect(audio.currentTime).toBe(50)
    expect(input.actions.rememberProgress).toHaveBeenLastCalledWith('1000', 50)
  })

  it('saves progress during application shutdown for the next startup restore', async () => {
    const input = props({ autoPlay: false })
    const view = render(<NeteaseMusic {...input} />)
    await waitFor(() => {
      expect(input.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1000',
        expect.any(AbortSignal),
      )
    })
    const audio = view.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 63.5 })
    fireEvent.timeUpdate(audio)
    audio.currentTime = 0
    fireEvent(window, new Event('pagehide'))
    expect(input.actions.rememberProgress).toHaveBeenLastCalledWith('1000', 63.5)
  })

  it('defaults to list looping and cycles through single-song and shuffle modes', async () => {
    const list = props({ autoPlay: false })
    render(<NeteaseMusic {...list} />)
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    await screen.findByText('歌曲 1')
    fireEvent.click(screen.getByRole('button', { name: '播放模式：列表循环' }))
    expect(list.actions.setPlaybackMode).toHaveBeenCalledWith('single')

    cleanup()
    const single = props({ autoPlay: false, playbackMode: 'single' })
    render(<NeteaseMusic {...single} />)
    await screen.findByText('歌曲 1')
    fireEvent.click(screen.getByRole('button', { name: '网易云歌单' }))
    fireEvent.click(screen.getByRole('button', { name: '播放模式：单曲循环' }))
    expect(single.actions.setPlaybackMode).toHaveBeenCalledWith('shuffle')
  })

  it('repeats one song and chooses a different song in shuffle mode', async () => {
    const single = props({ autoPlay: false, playbackMode: 'single' })
    const singleView = render(<NeteaseMusic {...single} />)
    await waitFor(() => {
      expect(single.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1000',
        expect.any(AbortSignal),
      )
    })
    const singleAudio = singleView.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(singleAudio, 'duration', { configurable: true, value: 120 })
    Object.defineProperty(singleAudio, 'currentTime', {
      configurable: true,
      writable: true,
      value: 120,
    })
    fireEvent.ended(singleAudio)
    expect(singleAudio.currentTime).toBe(0)
    expect(play).toHaveBeenCalled()

    cleanup()
    vi.spyOn(Math, 'random').mockReturnValue(0.75)
    const shuffle = props({ autoPlay: false, playbackMode: 'shuffle' })
    const shuffleView = render(<NeteaseMusic {...shuffle} />)
    await waitFor(() => {
      expect(shuffle.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1000',
        expect.any(AbortSignal),
      )
    })
    fireEvent.ended(shuffleView.container.querySelector('audio') as HTMLAudioElement)
    expect(shuffle.actions.selectTrack).toHaveBeenCalledWith('1009')
  })

  it('automatically skips a VIP or otherwise unavailable stream', async () => {
    const input = props({ autoPlay: false })
    input.resolveStream = vi.fn(async (_playlistId: string, trackId: string) => {
      if (trackId === '1000') throw new Error('没有公开播放地址')
      return { trackId, url: `https://m801.music.126.net/${trackId}.mp3` }
    })
    render(<NeteaseMusic {...input} />)

    await waitFor(() => {
      expect(input.actions.selectTrack).toHaveBeenCalledWith('1001')
    }, { timeout: 1_500 })
    await waitFor(() => {
      expect(input.resolveStream).toHaveBeenCalledWith(
        '18322613388',
        '1001',
        expect.any(AbortSignal),
      )
    })
  })
})
