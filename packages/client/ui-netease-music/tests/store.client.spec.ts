// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMusicPreferenceStore,
  resolveNeteasePlaylists,
} from '../src/client/store.ts'

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=', 1)[0]?.trim()
    if (name !== undefined && name !== '') document.cookie = `${name}=; Path=/; Max-Age=0`
  }
})

describe('music preference store', () => {
  it('defaults autoplay off on first install', () => {
    const first = createMusicPreferenceStore().create()
    expect(first.store.getSnapshot()).toEqual({
      autoPlay: false,
      positionSeconds: 0,
      volume: 0.8,
      playbackMode: 'list',
      playlistId: '18322613388',
      playlists: [],
    })
  })

  it('rehydrates an autoplay opt-in together with the playback checkpoint', () => {
    const first = createMusicPreferenceStore().create()
    first.actions.setAutoPlay(true)
    first.actions.selectTrack('3419785927')
    first.actions.rememberProgress('3419785927', 83.25)
    first.actions.setVolume(0.45)
    first.actions.setPlaybackMode('shuffle')
    first.actions.setPlaylistId('123456')
    first.actions.selectTrack('3419785927')
    first.actions.rememberProgress('3419785927', 83.25)

    const restored = createMusicPreferenceStore().create()
    expect(restored.store.getSnapshot()).toEqual({
      autoPlay: true,
      trackId: '3419785927',
      positionSeconds: 83.25,
      volume: 0.45,
      playbackMode: 'shuffle',
      playlistId: '123456',
      playlists: [{ id: '123456', name: '歌单 123456' }],
    })
  })

  it('keeps an explicit autoplay choice when the desktop loopback port changes', () => {
    vi.stubGlobal('__WORLDLINE_STORAGE_NAMESPACE__', 'user-1')
    const firstOrigin = createMusicPreferenceStore().create()
    firstOrigin.actions.setAutoPlay(true)
    expect(document.cookie).toContain('worldline_netease_autoplay_user-1=1')

    // A fresh loopback origin cannot see the old origin's localStorage, while
    // its host-scoped cookie remains available on 127.0.0.1.
    localStorage.clear()
    const nextOrigin = createMusicPreferenceStore().create()
    expect(nextOrigin.store.getSnapshot().autoPlay).toBe(true)

    nextOrigin.actions.setAutoPlay(false)
    localStorage.clear()
    expect(createMusicPreferenceStore().create().store.getSnapshot().autoPlay).toBe(false)
  })

  it('keeps the default immutable and persists named playlists with live selection', () => {
    const instance = createMusicPreferenceStore().create()
    instance.actions.savePlaylist('通勤', '222222')
    instance.actions.savePlaylist('学习', '333333')
    expect(resolveNeteasePlaylists(instance.store.getSnapshot())).toEqual([
      { id: '18322613388', name: '默认' },
      { id: '222222', name: '通勤' },
      { id: '333333', name: '学习' },
    ])
    expect(instance.store.getSnapshot().playlistId).toBe('333333')

    instance.actions.selectPlaylist('222222')
    expect(instance.store.getSnapshot().playlistId).toBe('222222')
    instance.actions.removePlaylist('222222')
    expect(instance.store.getSnapshot().playlistId).toBe('18322613388')
    expect(() => { instance.actions.removePlaylist('18322613388') }).toThrow('不可删除')

    instance.actions.restoreDefaultPlaylist()
    expect(instance.store.getSnapshot().playlistId).toBe('18322613388')
    expect(resolveNeteasePlaylists(instance.store.getSnapshot())[0]).toEqual({
      id: '18322613388', name: '默认',
    })
  })

  it('surfaces a legacy single playlist without losing it', () => {
    localStorage.setItem('worldline.netease-music.preferences.v1', JSON.stringify({
      autoPlay: false,
      playlistId: '987654',
    }))
    const instance = createMusicPreferenceStore().create()
    expect(resolveNeteasePlaylists(instance.store.getSnapshot())).toEqual([
      { id: '18322613388', name: '默认' },
      { id: '987654', name: '歌单 987654' },
    ])
    instance.actions.restoreDefaultPlaylist()
    expect(instance.store.getSnapshot()).toMatchObject({
      playlistId: '18322613388',
      playlists: [{ id: '987654', name: '歌单 987654' }],
    })
  })
})
