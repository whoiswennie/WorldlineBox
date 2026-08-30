import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent, ReactNode,
} from 'react'
import type {
  DirectoryEntry, DirectoryListing, SessionId, WorkspaceTreeMutation, WorkspaceTreePreview,
  WorkspaceTreeSearchListing,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconCopyOutline16, IconFolderClose16, IconFolderOpen16,
  IconFolderOpenOutline16, IconPlusOutline16, IconTrashOutline16,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceEditor } from './WorkspaceEditor.tsx'
import css from './WorkspaceExplorer.module.css'

interface Injected {
  listDirectory: (path: string, signal: AbortSignal) => Promise<DirectoryListing>
  searchFiles: (path: string, query: string, signal: AbortSignal) => Promise<WorkspaceTreeSearchListing>
  previewFile: (path: string, signal: AbortSignal) => Promise<WorkspaceTreePreview>
  mutate: (mutation: WorkspaceTreeMutation) => Promise<{ path?: string }>
  openPath: (path: string) => Promise<void>
  openInBrowser: (sessionId: SessionId, workspaceRoot: string, path: string) => Promise<void>
  subscribeChanges: (listener: (root: string) => void) => () => void
  selectView: (sessionId: SessionId, viewId: string) => void
  close: () => void
}
type Props = PropsRuntime<'worldline.workspace.right'> & InjectFace<Injected>
type ClipboardState = { entry: DirectoryEntry; operation: 'copy' | 'move' }
type MenuState = { x: number; y: number; entry?: DirectoryEntry; directory: string }
type PromptState = { title: string; value: string; submit: (value: string) => void }
type ConfirmState = { title: string; message: string; confirmLabel: string; submit: () => void }

const dirname = (path: string): string => path.replace(/[\\/][^\\/]+$/, '')
const samePath = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
const isHtmlFile = (entry: DirectoryEntry | undefined): entry is DirectoryEntry =>
  entry?.kind === 'file' && /\.(?:html?|xhtml)$/iu.test(entry.name)

async function uploadWorkspaceFile(file: File, directory: string): Promise<void> {
  const query = new URLSearchParams({
    parent: directory,
    name: file.name,
    expectedBytes: String(file.size),
  })
  const response = await fetch(`/api/workspace.upload?${query.toString()}`, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!response.ok) throw new Error((await response.text().catch(() => '')) || '文件导入失败')
}

type FileKind =
  | 'image' | 'audio' | 'video' | 'text' | 'code' | 'data' | 'archive'
  | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'file'

const extensionSet = (...values: string[]): ReadonlySet<string> => new Set(values)

