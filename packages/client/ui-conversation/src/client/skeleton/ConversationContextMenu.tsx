import {
  useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ConversationContextMenu.module.css'

type TextControl = HTMLInputElement | HTMLTextAreaElement
type EditableTarget = TextControl | HTMLElement
type MenuAction = 'copyImage' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'

export interface ConversationContextMenuLabels {
  readonly menu: string
  readonly undo: string
  readonly redo: string
  readonly cut: string
  readonly copy: string
  readonly paste: string
  readonly delete: string
  readonly selectAll: string
}

interface SelectionSnapshot {
  readonly target?: EditableTarget
  readonly text: string
  readonly start?: number
  readonly end?: number
  readonly range?: Range
}

interface MenuState {
  readonly x: number
  readonly y: number
  readonly selection: SelectionSnapshot
  readonly image?: HTMLImageElement
}

interface MenuItem {
  readonly action: MenuAction
  readonly label: string
  readonly shortcut?: string
  readonly enabled: boolean
  readonly dividerBefore?: boolean
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password'])

function textControl(element: Element | null): TextControl | undefined {
  if (element instanceof HTMLTextAreaElement) return element
  if (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)) return element
  return undefined
}

function editableTarget(element: Element | null): EditableTarget | undefined {
  const control = textControl(element)
  if (control !== undefined && !control.disabled && !control.readOnly) return control
  const editable = element?.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])')
  return editable?.getAttribute('contenteditable') === 'true' || editable?.getAttribute('contenteditable') === ''
    ? editable
    : undefined
}

function containsNode(container: Node, node: Node | null): boolean {
  return node !== null && (container === node || container.contains(node))
}

function captureSelection(scope: HTMLElement, origin: Element | null): SelectionSnapshot {
  const target = editableTarget(origin)
  const control = textControl(target ?? null)
  if (control !== undefined) {
    const start = control.selectionStart ?? 0
    const end = control.selectionEnd ?? start
    return { target: control, text: control.value.slice(start, end), start, end }
  }

  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) {
    return { ...(target === undefined ? {} : { target }), text: '' }
  }
  const range = selection.getRangeAt(0)
  const selectionRoot = target ?? scope
  if (!containsNode(selectionRoot, range.commonAncestorContainer)) {
    return { ...(target === undefined ? {} : { target }), text: '' }
  }
  return {
    ...(target === undefined ? {} : { target }),
    text: selection.toString(),
    range: range.cloneRange(),
  }
}

function dispatchInput(target: EditableTarget, inputType: string, data: string | null = null): void {
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }))
}

function replaceSnapshot(selection: SelectionSnapshot, text: string, inputType: string): void {
  const control = textControl(selection.target ?? null)
  if (control !== undefined && selection.start !== undefined && selection.end !== undefined) {
    control.setRangeText(text, selection.start, selection.end, 'end')
    dispatchInput(control, inputType, text)
    return
  }
  if (selection.target === undefined || selection.range === undefined) return
  const range = selection.range
  range.deleteContents()
  if (text !== '') {
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
  }
  range.collapse(true)
  const activeSelection = window.getSelection()
  activeSelection?.removeAllRanges()
  activeSelection?.addRange(range)
  dispatchInput(selection.target, inputType, text)
}

function runEditingCommand(command: string): boolean {
  /* oxlint-disable-next-line typescript/no-deprecated */
  if (typeof document.execCommand !== 'function') return false
  try {
    /* oxlint-disable-next-line typescript/no-deprecated */
    return document.execCommand(command)
  } catch {
    return false
  }
}

function selectAll(scope: HTMLElement, selection: SelectionSnapshot): void {
  const control = textControl(selection.target ?? null)
  if (control !== undefined) {
    control.select()
    return
  }
  const range = document.createRange()
  range.selectNodeContents(selection.target ?? scope)
  const activeSelection = window.getSelection()
  activeSelection?.removeAllRanges()
  activeSelection?.addRange(range)
}

async function copyImage(image: HTMLImageElement): Promise<void> {
  const clipboard = (navigator as unknown as {
    readonly clipboard?: { write?: (items: ClipboardItem[]) => Promise<void> }
  }).clipboard
  if (clipboard?.write === undefined || typeof ClipboardItem !== 'function') return
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width === 0 || height === 0) return

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) return

  try {
    context.drawImage(image, 0, 0, width, height)
    // Encode synchronously so clipboard.write() is called inside the original
    // menu-click activation. Waiting for canvas.toBlob() first can lose that
    // activation in Chromium even though the image conversion succeeds.
    const dataUrl = canvas.toDataURL('image/png')
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    await clipboard.write([new ClipboardItem({
      'image/png': new Blob([bytes], { type: 'image/png' }),
    })])
  } catch {
    // A tainted canvas or denied clipboard permission leaves the clipboard untouched.
  }
}

