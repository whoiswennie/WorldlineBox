// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  ClockTopbar, WorkspaceTopbar,
  type ClockTopbarProps,
  type RuntimeStatusProps,
  RuntimeStatus,
} from '../src/client/ChromeSeats.tsx'

afterEach(cleanup)

const sid = (value: string) => value as SessionId
const wid = (value: string) => value as WorkspaceId
const workspace = (id: string, path: string): WorkspaceView => ({
  workspaceId: wid(id), path, title: id,
  sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

describe('restored Worldline chrome', () => {
  it('replaces framework readiness copy with startup toolchain versions', async () => {
    const props = {
      loadToolchains: () => Promise.resolve({
        python: { ready: true, version: '3.13.7' },
        node: { ready: true, version: '22.19.0' },
        git: { ready: false },
        detectedAt: Date.now(),
      }),
    } as unknown as RuntimeStatusProps
    render(<RuntimeStatus {...props} />)

    expect(screen.getAllByText('检测中…')).toHaveLength(3)
    await screen.findByText('v3.13.7')
    expect(screen.getByText('v22.19.0')).toBeTruthy()
    expect(screen.getByText('未检测到')).toBeTruthy()
    expect(screen.queryByText(/Agent Runtime|Cordis 插件系统/)).toBeNull()
  })

  it('switches workspaces from the top bar without inventing a second workspace state', () => {
    const alpha = workspace('Alpha', 'C:\\projects\\alpha')
    const beta = workspace('Beta', 'C:\\projects\\beta')
    const sessions: SessionListState = {
      ids: [sid('current')],
      byId: { [sid('current')]: { id: sid('current'), displayTitle: 'current', cwd: alpha.path, running: false, blank: false, updatedAt: 1 } },
      current: sid('current'), currentAddress: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {},
    }
    const workspaces: WorkspaceListState = {
      items: [alpha, beta], recentWorkspaceId: alpha.workspaceId, archivedSessionIds: [],
      state: 'idle', phase: 'ready', error: null, baselinesReady: true,
    }
    const switchWorkspace = vi.fn()
    render(<WorkspaceTopbar {...({
      useSessions: hook(sessions), useWorkspaces: hook(workspaces), switchWorkspace,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: /会话工作空间/ }))
    const workspaceChevron = screen.getByRole('button', { name: /会话工作空间/ }).querySelector('svg[data-open]')
    expect(workspaceChevron?.getAttribute('data-open')).toBe('true')
    expect(workspaceChevron?.querySelector('path')?.getAttribute('d')).toBe('m7 9.5 5 5 5-5')
    expect(screen.getByRole('menu', { name: '切换工作空间' })).toBeTruthy()
    const betaOption = screen.getByRole('menuitemradio', { name: /Beta/ })
    expect(betaOption.querySelector('svg')).toBeTruthy()
    expect(betaOption.textContent).not.toContain('▱')
    fireEvent.click(betaOption)
    expect(switchWorkspace).toHaveBeenCalledOnce()
    expect(switchWorkspace).toHaveBeenCalledWith(beta.workspaceId)
  })

  it('opens the live time and map panel and tracks device position', async () => {
    const clearWatch = vi.fn()
    const watchPosition = vi.fn((success: PositionCallback) => {
      success({ coords: {
        latitude: 30.989, longitude: 121.4261, accuracy: 100,
        altitude: null, altitudeAccuracy: null, heading: null, speed: null,
      }, timestamp: Date.now() } as GeolocationPosition)
      return 7
    })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true, value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() },
    })
    render(<ClockTopbar {...({} as ClockTopbarProps)} />)

    const clockButton = screen.getByRole('button', { name: /\d{2}:\d{2}:\d{2}/ })
    fireEvent.click(clockButton)
    expect(clockButton.querySelector('svg[data-open]')?.getAttribute('data-open')).toBe('true')
    expect(screen.getByLabelText('时间与实时定位').hasAttribute(
      'data-native-browser-occluder',
    )).toBe(true)
    await waitFor(() => {
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain('30.9890°')
    })
    expect(watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000,
    })

    expect(screen.queryByRole('button', { name: '展开或收起右侧工作区' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(clearWatch).toHaveBeenCalledWith(7)
  })
})
