// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ProductStatus } from '../src/client/DesktopUpdate.tsx'
import type { DesktopUpdateSnapshot } from '../src/client/desktop-update-controller.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function props(state: DesktopUpdateSnapshot, overrides: Partial<ComponentProps<typeof ProductStatus>> = {}) {
  return {
    useUpdate: (selector: (snapshot: DesktopUpdateSnapshot) => unknown) => selector(state),
    checkUpdate: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ComponentProps<typeof ProductStatus>
}

const available: DesktopUpdateSnapshot = {
  revision: 2,
  phase: 'available',
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  releaseDate: '2026-08-28T12:00:00.000Z',
  releaseNotes: '更清晰的启动进度\n- 自动更新体验',
  totalBytes: 1024 * 1024 * 80,
}

describe('Worldline desktop update surface', () => {
  it('opens for a newer version, dismisses, and remains available from the yellow status cue', async () => {
    render(<ProductStatus {...props(available)} />)

    expect(await screen.findByRole('dialog', { name: '发现 WorldlineBox 新版本' })).toBeTruthy()
    expect(screen.getByText('更清晰的启动进度')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '暂不更新' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    const cue = screen.getByRole('button', { name: '发现新版本 v0.2.0' })
    expect(cue.hasAttribute('data-actionable')).toBe(true)
    fireEvent.click(cue)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('starts an immediate update and renders real download progress', async () => {
    const downloadUpdate = vi.fn(async () => {})
    const installUpdate = vi.fn(async () => {})
    const view = render(<ProductStatus {...props(available, { downloadUpdate, installUpdate })} />)
    fireEvent.click(await screen.findByRole('button', { name: '立即更新' }))
    expect(downloadUpdate).toHaveBeenCalledOnce()

    view.rerender(<ProductStatus {...props({
      ...available,
      revision: 4,
      phase: 'downloading',
      downloadedBytes: 40 * 1024 * 1024,
      percent: 50,
      bytesPerSecond: 5 * 1024 * 1024,
    }, { downloadUpdate, installUpdate })} />)
    expect(screen.getAllByText('50%')).toHaveLength(2)
    expect(screen.getByText('40.0 MB / 80.0 MB')).toBeTruthy()
    expect(screen.getByRole('button', { name: '正在更新 50%' })).toBeTruthy()

    view.rerender(<ProductStatus {...props({
      ...available,
      revision: 5,
      phase: 'ready',
      downloadedBytes: 80 * 1024 * 1024,
      percent: 100,
    }, { downloadUpdate, installUpdate })} />)
    await waitFor(() => { expect(installUpdate).toHaveBeenCalledOnce() }, { timeout: 1_500 })
  })

  it('offers immediate installation for a cached, verified package', async () => {
    const installUpdate = vi.fn(async () => {})
    render(<ProductStatus {...props({
      ...available,
      revision: 5,
      phase: 'ready',
      downloadedBytes: 80 * 1024 * 1024,
      percent: 100,
    }, { installUpdate })} />)

    fireEvent.click(await screen.findByRole('button', { name: '立即安装并重启' }))
    await waitFor(() => { expect(installUpdate).toHaveBeenCalledOnce() })
    expect(screen.getByText('SHA-512 校验通过')).toBeTruthy()
  })
})
