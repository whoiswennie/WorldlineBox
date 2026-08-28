// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlaylistSettingsRow } from '../src/client/PlaylistSettingsRow.tsx'
import type { PlaylistSettingsRowProps } from '../src/client/PlaylistSettingsRow.tsx'
import type { MusicPreferences } from '../src/client/store.ts'

afterEach(() => { cleanup() })

describe('NetEase playlist settings row', () => {
  it('manages named playlists while keeping the built-in default recoverable', () => {
    const state: MusicPreferences = {
      autoPlay: true,
      playlistId: '18322613388',
      playlists: [{ id: '222222', name: '通勤' }],
    }
    const actions = {
      restoreDefaultPlaylist: vi.fn(),
      savePlaylist: vi.fn(),
      selectPlaylist: vi.fn(),
      removePlaylist: vi.fn(),
    }
    const useStore = <T,>(selector: (value: MusicPreferences) => T): T => selector(state)
    render(<PlaylistSettingsRow {...({
      useStore,
      actions,
    } as unknown as PlaylistSettingsRowProps)} />)

    expect(screen.getByText('默认')).toBeTruthy()
    expect(screen.getByText('内置 · 不可删除')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除歌单 默认' })).toBeNull()
    expect(screen.getByRole('button', { name: '恢复默认' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '切换到歌单 通勤' }))
    expect(actions.selectPlaylist).toHaveBeenCalledWith('222222')
    fireEvent.click(screen.getByRole('button', { name: '删除歌单 通勤' }))
    expect(actions.removePlaylist).toHaveBeenCalledWith('222222')

    const nameInput = screen.getByRole('textbox', { name: '歌单名称' })
    const idInput = screen.getByRole('textbox', { name: '网易云歌单 ID' })
    fireEvent.change(nameInput, { target: { value: '学习' } })
    fireEvent.change(idInput, { target: { value: 'not-an-id' } })
    expect(idInput.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('button', { name: '保存并切换' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(idInput, { target: { value: '123456789' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并切换' }))
    expect(actions.savePlaylist).toHaveBeenCalledWith('学习', '123456789')

    cleanup()
    const customState: MusicPreferences = {
      ...state,
      playlistId: '222222',
    }
    const customUseStore = <T,>(selector: (value: MusicPreferences) => T): T => (
      selector(customState)
    )
    render(<PlaylistSettingsRow {...({
      useStore: customUseStore,
      actions,
    } as unknown as PlaylistSettingsRowProps)} />)
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(actions.restoreDefaultPlaylist).toHaveBeenCalledOnce()
  })
})
