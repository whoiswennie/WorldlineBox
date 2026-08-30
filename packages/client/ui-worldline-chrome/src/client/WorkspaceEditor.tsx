import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId, WorkspaceTreeMutation, WorkspaceTreePreview } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCloseOutline16, IconCodeOutline16, IconFolderOpenOutline16, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './WorkspaceEditor.module.css'

type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error'
type MarkdownViewMode = 'edit' | 'preview' | 'split'

interface OpenDocument {
  preview: WorkspaceTreePreview
  content: string
  savedContent: string
  history: readonly string[]
  historyIndex: number
  lastEditAt: number
  status: SaveStatus
  viewMode: MarkdownViewMode
  error?: string | undefined
}

interface EditorSession {
  documents: readonly OpenDocument[]
  activePath?: string
}

interface EditorState { sessions: Readonly<Record<string, EditorSession>> }
type Writer = (mutation: WorkspaceTreeMutation) => Promise<{ path?: string }>

const EMPTY_SESSION: EditorSession = { documents: [] }
const normalized = (path: string): string => path.replace(/\\/g, '/').toLowerCase()
const samePath = (left: string, right: string): boolean => normalized(left) === normalized(right)
const fileName = (path: string): string => path.replace(/[\\/]$/, '').replace(/^.*[\\/]/, '')
const isMarkdown = (preview: WorkspaceTreePreview): boolean => preview.kind === 'text'
  && (preview.mimeType === 'text/markdown' || /\.(?:md|markdown|mdown|mkd|mkdn)$/i.test(preview.name))
const defaultViewMode = (_preview: WorkspaceTreePreview): MarkdownViewMode => (
  'edit'
)

class WorkspaceEditorStore {
  private state: EditorState = { sessions: {} }
  private readonly listeners = new Set<() => void>()
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private writer: Writer | undefined

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  configure(writer: Writer | undefined): void { this.writer = writer }
  session(sessionId: SessionId): EditorSession { return this.state.sessions[sessionId] ?? EMPTY_SESSION }

  open(sessionId: SessionId, preview: WorkspaceTreePreview): void {
    const session = this.session(sessionId)
    const index = session.documents.findIndex(document => samePath(document.preview.path, preview.path))
    const documents = [...session.documents]
    if (index < 0) {
      const content = preview.kind === 'text' ? preview.content ?? '' : ''
      documents.push({
        preview, content, savedContent: content, history: [content], historyIndex: 0,
        lastEditAt: 0, status: 'saved', viewMode: defaultViewMode(preview),
      })
    } else if (documents[index]?.status === 'saved') {
      const content = preview.kind === 'text' ? preview.content ?? '' : ''
      documents[index] = {
        preview, content, savedContent: content, history: [content], historyIndex: 0,
        lastEditAt: 0, status: 'saved',
        viewMode: documents[index].viewMode,
      }
    }
    this.replaceSession(sessionId, { documents, activePath: preview.path })
  }

  activate(sessionId: SessionId, path: string): void {
    const session = this.session(sessionId)
    if (!session.documents.some(document => samePath(document.preview.path, path))) return
    this.replaceSession(sessionId, { ...session, activePath: path })
  }

  close(sessionId: SessionId, path: string, save = true): void {
    const session = this.session(sessionId)
    const index = session.documents.findIndex(document => samePath(document.preview.path, path))
    if (index < 0) return
    const document = session.documents[index]
    if (save && (document?.status === 'dirty' || document?.status === 'error')) void this.saveNow(sessionId, path)
    else this.clearSaveTimer(sessionId, path)
    const documents = session.documents.filter(item => !samePath(item.preview.path, path))
    const activePath = samePath(session.activePath ?? '', path)
      ? documents[Math.min(index, Math.max(0, documents.length - 1))]?.preview.path
      : session.activePath
    this.replaceSession(sessionId, { documents, ...(activePath === undefined ? {} : { activePath }) })
  }

  edit(sessionId: SessionId, path: string, content: string): void {
    const now = Date.now()
    this.updateDocument(sessionId, path, (document) => {
      const base = document.history.slice(0, document.historyIndex + 1)
      const grouped = now - document.lastEditAt < 550 && document.historyIndex > 0
      const history = grouped ? [...base.slice(0, -1), content] : [...base, content]
      return {
        ...document, content, history, historyIndex: history.length - 1, lastEditAt: now,
        status: content === document.savedContent ? 'saved' : 'dirty', error: undefined,
      }
    })
    this.scheduleSave(sessionId, path)
  }

  undo(sessionId: SessionId, path: string): void {
    this.moveHistory(sessionId, path, -1)
  }

  redo(sessionId: SessionId, path: string): void {
    this.moveHistory(sessionId, path, 1)
  }

