// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createMusicPreferenceStore,
  resolveNeteasePlaylists,
} from '../src/client/store.ts'

beforeEach(() => { localStorage.clear() })

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
