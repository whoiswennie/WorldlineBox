// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceExplorer } from '../src/client/WorkspaceExplorer.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('workspace explorer dialogs', () => {
  it('opens the selected workspace directory from the toolbar', async () => {
    const sessionId = 'open-directory-session' as SessionId
    const openPath = vi.fn(async () => {})
    render(<WorkspaceExplorer {...({
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      listDirectory: vi.fn(async () => ({ path: 'C:\\workspace', truncated: false, entries: [] })),
      searchFiles: vi.fn(), previewFile: vi.fn(), mutate: vi.fn(), openPath,
      openInBrowser: vi.fn(), selectView: vi.fn(), close: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as ComponentProps<typeof WorkspaceExplorer>)} />)

    fireEvent.click(screen.getByRole('button', { name: '在文件资源管理器中打开工作区' }))
    await waitFor(() => { expect(openPath).toHaveBeenCalledWith('C:\\workspace') })
  })

  it('renders folders and familiar file types with semantic SVG icons', async () => {
    const sessionId = 'icons-session' as SessionId
    render(<WorkspaceExplorer {...({
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      listDirectory: vi.fn(async () => ({
        path: 'C:\\workspace', truncated: false,
        entries: [
          { path: 'C:\\workspace\\assets', name: 'assets', kind: 'directory', hidden: false },
          ...[
            'photo.png', 'song.mp3', 'clip.mp4', 'notes.txt', 'README', 'app.tsx', '.env',
            'bundle.zip', 'guide.pdf', 'letter.docx', 'table.xlsx', 'slides.pptx', 'unknown.bin',
          ].map(name => ({ path: `C:\\workspace\\${name}`, name, kind: 'file', hidden: false })),
        ],
      })),
      searchFiles: vi.fn(), previewFile: vi.fn(), mutate: vi.fn(), openPath: vi.fn(), selectView: vi.fn(), close: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as ComponentProps<typeof WorkspaceExplorer>)} />)

    expect(await screen.findByRole('button', { name: 'assets' })).toBeTruthy()
    const expectedKinds = ['image', 'audio', 'video', 'text', 'text', 'code', 'data', 'archive', 'pdf', 'document', 'spreadsheet', 'presentation', 'file']
    for (const [index, name] of ['photo.png', 'song.mp3', 'clip.mp4', 'notes.txt', 'README', 'app.tsx', '.env', 'bundle.zip', 'guide.pdf', 'letter.docx', 'table.xlsx', 'slides.pptx', 'unknown.bin'].entries()) {
      const row = screen.getByRole('button', { name })
      expect(row.querySelector(`[data-kind="${expectedKinds[index]}"] svg`)).toBeTruthy()
    }
  })

  it('renders workspace contents directly without a duplicate root folder row', async () => {
    const sessionId = 'tree-session' as SessionId
    render(<WorkspaceExplorer {...({
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      listDirectory: vi.fn(async () => ({
        path: 'C:\\workspace', truncated: false,
        entries: [{ path: 'C:\\workspace\\1', name: '1', kind: 'directory', hidden: false }],
      })),
      searchFiles: vi.fn(), previewFile: vi.fn(), mutate: vi.fn(), openPath: vi.fn(), selectView: vi.fn(), close: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as ComponentProps<typeof WorkspaceExplorer>)} />)

    expect(await screen.findByRole('button', { name: '1' })).toBeTruthy()
    expect(screen.queryByText('workspace', { exact: true })).toBeNull()
  })

  it('uses an in-app non-blocking confirmation for destructive mutations', async () => {
    const sessionId = 'session' as SessionId
    const nativeConfirm = vi.spyOn(window, 'confirm')
    const mutate = vi.fn(async () => ({}))
    render(<WorkspaceExplorer {...({
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      listDirectory: vi.fn(async () => ({
        path: 'C:\\workspace', truncated: false,
        entries: [{ path: 'C:\\workspace\\one.txt', name: 'one.txt', kind: 'file', hidden: false }],
      })),
      searchFiles: vi.fn(), previewFile: vi.fn(), mutate, openPath: vi.fn(), selectView: vi.fn(), close: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as ComponentProps<typeof WorkspaceExplorer>)} />)

    const file = await screen.findByRole('button', { name: /one\.txt/ })
    fireEvent.contextMenu(file)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith({ operation: 'delete', path: 'C:\\workspace\\one.txt' }) })
  })

  it('replaces manual refresh with a confirmed clear-workspace action', async () => {
    const sessionId = 'clear-session' as SessionId
    const nativeConfirm = vi.spyOn(window, 'confirm')
    const mutate = vi.fn(async () => ({}))
    render(<WorkspaceExplorer {...({
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      listDirectory: vi.fn(async () => ({ path: 'C:\\workspace', truncated: false, entries: [] })),
      searchFiles: vi.fn(), previewFile: vi.fn(), mutate, openPath: vi.fn(), selectView: vi.fn(), close: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as ComponentProps<typeof WorkspaceExplorer>)} />)

    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '清空工作区' }))
    expect(screen.getByRole('alertdialog').textContent).toContain('所有文件、文件夹和隐藏项目都会被永久删除')
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    await waitFor(() => { expect(mutate).toHaveBeenCalledWith({ operation: 'clear-workspace', path: 'C:\\workspace' }) })
  })

  it('offers HTML files in the embedded browser while keeping other files out of that action', async () => {
    const sessionId = 'html-session' as SessionId
    const openInBrowser = vi.fn(async () => {})
    render(<WorkspaceExplorer {...({
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      listDirectory: vi.fn(async () => ({
        path: 'C:\\workspace', truncated: false,
        entries: [
          { path: 'C:\\workspace\\demo.html', name: 'demo.html', kind: 'file', hidden: false },
          { path: 'C:\\workspace\\notes.txt', name: 'notes.txt', kind: 'file', hidden: false },
        ],
      })),
      searchFiles: vi.fn(), previewFile: vi.fn(), mutate: vi.fn(), openPath: vi.fn(), openInBrowser, selectView: vi.fn(), close: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as ComponentProps<typeof WorkspaceExplorer>)} />)

    fireEvent.contextMenu(await screen.findByRole('button', { name: 'demo.html' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在内置浏览器中打开' }))
    await waitFor(() => {
      expect(openInBrowser).toHaveBeenCalledWith(sessionId, 'C:\\workspace', 'C:\\workspace\\demo.html')
    })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'notes.txt' }))
    expect(screen.queryByRole('menuitem', { name: '在内置浏览器中打开' })).toBeNull()
  })

  it('searches the whole workspace and opens a ranked result in the editor', async () => {
    const sessionId = 'search-session' as SessionId
    const previewFile = vi.fn(async () => ({
      path: 'C:\\workspace\\src\\main.ts', name: 'main.ts', size: 12, modifiedAt: 1,
      kind: 'text' as const, mimeType: 'text/plain', encoding: 'utf8' as const,
      content: 'export {}', tooLarge: false,
    }))
    const searchFiles = vi.fn(async () => ({
      query: 'main', scanned: 38, truncated: false,
      results: [{
        path: 'C:\\workspace\\src\\main.ts', relativePath: 'src/main.ts', name: 'main.ts',
        size: 12, modifiedAt: 1,
      }],
    }))
    const selectView = vi.fn()
    render(<WorkspaceExplorer {...({
      useSessions: (selector: (state: unknown) => unknown) => selector({
        current: sessionId,
        byId: { [sessionId]: { cwd: 'C:\\workspace' } },
      }),
      listDirectory: vi.fn(async () => ({ path: 'C:\\workspace', truncated: false, entries: [] })),
      searchFiles, previewFile, mutate: vi.fn(), openPath: vi.fn(), selectView, close: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as ComponentProps<typeof WorkspaceExplorer>)} />)

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索工作区文件' }), {
      target: { value: 'main' },
    })
    const result = await screen.findByRole('button', { name: /main\.ts.*src\/main\.ts/ })
    expect(searchFiles).toHaveBeenCalledWith('C:\\workspace', 'main', expect.any(AbortSignal))
    expect(screen.getByText(/已扫描 38 项/)).toBeTruthy()
    fireEvent.click(result)
    await waitFor(() => {
      expect(previewFile).toHaveBeenCalledWith('C:\\workspace\\src\\main.ts', expect.any(AbortSignal))
      expect(selectView).toHaveBeenCalledWith(sessionId, 'workspace')
    })
  })
})