  setViewMode(sessionId: SessionId, path: string, viewMode: MarkdownViewMode): void {
    this.updateDocument(sessionId, path, document => isMarkdown(document.preview)
      ? { ...document, viewMode }
      : document)
  }

  async saveNow(sessionId: SessionId, path: string): Promise<void> {
    this.clearSaveTimer(sessionId, path)
    const document = this.document(sessionId, path)
    if (document === undefined || document.preview.kind !== 'text' || document.content === document.savedContent) return
    const writer = this.writer
    if (writer === undefined) return
    const content = document.content
    this.updateDocument(sessionId, path, current => ({ ...current, status: 'saving', error: undefined }))
    try {
      await writer({ operation: 'write', path, content })
      this.updateDocument(sessionId, path, current => ({
        ...current,
        savedContent: content,
        preview: { ...current.preview, content: current.content, size: current.content.length, modifiedAt: Date.now() },
        status: current.content === content ? 'saved' : 'dirty',
        error: undefined,
      }))
      if (this.document(sessionId, path)?.status === 'dirty') this.scheduleSave(sessionId, path)
    } catch (reason) {
      this.updateDocument(sessionId, path, current => ({
        ...current, status: 'error', error: reason instanceof Error ? reason.message : String(reason),
      }))
    }
  }

  refreshPreview(sessionId: SessionId, preview: WorkspaceTreePreview): void {
    this.updateDocument(sessionId, preview.path, (document) => {
      if (document.status !== 'saved') return document
      const content = preview.kind === 'text' ? preview.content ?? '' : ''
      return {
        preview, content, savedContent: content, history: [content], historyIndex: 0,
        lastEditAt: 0, status: 'saved', viewMode: document.viewMode,
      }
    })
  }

  applyMutation(mutation: WorkspaceTreeMutation, resultPath?: string): void {
    for (const sessionId of Object.keys(this.state.sessions)) {
      if (mutation.operation === 'delete' || mutation.operation === 'clear-workspace') {
        const source = normalized(mutation.path)
        for (const document of [...this.session(sessionId as SessionId).documents]) {
          const candidate = normalized(document.preview.path)
          if (candidate === source || candidate.startsWith(`${source}/`)) this.close(sessionId as SessionId, document.preview.path, false)
        }
      }
      if ((mutation.operation === 'rename' || mutation.operation === 'move') && resultPath !== undefined) {
        this.rebasePath(sessionId as SessionId, mutation.path, resultPath)
      }
    }
  }

  private moveHistory(sessionId: SessionId, path: string, delta: -1 | 1): void {
    const current = this.document(sessionId, path)
    if (current === undefined) return
    const historyIndex = current.historyIndex + delta
    if (historyIndex < 0 || historyIndex >= current.history.length) return
    this.updateDocument(sessionId, path, (document) => {
      const content = document.history[historyIndex] ?? ''
      return {
        ...document, content, historyIndex, lastEditAt: 0,
        status: content === document.savedContent ? 'saved' : 'dirty', error: undefined,
      }
    })
    this.scheduleSave(sessionId, path)
  }

  private rebasePath(sessionId: SessionId, sourcePath: string, targetPath: string): void {
    const session = this.session(sessionId)
    const source = normalized(sourcePath)
    const rebased: OpenDocument[] = []
    const documents = session.documents.map((document) => {
      const candidate = normalized(document.preview.path)
      if (candidate !== source && !candidate.startsWith(`${source}/`)) return document
      const suffix = document.preview.path.slice(sourcePath.length)
      const path = `${targetPath}${suffix}`
      this.clearSaveTimer(sessionId, document.preview.path)
      const next = { ...document, preview: { ...document.preview, path, name: fileName(path) } }
      rebased.push(next)
      return next
    })
    if (rebased.length === 0) return
    const activePath = session.activePath === undefined ? undefined
      : samePath(session.activePath, sourcePath) || normalized(session.activePath).startsWith(`${source}/`)
        ? `${targetPath}${session.activePath.slice(sourcePath.length)}` : session.activePath
    this.replaceSession(sessionId, { documents, ...(activePath === undefined ? {} : { activePath }) })
    for (const document of rebased) {
      if (document.status === 'dirty' || document.status === 'error') this.scheduleSave(sessionId, document.preview.path)
    }
  }

  private document(sessionId: SessionId, path: string): OpenDocument | undefined {
    return this.session(sessionId).documents.find(document => samePath(document.preview.path, path))
  }

  private updateDocument(sessionId: SessionId, path: string, update: (document: OpenDocument) => OpenDocument): void {
    const session = this.session(sessionId)
    const documents = session.documents.map((document) => {
      if (!samePath(document.preview.path, path)) return document
      const next = update(document)
      return next
    })
    const changed = documents.some((document, index) => document !== session.documents[index])
    if (changed) this.replaceSession(sessionId, { ...session, documents })
  }

