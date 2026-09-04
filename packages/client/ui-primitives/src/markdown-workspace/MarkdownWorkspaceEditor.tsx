import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import css from './MarkdownWorkspace.module.css'

export interface MarkdownWorkspaceEditorProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onSave: () => void
  readonly ariaLabel?: string | undefined
  readonly className?: string | undefined
}

/** Shared CodeMirror surface used by knowledge pages and Worldline source authoring. */
export function MarkdownWorkspaceEditor({
  value,
  onChange,
  onSave,
  ariaLabel = 'Markdown 编辑器',
  className,
}: MarkdownWorkspaceEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const change = useRef(onChange)
  const save = useRef(onSave)
  change.current = onChange
  save.current = onSave

  useEffect(() => {
    if (host.current === null) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          highlightActiveLine(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([{
            key: 'Mod-s',
            preventDefault: true,
            run: () => { save.current(); return true },
          }, indentWithTab, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString())
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: 'ui-monospace,SFMono-Regular,Cascadia Code,Consolas,monospace',
            },
            '.cm-content': { padding: '18px 0 48px' },
            '.cm-line': { padding: '0 18px' },
            '.cm-gutters': {
              backgroundColor: 'color-mix(in srgb, var(--worldline-surface, #fff) 84%, #edf4f8)',
              color: 'var(--worldline-muted, #8b98a6)',
              border: 'none',
              borderRight: '1px solid var(--worldline-border, #e7edf2)',
            },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
    })
    view.current = editor
    return () => { editor.destroy(); view.current = null }
  }, [ariaLabel])

  useEffect(() => {
    const editor = view.current
    if (editor === null || editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className={[css.editor, className].filter(Boolean).join(' ')} />
}