const extensions = {
  image: extensionSet('png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'apng', 'avif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff'),
  audio: extensionSet('mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aac', 'm4a', 'weba', 'wma', 'aiff'),
  video: extensionSet('mp4', 'webm', 'mov', 'mkv', 'avi', 'mpeg', 'mpg', 'ogv', 'wmv', 'flv', 'm4v'),
  text: extensionSet('txt', 'md', 'mdx', 'rtf', 'log', 'csv', 'tsv'),
  code: extensionSet(
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs',
    'rb', 'php', 'swift', 'kt', 'kts', 'lua', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'html', 'htm',
    'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'sql',
  ),
  data: extensionSet('json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini', 'conf', 'config', 'env', 'properties'),
  archive: extensionSet('zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'),
  document: extensionSet('doc', 'docx', 'odt', 'pages'),
  spreadsheet: extensionSet('xls', 'xlsx', 'ods', 'numbers'),
  presentation: extensionSet('ppt', 'pptx', 'odp', 'key'),
} as const

function fileKind(name: string): FileKind {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (extensions.image.has(ext)) return 'image'
  if (extensions.audio.has(ext)) return 'audio'
  if (extensions.video.has(ext)) return 'video'
  if (extensions.text.has(ext) || ['readme', 'license', 'changelog', 'authors'].includes(lower)) return 'text'
  if (extensions.code.has(ext) || ['dockerfile', 'makefile'].includes(lower)) return 'code'
  if (extensions.data.has(ext) || lower === '.env' || lower.startsWith('.env.')) return 'data'
  if (extensions.archive.has(ext)) return 'archive'
  if (ext === 'pdf') return 'pdf'
  if (extensions.document.has(ext)) return 'document'
  if (extensions.spreadsheet.has(ext)) return 'spreadsheet'
  if (extensions.presentation.has(ext)) return 'presentation'
  return 'file'
}

function DocumentOutline({ children }: { children?: ReactNode }) {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.25 1.75h5.5l4 4v8.5H3.25z" />
    <path d="M8.75 1.75v4h4" />
    {children}
  </svg>
}

function FileGlyph({ name }: { name: string }) {
  const kind = fileKind(name)
  let icon: ReactNode
  if (kind === 'image') {
    icon = <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" /><circle cx="5.25" cy="5.75" r="1" /><path d="m3.5 11 2.5-2.5 1.75 1.75L10 7.75l2.5 3.25" /></svg>
  } else if (kind === 'audio') {
    icon = <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.25 11.5V4.25l6-1.5V10" /><path d="M6.25 5.75l6-1.5" /><ellipse cx="4.5" cy="11.75" rx="1.75" ry="1.25" /><ellipse cx="10.5" cy="10.25" rx="1.75" ry="1.25" /></svg>
  } else if (kind === 'video') {
    icon = <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.6" /><path d="m6.5 5.5 4 2.5-4 2.5z" /></svg>
  } else if (kind === 'text') {
    icon = <DocumentOutline><path d="M5.25 8.25h5.5M5.25 10.25h5.5M5.25 12.25h3.5" /></DocumentOutline>
  } else if (kind === 'code') {
    icon = <DocumentOutline><path d="m6.5 8-1.75 1.75L6.5 11.5M9.5 8l1.75 1.75L9.5 11.5" /></DocumentOutline>
  } else if (kind === 'data') {
    icon = <DocumentOutline><path d="M6.25 7.75c-.75 0-1 .35-1 .9v.45c0 .5-.25.9-.75.9.5 0 .75.4.75.9v.45c0 .55.25.9 1 .9M9.75 7.75c.75 0 1 .35 1 .9v.45c0 .5.25.9.75.9-.5 0-.75.4-.75.9v.45c0 .55-.25.9-1 .9" /></DocumentOutline>
  } else if (kind === 'archive') {
    icon = <DocumentOutline><path d="M7.25 4.25h1.5M7.25 6h1.5M7.25 7.75h1.5M7.25 9.5h1.5M7 11.25h2v1.5H7z" /></DocumentOutline>
  } else if (kind === 'spreadsheet') {
    icon = <DocumentOutline><path d="M5.25 8h5.5v4h-5.5zM8 8v4M5.25 10h5.5" /></DocumentOutline>
  } else if (kind === 'presentation') {
    icon = <DocumentOutline><path d="M5 8h6v3.25H5zM8 11.25v1.5M6.75 12.75h2.5" /></DocumentOutline>
  } else if (kind === 'pdf') {
    icon = <DocumentOutline><path d="M5 8.25h2.25a1.25 1.25 0 0 1 0 2.5H5zM5 10.75v1.5M9.5 8.25v4M9.5 8.25h1.75" /></DocumentOutline>
  } else if (kind === 'document') {
    icon = <DocumentOutline><path d="M5.25 8.25h5.5M5.25 10.25h4.5M5.25 12.25h5.5" /></DocumentOutline>
  } else {
    icon = <DocumentOutline />
  }
  return <span className={css.fileGlyph} data-kind={kind} aria-hidden="true">{icon}</span>
}

function TreeLevel({ directory, depth, revision, api, selected, onSelect, onMenu, onPreview,
  onDropEntry, onDropFiles }: {
  directory: string
  depth: number
  revision: number
  api: Pick<Injected, 'listDirectory'>
  selected?: string
  onSelect: (entry: DirectoryEntry) => void
  onMenu: (event: ReactMouseEvent, entry: DirectoryEntry | undefined, directory: string) => void
  onPreview: (entry: DirectoryEntry) => void
  onDropEntry: (entry: DirectoryEntry, directory: string) => void
  onDropFiles: (files: readonly File[], directory: string) => void
}) {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const abort = new AbortController()
    setError('')
    void api.listDirectory(directory, abort.signal).then(setListing, (reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { abort.abort() }
  }, [api, directory, revision])
  if (error !== '') return <div className={css.error}>{error}</div>
  if (listing === null) return <div className={css.note}>正在读取…</div>
  return <ul className={css.level} onContextMenu={(event) => { onMenu(event, undefined, directory) }}>
    {listing.entries.map(entry => entry.kind === 'directory'
      ? <DirectoryRow
        key={entry.path} entry={entry} depth={depth} revision={revision} api={api}
        onMenu={onMenu} onPreview={onPreview} onDropEntry={onDropEntry}
        onSelect={onSelect} onDropFiles={onDropFiles}
        {...(selected === undefined ? {} : { selected })}
      />
      : <li key={entry.path}>
        <button
          type="button" className={css.row} style={{ paddingLeft: 12 + depth * 17 }} title={entry.path}
          data-selected={samePath(selected ?? '', entry.path) || undefined}
          draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-worldline-workspace-entry', entry.path) }}
          onDoubleClick={() => { onPreview(entry) }} onClick={() => { onSelect(entry); onPreview(entry) }}
          onContextMenu={(event) => { onSelect(entry); onMenu(event, entry, directory) }}
        ><span className={css.chevronSpace} /><FileGlyph name={entry.name} /><span className={css.name}>{entry.name}</span></button>
      </li>)}
    {listing.entries.length === 0 && <li className={css.note}>空文件夹</li>}
    {listing.truncated && <li className={css.note}>文件过多，仅显示部分内容</li>}
  </ul>
}

function DirectoryRow(props: {
  entry: DirectoryEntry
  depth: number
  revision: number
  api: Pick<Injected, 'listDirectory'>
  selected?: string
  onSelect: (entry: DirectoryEntry) => void
  onMenu: (event: ReactMouseEvent, entry: DirectoryEntry | undefined, directory: string) => void
  onPreview: (entry: DirectoryEntry) => void
  onDropEntry: (entry: DirectoryEntry, directory: string) => void
  onDropFiles: (files: readonly File[], directory: string) => void
}) {
  const { entry, depth, revision, api, selected, onSelect, onMenu, onPreview, onDropEntry,
    onDropFiles } = props
  const [open, setOpen] = useState(false)
  return <li>
    <button
      type="button" className={css.row} style={{ paddingLeft: 12 + depth * 17 }} title={entry.path}
      data-selected={samePath(selected ?? '', entry.path) || undefined}
      draggable onDragStart={(event) => {
        event.dataTransfer.setData('application/x-worldline-workspace-entry', entry.path)
      }}
      onClick={() => { onSelect(entry); setOpen(value => !value) }}
      onContextMenu={(event) => { onSelect(entry); onMenu(event, entry, dirname(entry.path)) }}
      onDragOver={(event) => { event.preventDefault(); event.currentTarget.dataset.dragover = 'true' }}
      onDragLeave={(event) => { delete event.currentTarget.dataset.dragover }}
      onDrop={(event) => {
        event.preventDefault(); event.stopPropagation(); delete event.currentTarget.dataset.dragover
        const path = event.dataTransfer.getData('application/x-worldline-workspace-entry')
        if (path !== '') onDropEntry({ name: path.replace(/^.*[\\/]/, ''), path, hidden: false, kind: 'file' }, entry.path)
        else if (event.dataTransfer.files.length > 0) onDropFiles([...event.dataTransfer.files], entry.path)
      }}
    >
      {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
      {open ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      <span className={css.name}>{entry.name}</span>
    </button>
    {open && <TreeLevel
      directory={entry.path} depth={depth + 1} revision={revision} api={api}
      onMenu={onMenu} onPreview={onPreview} onDropEntry={onDropEntry}
      onSelect={onSelect} onDropFiles={onDropFiles}
      {...(selected === undefined ? {} : { selected })}
    />}
  </li>
}

export function WorkspaceExplorer({
  useSessions,
  listDirectory,
  searchFiles,
  previewFile,
  mutate,
  openPath,
  openInBrowser,
  subscribeChanges,
  selectView,
  close,
}: Props) {
  const currentSessionId = useSessions(state => state.current)
  const cwd = useSessions(state => state.current === undefined ? undefined : state.byId[state.current]?.cwd)
  const [revision, setRevision] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null)
  const [selected, setSelected] = useState<DirectoryEntry | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmState | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [searchListing, setSearchListing] = useState<WorkspaceTreeSearchListing | null>(null)
  const [searching, setSearching] = useState(false)
  const changedTimer = useRef<number | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const api = useMemo(() => ({ listDirectory }), [listDirectory])
  const refresh = useCallback(() => { setRevision(value => value + 1) }, [])

  useEffect(() => subscribeChanges((root) => {
    if (cwd === undefined || !samePath(root, cwd)) return
    if (changedTimer.current !== null) window.clearTimeout(changedTimer.current)
    changedTimer.current = window.setTimeout(() => { changedTimer.current = null; refresh() }, 180)
  }), [cwd, refresh, subscribeChanges])
  useEffect(() => () => { if (changedTimer.current !== null) window.clearTimeout(changedTimer.current) }, [])
  useEffect(() => { setError(''); setSelected(null); setClipboard(null); refresh() }, [cwd, refresh])
  useEffect(() => {
    const normalized = query.trim()
    if (cwd === undefined || normalized === '') {
      setSearchListing(null)
      setSearching(false)
      return
    }
    const abort = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(() => {
      void searchFiles(cwd, normalized, abort.signal).then((listing) => {
        if (!abort.signal.aborted) {
          setSearchListing(listing)
          setSearching(false)
        }
      }, (reason: unknown) => {
        if (!abort.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setSearching(false)
        }
      })
    }, 220)
    return () => { window.clearTimeout(timer); abort.abort() }
  }, [cwd, query, searchFiles])
  useEffect(() => {
    const hide = () => { setMenu(null) }
    window.addEventListener('click', hide)
    return () => { window.removeEventListener('click', hide) }
  }, [])

  const run = useCallback((operation: WorkspaceTreeMutation) => {
    setError('')
    void mutate(operation).then((result) => {
      workspaceEditor.applyMutation(operation, result.path)
      const resultPath = result.path
      if ((operation.operation === 'rename' || operation.operation === 'move')
        && resultPath !== undefined) {
        setSelected(current => current === null || !samePath(current.path, operation.path)
          ? current
          : { ...current, path: resultPath, name: resultPath.replace(/^.*[\\/]/u, '') })
      } else if (operation.operation === 'delete') {
        setSelected(current => current !== null && samePath(current.path, operation.path) ? null : current)
      }
      refresh()
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [mutate, refresh])
  const showPrompt = useCallback(
    (title: string, value: string, submit: (value: string) => void) => { setPrompt({ title, value, submit }) },
    [],
  )
  const onMenu = useCallback((event: ReactMouseEvent, entry: DirectoryEntry | undefined, directory: string) => {
    event.preventDefault(); event.stopPropagation()
    if (entry !== undefined) setSelected(entry)
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 330),
      ...(entry === undefined ? {} : { entry }),
      directory,
    })
  }, [])
  const onPreview = useCallback((entry: DirectoryEntry) => {
    if (currentSessionId === undefined) return
    const abort = new AbortController()
    setError('')
    void previewFile(entry.path, abort.signal).then((value) => {
      workspaceEditor.open(currentSessionId, value)
      selectView(currentSessionId, 'workspace')
    }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) })
  }, [currentSessionId, previewFile, selectView])
  const onDropEntry = useCallback((entry: DirectoryEntry, directory: string) => {
    if (samePath(entry.path, directory)) return
    run({ operation: 'move', path: entry.path, targetDirectory: directory })
  }, [run])
  const uploadFiles = useCallback(async (files: readonly File[], directory: string) => {
    setDropActive(false)
    setError('')
    try {
      for (const file of files) await uploadWorkspaceFile(file, directory)
      refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [refresh])
  const openWorkspaceDirectory = useCallback(() => {
    if (cwd === undefined) return
    setError('')
    void openPath(cwd).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [cwd, openPath])
  const menuEntry = menu?.entry
  const menuParent = menuEntry?.kind === 'directory' ? menuEntry.path : menu?.directory
  const selectedDirectory = selected?.kind === 'directory' ? selected.path
    : selected === null ? cwd : dirname(selected.path)
  const requestDelete = (entry: DirectoryEntry): void => {
    setConfirmation({
      title: '删除工作区项目',
      message: `确定删除“${entry.name}”吗？此操作无法撤销。`,
      confirmLabel: '删除',
      submit: () => { run({ operation: 'delete', path: entry.path }); setSelected(null) },
    })
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement
    if (target.matches('input, textarea, [contenteditable="true"]')) return
    const command = event.ctrlKey || event.metaKey
    const key = event.key.toLocaleLowerCase()
    if (command && (key === 'c' || key === 'x') && selected !== null) {
      event.preventDefault()
      setClipboard({ entry: selected, operation: key === 'c' ? 'copy' : 'move' })
    } else if (command && key === 'v' && clipboard !== null && selectedDirectory !== undefined) {
      event.preventDefault()
      run({ operation: clipboard.operation, path: clipboard.entry.path,
        targetDirectory: selectedDirectory })
      if (clipboard.operation === 'move') setClipboard(null)
    } else if (event.key === 'F2' && selected !== null) {
      event.preventDefault()
      showPrompt('重命名', selected.name,
        (name) => { run({ operation: 'rename', path: selected.path, name }) })
    } else if (event.key === 'Delete' && selected !== null) {
      event.preventDefault()
      requestDelete(selected)
    }
  }

  return <section
    className={css.root}
    aria-label="工作区文件资源管理器"
    tabIndex={0}
    onKeyDown={handleKeyDown}
    onContextMenu={(event) => { if (cwd !== undefined) onMenu(event, undefined, cwd) }}
  >
    <header><div><strong>资源管理器</strong><span>{cwd ?? '尚未选择工作区'}</span></div><button type="button" title="关闭文件面板" onClick={close}><IconCloseOutline16 /></button></header>
    <div className={css.toolbar}><strong>工作区</strong><div>
      <button type="button" title="新建文件" disabled={cwd === undefined} onClick={() => { if (cwd !== undefined) showPrompt('新建文件', '', (name) => { run({ operation: 'create-file', parent: cwd, name }) }) }}><IconPlusOutline16 /></button>
      <button type="button" title="新建文件夹" disabled={cwd === undefined} onClick={() => { if (cwd !== undefined) showPrompt('新建文件夹', '', (name) => { run({ operation: 'create-directory', parent: cwd, name }) }) }}><IconFolderOpenOutline16 /></button>
      <button type="button" title="导入文件" disabled={cwd === undefined}
        onClick={() => { importInput.current?.click() }}>⇧</button>
      <input ref={importInput} type="file" hidden multiple onChange={(event) => {
        if (selectedDirectory !== undefined) void uploadFiles([...event.currentTarget.files ?? []], selectedDirectory)
        event.currentTarget.value = ''
      }} />
      <button type="button" title="在文件资源管理器中打开工作区" disabled={cwd === undefined} onClick={openWorkspaceDirectory}><IconFolderOpen16 /></button>
      <button type="button" className={css.clearWorkspace} title="清空工作区" disabled={cwd === undefined} onClick={() => {
        if (cwd === undefined) return
        setConfirmation({
          title: '清空工作区',
          message: `确定清空“${cwd}”中的全部内容吗？所有文件、文件夹和隐藏项目都会被永久删除，但工作区目录本身会保留。此操作无法撤销。`,
          confirmLabel: '清空',
          submit: () => { run({ operation: 'clear-workspace', path: cwd }) },
        })
      }}><IconTrashOutline16 /></button>
    </div></div>
    <label className={css.searchBar}>
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="6.75" cy="6.75" r="4.25" /><path d="m10 10 3.25 3.25" /></svg>
      <input
        type="search"
        value={query}
        disabled={cwd === undefined}
        placeholder="按文件名或路径搜索"
        aria-label="搜索工作区文件"
        onChange={(event) => { setQuery(event.currentTarget.value); setError('') }}
      />
      {query !== '' && <button type="button" title="清除搜索" onClick={() => { setQuery('') }}>×</button>}
    </label>
    {error !== '' && <div className={css.errorBanner}>{error}<button type="button" onClick={() => { setError('') }}>×</button></div>}
    <div
      className={css.treePane}
      data-drop-active={dropActive || undefined}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setDropActive(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
          'application/x-worldline-workspace-entry',
        ) ? 'move' : 'copy'
      }}
      onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
        event.preventDefault()
        setDropActive(false)
        if (selectedDirectory === undefined) return
        const path = event.dataTransfer.getData('application/x-worldline-workspace-entry')
        if (path !== '') onDropEntry({ name: path.replace(/^.*[\\/]/u, ''), path,
          hidden: false, kind: 'file' }, selectedDirectory)
        else if (event.dataTransfer.files.length > 0) {
          void uploadFiles([...event.dataTransfer.files], selectedDirectory)
        }
      }}
    >
      {cwd === undefined
        ? <div className={css.empty}>选择一个工作区后即可浏览和管理文件。</div>
        : query.trim() !== ''
          ? <div className={css.searchResults}>
            {searching && <div className={css.note}>正在搜索…</div>}
            {!searching && searchListing?.results.map(result => <button
              key={result.path}
              type="button"
              className={css.searchResult}
              title={result.path}
              onClick={() => { onPreview({ name: result.name, path: result.path, kind: 'file', hidden: false }) }}
            >
              <FileGlyph name={result.name} />
              <span><strong>{result.name}</strong><small>{result.relativePath}</small></span>
            </button>)}
            {!searching && searchListing?.results.length === 0 && <div className={css.empty}>没有匹配的文件。</div>}
            {!searching && searchListing !== null && <div className={css.searchSummary}>
              找到 {searchListing.results.length} 个结果 · 已扫描 {searchListing.scanned} 项
              {searchListing.truncated ? ' · 已达到搜索上限' : ''}
            </div>}
          </div>
          : <TreeLevel
            directory={cwd} depth={0} revision={revision} api={api}
            onMenu={onMenu} onPreview={onPreview} onDropEntry={onDropEntry}
            onSelect={setSelected} onDropFiles={(files, directory) => {
              void uploadFiles(files, directory)
            }}
            {...(selected === null ? {} : { selected: selected.path })}
          />}
      {dropActive && <div className={css.dropHint}>拖到文件夹中即可复制到工作区</div>}
    </div>
    {menu !== null && <div className={css.menu} style={{ left: menu.x, top: menu.y }} role="menu" onClick={(event) => { event.stopPropagation() }}>
      {menuEntry?.kind === 'file' && <button type="button" role="menuitem" onClick={() => {
        onPreview(menuEntry)
        setMenu(null)
      }}>在中央打开</button>}
      {isHtmlFile(menuEntry) && cwd !== undefined && currentSessionId !== undefined && <button type="button" role="menuitem" onClick={() => {
        setError('')
        setMenu(null)
        void openInBrowser(currentSessionId, cwd, menuEntry.path).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }}>在内置浏览器中打开</button>}
      {menuEntry !== undefined && <button type="button" role="menuitem" onClick={() => {
        void openPath(menuEntry.path)
        setMenu(null)
      }}>在系统中打开</button>}
      {menuParent !== undefined && <button type="button" role="menuitem" onClick={() => {
        showPrompt('新建文件', '', (name) => { run({ operation: 'create-file', parent: menuParent, name }) })
        setMenu(null)
      }}>新建文件</button>}
      {menuParent !== undefined && <button type="button" role="menuitem" onClick={() => {
        showPrompt('新建文件夹', '', (name) => { run({ operation: 'create-directory', parent: menuParent, name }) })
        setMenu(null)
      }}>新建文件夹</button>}
      {menuParent !== undefined && <button type="button" role="menuitem" onClick={() => {
        setSelected(menuEntry ?? { name: menuParent.replace(/^.*[\\/]/u, ''), path: menuParent,
          hidden: false, kind: 'directory' })
        importInput.current?.click()
        setMenu(null)
      }}>导入文件…</button>}
      {menuEntry !== undefined && <><hr /><button type="button" role="menuitem" onClick={() => {
        showPrompt('重命名', menuEntry.name, (name) => { run({ operation: 'rename', path: menuEntry.path, name }) })
        setMenu(null)
      }}>重命名</button>
      <button type="button" role="menuitem" onClick={() => {
        setClipboard({ entry: menuEntry, operation: 'copy' })
        setMenu(null)
      }}><IconCopyOutline16 />复制</button>
      <button type="button" role="menuitem" onClick={() => {
        setClipboard({ entry: menuEntry, operation: 'move' })
        setMenu(null)
      }}>剪切</button>
      <button type="button" role="menuitem" onClick={() => {
        void writeClipboard(menuEntry.path)
        setMenu(null)
      }}>复制路径</button></>}
      {clipboard !== null && menuParent !== undefined && <button type="button" role="menuitem" onClick={() => {
        run({ operation: clipboard.operation, path: clipboard.entry.path, targetDirectory: menuParent })
        if (clipboard.operation === 'move') setClipboard(null)
        setMenu(null)
      }}>粘贴</button>}
      {menuEntry !== undefined && <><hr /><button type="button" role="menuitem" className={css.danger} onClick={() => {
        requestDelete(menuEntry)
        setMenu(null)
      }}><IconTrashOutline16 />删除</button></>}
    </div>}
    {clipboard !== null && <div className={css.clipboardStatus}>
      {clipboard.operation === 'copy' ? '已复制' : '已剪切'}：{clipboard.entry.name}
      <button type="button" aria-label="清除工作区剪贴板" onClick={() => { setClipboard(null) }}>×</button>
    </div>}
    {prompt !== null && <div className={css.modalBackdrop} onMouseDown={() => { setPrompt(null) }}><form className={css.prompt} onSubmit={(event) => { event.preventDefault(); const value = new FormData(event.currentTarget).get('value'); if (typeof value === 'string' && value.trim() !== '') prompt.submit(value.trim()); setPrompt(null) }} onMouseDown={(event) => { event.stopPropagation() }}><strong>{prompt.title}</strong><input name="value" autoFocus defaultValue={prompt.value} /><div><button type="button" onClick={() => { setPrompt(null) }}>取消</button><button type="submit">确定</button></div></form></div>}
    {confirmation !== null && <div className={css.modalBackdrop} onMouseDown={() => { setConfirmation(null) }}>
      <section className={css.confirmation} role="alertdialog" aria-modal="true" aria-labelledby="workspace-confirm-title" onMouseDown={(event) => { event.stopPropagation() }}>
        <div className={css.confirmIcon}><IconTrashOutline16 /></div>
        <div><strong id="workspace-confirm-title">{confirmation.title}</strong><p>{confirmation.message}</p></div>
        <footer><button type="button" onClick={() => { setConfirmation(null) }}>取消</button><button type="button" className={css.confirmDanger} autoFocus onClick={() => { const submit = confirmation.submit; setConfirmation(null); submit() }}>{confirmation.confirmLabel}</button></footer>
      </section>
    </div>}
  </section>
}