  private scheduleSave(sessionId: SessionId, path: string): void {
    this.clearSaveTimer(sessionId, path)
    const key = `${sessionId}\n${normalized(path)}`
    this.saveTimers.set(key, setTimeout(() => {
      this.saveTimers.delete(key)
      void this.saveNow(sessionId, path)
    }, 750))
  }

  private clearSaveTimer(sessionId: SessionId, path: string): void {
    const key = `${sessionId}\n${normalized(path)}`
    const timer = this.saveTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.saveTimers.delete(key)
  }

  private replaceSession(sessionId: SessionId, session: EditorSession): void {
    this.state = { sessions: { ...this.state.sessions, [sessionId]: session } }
    for (const listener of this.listeners) listener()
  }
}

export const workspaceEditor = new WorkspaceEditorStore()

interface Injected {
  previewFile: (path: string, signal: AbortSignal) => Promise<WorkspaceTreePreview>
  openPath: (path: string) => Promise<void>
  subscribeChanges: (listener: (root: string) => void) => () => void
}
type Props = ConvViewProps & InjectFace<Injected>

function statusLabel(document: OpenDocument): string {
  if (document.status === 'saving') return '正在自动保存…'
  if (document.status === 'dirty') return '等待自动保存'
  if (document.status === 'error') return '自动保存失败'
  return '已自动保存'
}

function CodeEditorSurface({ sessionId, document }: { sessionId: SessionId; document: OpenDocument }) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const lineNumbers = useRef<HTMLDivElement>(null)
  const lines = Math.max(1, document.content.split('\n').length)
  return <div className={css.codeSurface}>
    <div ref={lineNumbers} className={css.lineNumbers} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}
    </div>
    <textarea
      ref={textarea}
      aria-label={`编辑 ${document.preview.name}`}
      value={document.content}
      spellCheck={false}
      onChange={(event) => { workspaceEditor.edit(sessionId, document.preview.path, event.target.value) }}
      onScroll={(event) => { if (lineNumbers.current !== null) lineNumbers.current.scrollTop = event.currentTarget.scrollTop }}
      onKeyDown={(event) => {
        const command = event.ctrlKey || event.metaKey
        if (command && event.key.toLowerCase() === 's') {
          event.preventDefault(); void workspaceEditor.saveNow(sessionId, document.preview.path); return
        }
        if (command && event.key.toLowerCase() === 'z') {
          event.preventDefault()
          if (event.shiftKey) workspaceEditor.redo(sessionId, document.preview.path)
          else workspaceEditor.undo(sessionId, document.preview.path)
          return
        }
        if (command && event.key.toLowerCase() === 'y') {
          event.preventDefault(); workspaceEditor.redo(sessionId, document.preview.path); return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          const target = event.currentTarget
          const start = target.selectionStart
          const end = target.selectionEnd
          workspaceEditor.edit(sessionId, document.preview.path, `${document.content.slice(0, start)}  ${document.content.slice(end)}`)
          requestAnimationFrame(() => { textarea.current?.setSelectionRange(start + 2, start + 2) })
        }
      }}
    />
  </div>
}

function MarkdownPreview({ content }: { content: string }) {
  return <div className={css.markdownPreview} data-markdown-preview=""><MarkdownText text={content} /></div>
}

function TextEditor({ sessionId, document }: { sessionId: SessionId; document: OpenDocument }) {
  const canUndo = document.historyIndex > 0
  const canRedo = document.historyIndex < document.history.length - 1
  const markdown = isMarkdown(document.preview)
  const mode = markdown ? document.viewMode : 'edit'
  return <div className={css.textWorkbench}>
    <div className={css.editorToolbar}>
      <div className={css.toolbarLeft}>
        <div className={css.editorTools}>
          <button type="button" disabled={!canUndo} title="撤销 (Ctrl+Z)" onClick={() => { workspaceEditor.undo(sessionId, document.preview.path) }}>↶<span>撤销</span></button>
          <button type="button" disabled={!canRedo} title="重做 (Ctrl+Y / Ctrl+Shift+Z)" onClick={() => { workspaceEditor.redo(sessionId, document.preview.path) }}>↷<span>重做</span></button>
        </div>
        {markdown && <div className={css.viewModes} role="group" aria-label="Markdown 视图模式">
          {([['edit', '编辑'], ['preview', '渲染'], ['split', '分屏']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => { workspaceEditor.setViewMode(sessionId, document.preview.path, value) }}
            >{label}</button>
          ))}
        </div>}
      </div>
      <span className={css.saveStatus} data-status={document.status}><i />{statusLabel(document)}</span>
    </div>
    {document.error !== undefined && <div className={css.saveError} role="alert">{document.error}</div>}
    {mode === 'edit' && <CodeEditorSurface sessionId={sessionId} document={document} />}
    {mode === 'preview' && <MarkdownPreview content={document.content} />}
    {mode === 'split' && <div className={css.splitSurface}>
      <CodeEditorSurface sessionId={sessionId} document={document} />
      <MarkdownPreview content={document.content} />
    </div>}
  </div>
}

