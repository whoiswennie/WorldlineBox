// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ConversationContextMenu, type ConversationContextMenuLabels,
} from '../src/client/skeleton/ConversationContextMenu.tsx'

const labels: ConversationContextMenuLabels = {
  menu: 'Editing menu',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  delete: 'Delete',
  selectAll: 'Select all',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function installClipboard(value: Partial<Clipboard>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

function selectText(element: HTMLElement, start: number, end: number): void {
  const node = element.firstChild
  if (node === null) throw new Error('text fixture has no child')
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('ConversationContextMenu', () => {
  it('copies a message image as PNG from the shared Web and Electron menu', async () => {
    const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>().mockResolvedValue(undefined)
    const drawImage = vi.fn()
    installClipboard({ write })
    vi.stubGlobal('ClipboardItem', class ClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cG5n')
    render(
      <ConversationContextMenu labels={labels}>
        <img alt="Character" src="data:image/png;base64,iVBORw0KGgo=" />
      </ConversationContextMenu>,
    )
    const image = screen.getByRole('img', { name: 'Character' }) as HTMLImageElement
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 320 },
      naturalHeight: { configurable: true, value: 180 },
    })

    fireEvent.contextMenu(image)
    expect(screen.getAllByRole('menuitem', { name: /^Copy/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy/ }))

    await waitFor(() => { expect(write).toHaveBeenCalledOnce() })
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 320, 180)
    const call = write.mock.calls[0]
    if (call === undefined) throw new Error('clipboard write was not called')
    const item = call[0][0] as unknown as { items: Record<string, Blob> }
    expect(item.items['image/png']).toBeInstanceOf(Blob)
  })

  it('copies an ordinary transcript selection and disables editing-only actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard({ writeText })
    render(
      <ConversationContextMenu labels={labels}>
        <p data-testid="message">selected transcript</p>
      </ConversationContextMenu>,
    )
    const message = screen.getByTestId('message')
    selectText(message, 0, 8)

    fireEvent.contextMenu(message, { clientX: 24, clientY: 36 })

    expect(screen.getByRole('menu', { name: 'Editing menu' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: /Undo/ }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: /Paste/ }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy/ }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith('selected') })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('cuts a saved textarea selection when the native editing command is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard({ writeText })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    })
    render(
      <ConversationContextMenu labels={labels}>
        <textarea aria-label="Prompt" defaultValue="alpha beta" />
      </ConversationContextMenu>,
    )
    const input = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement
    input.setSelectionRange(0, 5)

    fireEvent.contextMenu(input)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: /Undo/ }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: /Cut/ }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: /Cut/ }))

    await waitFor(() => { expect(input.value).toBe(' beta') })
    expect(writeText).toHaveBeenCalledWith('alpha')
  })

  it('pastes through the async Clipboard API at the captured input range', async () => {
    const readText = vi.fn().mockResolvedValue('worldline')
    installClipboard({ readText })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    })
    render(
      <ConversationContextMenu labels={labels}>
        <input aria-label="Prompt" defaultValue="hello draft" />
      </ConversationContextMenu>,
    )
    const input = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLInputElement
    input.setSelectionRange(6, 11)

    fireEvent.contextMenu(input)
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste/ }))

    await waitFor(() => { expect(input.value).toBe('hello worldline') })
    expect(readText).toHaveBeenCalledOnce()
  })

  it('supports keyboard traversal and Escape dismissal', () => {
    render(
      <ConversationContextMenu labels={labels}>
        <textarea aria-label="Prompt" defaultValue="draft" />
      </ConversationContextMenu>,
    )
    const input = screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement
    input.select()
    fireEvent.contextMenu(input)
    const menu = screen.getByRole('menu')

    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Select all/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