async function executeAction(
  action: MenuAction,
  scope: HTMLElement,
  selection: SelectionSnapshot,
  image?: HTMLImageElement,
): Promise<void> {
  selection.target?.focus()
  switch (action) {
    case 'copyImage':
      if (image !== undefined) await copyImage(image)
      return
    case 'undo':
    case 'redo':
      runEditingCommand(action)
      return
    case 'copy':
      if (selection.text !== '') await writeClipboard(selection.text)
      return
    case 'cut':
      if (selection.text === '') return
      if (runEditingCommand('cut')) return
      if (await writeClipboard(selection.text)) replaceSnapshot(selection, '', 'deleteByCut')
      return
    case 'paste': {
      if (runEditingCommand('paste')) return
      const clipboard = (navigator as unknown as {
        readonly clipboard?: { readText?: () => Promise<string> }
      }).clipboard
      if (clipboard?.readText === undefined) return
      try {
        replaceSnapshot(selection, await clipboard.readText(), 'insertFromPaste')
      } catch {
        // A denied clipboard permission leaves the document untouched.
      }
      return
    }
    case 'delete':
      replaceSnapshot(selection, '', 'deleteContent')
      return
    case 'selectAll':
      selectAll(scope, selection)
  }
}

function keyboardShortcut(letter: string): string {
  return `${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}${letter}`
}

export interface ConversationContextMenuProps {
  readonly children: ReactNode
  readonly labels: ConversationContextMenuLabels
}

/** Adds one selection-aware editing menu to the complete conversation surface. */
export function ConversationContextMenu({ children, labels }: ConversationContextMenuProps) {
  const scopeRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<MenuState>()

  const close = useCallback(() => { setMenu(undefined) }, [])

  useEffect(() => {
    if (menu === undefined) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containsNode(menuRef.current ?? document.body, event.target as Node | null)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [close, menu])

  useEffect(() => {
    if (menu === undefined) return
    const frame = requestAnimationFrame(() => {
      const element = menuRef.current
      if (element === null) return
      const bounds = element.getBoundingClientRect()
      const x = Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))
      const y = Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))
      element.style.left = `${x}px`
      element.style.top = `${y}px`
      element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [menu])

  const items: readonly MenuItem[] = menu === undefined ? [] : [
    { action: 'undo', label: labels.undo, shortcut: keyboardShortcut('Z'), enabled: menu.selection.target !== undefined },
    { action: 'redo', label: labels.redo, shortcut: keyboardShortcut('Y'), enabled: menu.selection.target !== undefined },
    { action: 'cut', label: labels.cut, shortcut: keyboardShortcut('X'), enabled: menu.selection.target !== undefined && menu.selection.text !== '', dividerBefore: true },
    {
      action: menu.image === undefined ? 'copy' : 'copyImage',
      label: labels.copy,
      shortcut: keyboardShortcut('C'),
      enabled: menu.image !== undefined || menu.selection.text !== '',
    },
    { action: 'paste', label: labels.paste, shortcut: keyboardShortcut('V'), enabled: menu.selection.target !== undefined },
    { action: 'delete', label: labels.delete, enabled: menu.selection.target !== undefined && menu.selection.text !== '' },
    { action: 'selectAll', label: labels.selectAll, shortcut: keyboardShortcut('A'), enabled: true, dividerBefore: true },
  ]

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % buttons.length
          : (current - 1 + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  return (
    <div className={css.scope}>
      <div
        ref={scopeRef}
        className={css.scope}
        onContextMenu={(event) => {
          event.preventDefault()
          const origin = event.target as Element | null
          const image = origin?.closest<HTMLImageElement>('img')
          setMenu({
            x: event.clientX,
            y: event.clientY,
            selection: captureSelection(scopeRef.current ?? event.currentTarget, origin),
            ...(image === undefined || image === null ? {} : { image }),
          })
        }}
      >
        {children}
      </div>
      {menu !== undefined && (
        <div
          ref={menuRef}
          className={css.menu}
          role="menu"
          aria-label={labels.menu}
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => { event.preventDefault() }}
          onKeyDown={onMenuKeyDown}
        >
          {items.map(item => (
            <div key={item.action} className={item.dividerBefore ? css.divider : undefined}>
              <button
                type="button"
                className={css.item}
                role="menuitem"
                disabled={!item.enabled}
                onClick={() => {
                  close()
                  const scope = scopeRef.current
                  if (scope !== null) void executeAction(item.action, scope, menu.selection, menu.image)
                }}
              >
                <span>{item.label}</span>
                {item.shortcut !== undefined && <kbd>{item.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