function MediaPreview({ preview }: { preview: WorkspaceTreePreview }) {
  const [failed, setFailed] = useState(false)
  const src = preview.streamUrl ?? (preview.content === undefined
    ? ''
    : `data:${preview.mimeType};base64,${preview.content}`)
  if (src === '') {
    return <div className={css.unsupported}>预览数据不可用，请在系统中打开此文件。</div>
  }
  if (failed) {
    const kindLabel = preview.kind === 'image' ? '图片' : preview.kind === 'audio' ? '音频' : '视频'
    return <div className={css.unsupported}>{`当前 Chromium 内核无法解码此${kindLabel}格式，请在系统中打开。`}</div>
  }
  if (preview.kind === 'image') return <div className={css.media}><img src={src} alt={preview.name} onError={() => { setFailed(true) }} /></div>
  if (preview.kind === 'audio') return <div className={css.media}><audio
    src={src}
    controls
    preload="metadata"
    onError={() => { setFailed(true) }}
  /></div>
  return <div className={css.media}><video
    src={src}
    controls
    playsInline
    preload="metadata"
    onError={() => { setFailed(true) }}
  /></div>
}

function DocumentBody({ sessionId, document }: { sessionId: SessionId; document: OpenDocument }) {
  const preview = document.preview
  if (preview.tooLarge) return <div className={css.unsupported}>文件超过应用内预览上限，请在系统中打开。</div>
  if (preview.kind === 'text') return <TextEditor sessionId={sessionId} document={document} />
  if (preview.kind === 'image' || preview.kind === 'audio' || preview.kind === 'video') return <MediaPreview key={`${preview.path}:${preview.modifiedAt}`} preview={preview} />
  return <div className={css.unsupported}><strong>无法预览此二进制文件</strong><span>{preview.mimeType || '未知文件类型'} · 请在系统中打开。</span></div>
}

export function WorkspaceEditor({ sessionId, useSessions, previewFile, openPath, subscribeChanges }: Props) {
  const session = useSyncExternalStore(workspaceEditor.subscribe, () => workspaceEditor.session(sessionId))
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const active = session.documents.find(document => samePath(document.preview.path, session.activePath ?? ''))
  const refreshTimer = useRef<number | null>(null)

  useEffect(() => subscribeChanges((root) => {
    if (cwd === undefined || !samePath(root, cwd)) return
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      for (const document of workspaceEditor.session(sessionId).documents) {
        if (document.status !== 'saved') continue
        const abort = new AbortController()
        void previewFile(document.preview.path, abort.signal).then(
          (preview) => { workspaceEditor.refreshPreview(sessionId, preview) },
          () => undefined,
        )
      }
    }, 240)
  }), [cwd, previewFile, sessionId, subscribeChanges])
  useEffect(() => () => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
  }, [])

  return <section className={css.root} data-conversation-composer-overlay="" data-worldline-workspace-editor="">
    <div className={css.tabStrip} role="tablist" aria-label="打开的工作区文件">
      {session.documents.map((document) => {
        const selected = active !== undefined && samePath(active.preview.path, document.preview.path)
        return <div key={document.preview.path} className={css.fileTab} data-active={selected || undefined}>
          <button type="button" role="tab" aria-selected={selected} title={document.preview.path} onClick={() => { workspaceEditor.activate(sessionId, document.preview.path) }}>
            <IconCodeOutline16 /><span>{document.preview.name}</span>{document.status !== 'saved' && <i data-status={document.status} />}
          </button>
          <button type="button" className={css.closeTab} aria-label={`关闭 ${document.preview.name}`} onClick={() => { workspaceEditor.close(sessionId, document.preview.path) }}><IconCloseOutline16 /></button>
        </div>
      })}
      {session.documents.length === 0 && <span className={css.noTabs}>从右侧资源管理器打开文件</span>}
    </div>
    {active === undefined ? <div className={css.empty}>
      <IconCodeOutline16 size={28} />
      <strong>尚未打开文件</strong>
      <span>单击右侧资源管理器中的文件，即可在这里预览或编辑。</span>
    </div> : <>
      <header className={css.documentHeader}>
        <div><strong>{active.preview.name}</strong><span>{active.preview.path}</span></div>
        <button type="button" title="在系统中打开" onClick={() => { void openPath(active.preview.path) }}><IconFolderOpenOutline16 /><span>在系统中打开</span></button>
      </header>
      <DocumentBody sessionId={sessionId} document={active} />
    </>}
  </section>
}
