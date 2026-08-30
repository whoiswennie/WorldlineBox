// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SessionId, WorkspaceTreePreview } from '@deepseek-ai/dsh-client-runtime/client'
import { WorkspaceEditor, workspaceEditor } from '../src/client/WorkspaceEditor.tsx'

const sid = (value: string) => value as SessionId
const preview = (path: string, content: string): WorkspaceTreePreview => ({
  path,
  name: path.replace(/^.*[\\/]/, ''),
  size: content.length,
  modifiedAt: Date.now(),
  kind: 'text',
  mimeType: 'text/plain',
  encoding: 'utf8',
  content,
  tooLarge: false,
})

function props(sessionId: SessionId) {
  return {
    sessionId,
    useSessions: (selector: (state: unknown) => unknown) => selector({
      byId: { [sessionId]: { cwd: 'C:\\workspace' } },
    }),
    previewFile: vi.fn(),
    openPath: vi.fn(),
    subscribeChanges: vi.fn(() => () => undefined),
  } as ComponentProps<typeof WorkspaceEditor>
}

afterEach(() => {
  cleanup()
  workspaceEditor.configure(undefined)
  vi.useRealTimers()
})

describe('central workspace editor', () => {
  it('keeps several files in central tabs and closes them independently', () => {
    const sessionId = sid('workspace-tabs')
    workspaceEditor.open(sessionId, preview('C:\\workspace\\one.txt', 'one'))
    workspaceEditor.open(sessionId, preview('C:\\workspace\\two.txt', 'two'))
    render(<WorkspaceEditor {...props(sessionId)} />)

    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('two')
    fireEvent.click(screen.getByRole('tab', { name: /one\.txt/ }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('one')
    fireEvent.click(screen.getByRole('button', { name: '关闭 one.txt' }))
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('two')
  })

  it('autosaves edits and supports undo and redo without a save-mode button', async () => {
    vi.useFakeTimers()
    const sessionId = sid('workspace-autosave')
    const mutate = vi.fn(async () => ({ path: 'C:\\workspace\\notes.txt' }))
    workspaceEditor.configure(mutate)
    workspaceEditor.open(sessionId, preview('C:\\workspace\\notes.txt', 'before'))
    render(<WorkspaceEditor {...props(sessionId)} />)

    const editor = screen.getByRole('textbox')
    fireEvent.change(editor, { target: { value: 'after' } })
    expect((editor as HTMLTextAreaElement).value).toBe('after')
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }))
    expect((editor as HTMLTextAreaElement).value).toBe('before')
    fireEvent.click(screen.getByRole('button', { name: /重做/ }))
    expect((editor as HTMLTextAreaElement).value).toBe('after')

    await act(async () => { await vi.advanceTimersByTimeAsync(750) })
    expect(mutate).toHaveBeenCalledWith({
      operation: 'write', path: 'C:\\workspace\\notes.txt', content: 'after',
    })
    expect(screen.queryByRole('button', { name: /^保存$/ })).toBeNull()
  })

  it('renders Markdown in edit, preview, and live split modes', () => {
    const sessionId = sid('workspace-markdown-modes')
    workspaceEditor.open(sessionId, preview('C:\\workspace\\guide.md', '# First'))
    render(<WorkspaceEditor {...props(sessionId)} />)

    const modeGroup = screen.getByRole('group', { name: 'Markdown 视图模式' })
    expect(modeGroup).toBeTruthy()
    expect(screen.getByRole('button', { name: '编辑' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'First' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# Updated' } })
    fireEvent.click(screen.getByRole('button', { name: '分屏' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Updated' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '渲染' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Updated' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Updated' })).toBeNull()
  })

  it('keeps ordinary text files in edit-only mode', () => {
    const sessionId = sid('workspace-plain-text-mode')
    workspaceEditor.open(sessionId, preview('C:\\workspace\\notes.txt', '# literal'))
    render(<WorkspaceEditor {...props(sessionId)} />)

    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Markdown 视图模式' })).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('previews image media in the same central surface', () => {
    const sessionId = sid('workspace-media')
    workspaceEditor.open(sessionId, {
      path: 'C:\\workspace\\image.png', name: 'image.png', size: 3, modifiedAt: Date.now(),
      kind: 'image', mimeType: 'image/png', encoding: 'base64', content: 'AAAA', tooLarge: false,
    })
    render(<WorkspaceEditor {...props(sessionId)} />)
    expect(screen.getByRole('img', { name: 'image.png' }).getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('closes every open workspace document after the workspace is cleared', () => {
    const sessionId = sid('workspace-clear-tabs')
    workspaceEditor.open(sessionId, preview('C:\\workspace\\one.txt', 'one'))
    workspaceEditor.open(sessionId, preview('C:\\workspace\\nested\\two.txt', 'two'))
    render(<WorkspaceEditor {...props(sessionId)} />)

    expect(screen.getAllByRole('tab')).toHaveLength(2)
    act(() => { workspaceEditor.applyMutation({ operation: 'clear-workspace', path: 'C:\\workspace' }) })
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('previews audio and video and explains unsupported binary files', () => {
    const sessionId = sid('workspace-other-media')
    workspaceEditor.open(sessionId, {
      path: 'C:\\workspace\\sound.mp3', name: 'sound.mp3', size: 3, modifiedAt: Date.now(),
      kind: 'audio', mimeType: 'audio/mpeg', encoding: 'base64', content: 'AAAA', tooLarge: false,
    })
    workspaceEditor.open(sessionId, {
      path: 'C:\\workspace\\movie.mp4', name: 'movie.mp4', size: 3, modifiedAt: Date.now(),
      kind: 'video', mimeType: 'video/mp4', encoding: 'base64', content: 'BBBB', tooLarge: false,
    })
    workspaceEditor.open(sessionId, {
      path: 'C:\\workspace\\archive.zip', name: 'archive.zip', size: 3, modifiedAt: Date.now(),
      kind: 'binary', mimeType: 'application/zip', tooLarge: false,
    })
    const view = render(<WorkspaceEditor {...props(sessionId)} />)

    expect(screen.getByText('无法预览此二进制文件')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /sound\.mp3/ }))
    expect(view.container.querySelector('audio')?.getAttribute('src')).toBe('data:audio/mpeg;base64,AAAA')
    fireEvent.click(screen.getByRole('tab', { name: /movie\.mp4/ }))
    expect(view.container.querySelector('video')?.getAttribute('src')).toBe('data:video/mp4;base64,BBBB')
  })

  it('uses range-capable stream URLs for movie-sized media', () => {
    const sessionId = sid('workspace-streamed-movie')
    workspaceEditor.open(sessionId, {
      path: 'C:\\workspace\\movie.mp4', name: 'movie.mp4', size: 8_000_000_000,
      modifiedAt: Date.now(), kind: 'video', mimeType: 'video/mp4', tooLarge: false,
      streamUrl: '/api/workspace.media?token=00000000-0000-4000-8000-000000000001',
    })
    const view = render(<WorkspaceEditor {...props(sessionId)} />)
    const video = view.container.querySelector('video')
    expect(video?.getAttribute('src')).toContain('/api/workspace.media?token=')
    expect(video?.getAttribute('preload')).toBe('metadata')
    expect(video?.playsInline).toBe(true)
  })

  it('shows a readable fallback when Chromium cannot decode supported media', () => {
    const sessionId = sid('workspace-media-error')
    workspaceEditor.open(sessionId, {
      path: 'C:\\workspace\\broken.avif', name: 'broken.avif', size: 3, modifiedAt: Date.now(),
      kind: 'image', mimeType: 'image/avif', encoding: 'base64', content: 'AAAA', tooLarge: false,
    })
    render(<WorkspaceEditor {...props(sessionId)} />)
    fireEvent.error(screen.getByRole('img', { name: 'broken.avif' }))
    expect(screen.getByText(/无法解码此图片格式/)).toBeTruthy()
  })
})
