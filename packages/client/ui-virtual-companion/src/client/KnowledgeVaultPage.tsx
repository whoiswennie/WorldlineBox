import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Button,
  IconChevronDownOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  MarkdownWorkspaceEditor,
  MarkdownWorkspaceModeSwitch,
  MarkdownWorkspacePreview,
  Modal,
  WorkspaceFileTreeRow,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeTreeEntry,
  ReferenceAsset,
  ReferenceDraft,
  ReferencePage,
  ReferenceTagCount,
} from '../contracts.ts'
import { companionStore, useCompanionStore } from './store.ts'
import { ReferenceContent } from './reference-renderer.tsx'
import css from './KnowledgeVaultPage.module.css'

type VaultTab = 'knowledge' | 'references' | 'trash'
type ViewMode = 'edit' | 'preview' | 'split'
type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
interface Envelope<T> {
  ok?: boolean
  value?: T
  error?: string
  current?: KnowledgeDocument
}
interface OpenDocument {
  document: KnowledgeDocument
  content: string
  status: SaveStatus
  viewMode: ViewMode
  error: string | undefined
  conflict: KnowledgeDocument | undefined
}
interface KnowledgeScopeOption {
  id: string
  name: string
  description: string
  avatar: string
  sharedAvatars?: readonly string[]
}
interface AgentVaultTrashItem {
  id: string
  agentId: string
  name: string
  deletedAt: number
  createdAt: number
  updatedAt: number
  restorable: boolean
  avatar: string
}
type TreeClipboardMode = 'copy' | 'cut'
interface TreeClipboard {
  mode: TreeClipboardMode
  entry: KnowledgeTreeEntry
}
interface TreeMenu {
  entry: KnowledgeTreeEntry
  x: number
  y: number
}
type TreeDialog =
  | { kind: 'create-file' | 'create-folder'; parent: string }
  | { kind: 'rename'; entry: KnowledgeTreeEntry }

const DEFAULT_KNOWLEDGE_DIRECTORY = 'memory/long/pages'

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function managedTreeEntry(entry: KnowledgeTreeEntry): boolean {
  return entry.path.split('/').length > 1
    && (entry.path.startsWith('memory/') || entry.path.startsWith('procedures/'))
}

function writableTreeDirectory(entry: KnowledgeTreeEntry | undefined): string {
  const candidate = entry?.kind === 'directory' ? entry.path
    : entry === undefined ? DEFAULT_KNOWLEDGE_DIRECTORY : parentDirectory(entry.path)
  return candidate === 'memory' || candidate === 'procedures'
    || candidate.startsWith('memory/') || candidate.startsWith('procedures/')
    ? candidate
    : DEFAULT_KNOWLEDGE_DIRECTORY
}

function movedPath(path: string, source: string, target: string): string {
  return path === source ? target : path.startsWith(`${source}/`)
    ? `${target}${path.slice(source.length)}`
    : path
}
export interface KnowledgeVaultOpenRequest {
  scope: string
  path: string
  revision: number
}
export interface KnowledgeVaultPageInjected {
  getOpenRequest?(): KnowledgeVaultOpenRequest | undefined
  subscribeOpenRequest?(listener: () => void): () => void
}
export type KnowledgeVaultPageProps = PropsRuntime<'worldline.main.page'> &
  InjectFace<KnowledgeVaultPageInjected>

async function post<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/virtual-companions/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  const envelope = (await response.json().catch(() => ({}))) as Envelope<T>
  if (!response.ok || envelope.ok !== true || envelope.value === undefined) {
    const error = new Error(
      envelope.error ?? `知识库请求失败（${String(response.status)}）`,
    ) as Error & { current?: KnowledgeDocument }
    if (envelope.current !== undefined) error.current = envelope.current
    throw error
  }
  return envelope.value
}

async function uploadReference(draft: ReferenceDraft, file: File): Promise<ReferenceAsset> {
  const prepared = await post<{ uploadId: string }>('reference/upload/prepare', { entry: draft })
  const mimeType = file.type || draft.mimeType || 'application/octet-stream'
  const response = await fetch(`/api/virtual-companions/reference/upload/${prepared.uploadId}`, {
    method: 'POST',
    headers: { 'content-type': mimeType },
    body: file,
  })
  const envelope = (await response.json().catch(() => ({}))) as Envelope<ReferenceAsset>
  if (!response.ok || envelope.ok !== true || envelope.value === undefined)
    throw new Error(envelope.error ?? `引用上传失败（${String(response.status)}）`)
  return envelope.value
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(typeof reader.result === 'string' ? reader.result : '')
    })
    reader.addEventListener('error', () => { reject(reader.error ?? new Error('读取文件失败')) })
    reader.readAsText(file)
  })
}

function ScopeAvatar({
  option,
  size = 'normal',
}: {
  option: KnowledgeScopeOption
  size?: 'normal' | 'large'
}) {
  if (option.id === 'public') {
    const avatars = option.sharedAvatars?.filter(Boolean).slice(0, 3) ?? []
    return <span className={css.scopeAvatar} data-shared data-size={size} aria-hidden="true">
      {avatars.length > 0
        ? avatars.map((avatar, index) => <img key={`${avatar}:${String(index)}`} src={avatar} alt="" />)
        : <b>✦</b>}
    </span>
  }
  return <span className={css.scopeAvatar} data-size={size} aria-hidden="true">
    {option.avatar !== ''
      ? <img src={option.avatar} alt="" />
      : <b>{option.name.trim().slice(0, 1) || '伙'}</b>}
  </span>
}

function ScopeSwitcher({
  options,
  value,
  onChange,
}: {
  options: readonly KnowledgeScopeOption[]
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.id === value) ?? options[0]
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (root.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  if (selected === undefined) return null
  return <div className={css.scopeSwitcher} ref={root}>
    <button
      type="button"
      className={css.scopeTrigger}
      role="combobox"
      aria-label="选择知识库"
      aria-controls="knowledge-scope-options"
      aria-expanded={open}
      aria-haspopup="listbox"
      onClick={() => { setOpen(current => !current) }}
    >
      <ScopeAvatar option={selected} />
      <span className={css.scopeCopy}>
        <strong>{selected.name}</strong>
        <small>{selected.description}</small>
      </span>
      <span className={css.scopeChevron} data-open={open} aria-hidden="true">
        <IconChevronDownOutline14 />
      </span>
    </button>
    {open && <div
      className={css.scopeMenu}
      id="knowledge-scope-options"
      role="listbox"
      aria-label="知识库列表"
    >
      <header>
        <div><strong>选择知识库</strong><small>进入伙伴专属的记忆空间</small></div>
        <span aria-hidden="true">✦</span>
      </header>
      <div className={css.scopeOptions}>
        {options.map(option => <button
          type="button"
          key={option.id}
          role="option"
          aria-selected={option.id === selected.id}
          onClick={() => {
            onChange(option.id)
            setOpen(false)
          }}
        >
          <ScopeAvatar option={option} />
          <span>
            <strong>{option.name}</strong>
            <small>{option.description}</small>
          </span>
          <i aria-hidden="true">{option.id === selected.id ? '✓' : '›'}</i>
        </button>)}
      </div>
      <footer><span>头像与伙伴资料保持同步</span><b aria-hidden="true">♡</b></footer>
    </div>}
  </div>
}

function referenceTagTone(tag: string): number {
  let value = 0
  for (const character of tag) value += character.codePointAt(0) ?? 0
  return value % 5
}

function TagOutline() {
  return <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.4 3.2v4.1l6.1 6.1 5-5-6.1-6.1H3.3a.9.9 0 0 0-.9.9Z" />
    <circle cx="5.25" cy="5.2" r="1" />
  </svg>
}

function MarkdownDocumentOutline() {
  return <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3.5 1.75h5.1l3.9 3.9v8.6h-9z" />
    <path d="M8.5 1.75v4h4M5.75 8.25h4.5M5.75 10.5h4.5" />
  </svg>
}

function ImportDocumentOutline() {
  return <svg viewBox="0 0 18 18" width="18" height="18" fill="none"
    stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M4 2.25h6l3.75 3.75v9.75H4z" />
    <path d="M10 2.25V6h3.75M6.5 11h5M9 8.5v5" />
  </svg>
}

function KnowledgeBookOutline() {
  return <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.65"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4.25 5.5A2.25 2.25 0 0 1 6.5 3.25H11v15.5H6.5A2.25 2.25 0 0 0 4.25 21z" />
    <path d="M19.75 5.5a2.25 2.25 0 0 0-2.25-2.25H13v15.5h4.5A2.25 2.25 0 0 1 19.75 21z" />
    <path d="M6.75 7.25h2M15.25 7.25h2M6.75 10.25h2M15.25 10.25h2" />
  </svg>
}

function ResourceGalleryOutline() {
  return <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.65"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3.25" y="4" width="17.5" height="16" rx="3" />
    <circle cx="8.25" cy="9" r="1.5" />
    <path d="m5.75 17 4.2-4.15 2.65 2.55 2.15-2.15L18.5 17" />
    <path d="m16.25 7.25 2 1.25-2 1.25z" fill="currentColor" stroke="none" />
  </svg>
}

function TreeBranch({
  scope,
  directory,
  onOpen,
  active,
  selected,
  onSelect,
  onMenu,
  onMove,
  onFiles,
  revision,
}: {
  scope: string
  directory: string
  onOpen: (path: string) => void
  active?: string
  selected?: string
  onSelect: (entry: KnowledgeTreeEntry) => void
  onMenu: (menu: TreeMenu) => void
  onMove: (source: string, targetDirectory: string, kind: KnowledgeTreeEntry['kind']) => void
  onFiles: (files: readonly File[], targetDirectory: string) => void
  revision: number
}) {
  const [entries, setEntries] = useState<readonly KnowledgeTreeEntry[]>([])
  const [open, setOpen] = useState(directory === '')
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    void post<KnowledgeTreeEntry[]>(
      'knowledge/tree',
      { scope, path: directory, limit: 500 },
      abort.signal,
    ).then(setEntries, () => {
      setEntries([])
    })
    return () => {
      abort.abort()
    }
  }, [directory, open, revision, scope])
  const folderEntry: KnowledgeTreeEntry = {
    name: directory.replace(/^.*\//u, ''),
    path: directory,
    kind: 'directory',
  }
  const drop = (event: DragEvent, targetDirectory: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const source = event.dataTransfer.getData('application/x-worldline-vault-path')
    if (source !== '') onMove(source, targetDirectory,
      event.dataTransfer.getData('application/x-worldline-vault-kind') === 'directory'
        ? 'directory' : 'document')
    else if (event.dataTransfer.files.length > 0) {
      onFiles([...event.dataTransfer.files], targetDirectory)
    }
  }
  const folderRow = directory === '' ? null : <WorkspaceFileTreeRow
    kind="directory"
    name={folderEntry.name}
    open={open}
    selected={selected === directory}
    draggable={managedTreeEntry(folderEntry)}
    onClick={() => {
      onSelect(folderEntry)
      setOpen(current => !current)
    }}
    onContextMenu={(event) => {
      event.preventDefault()
      onSelect(folderEntry)
      onMenu({ entry: folderEntry, x: event.clientX, y: event.clientY })
    }}
    onDragStart={(event) => {
      onSelect(folderEntry)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-worldline-vault-path', directory)
      event.dataTransfer.setData('application/x-worldline-vault-kind', 'directory')
    }}
    onDragOver={(event) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
        'application/x-worldline-vault-path',
      ) ? 'move' : 'copy'
    }}
    onDrop={(event) => { drop(event, directory) }}
  />
  if (directory !== '' && !open) return folderRow
  return (
    <div className={directory === '' ? css.treeRoot : css.treeChildren}>
      {folderRow}
      {entries.map(entry =>
        entry.kind === 'directory' ? (
          <TreeBranch
            key={entry.path}
            scope={scope}
            directory={entry.path}
            onOpen={onOpen}
            revision={revision}
            onSelect={onSelect}
            onMenu={onMenu}
            onMove={onMove}
            onFiles={onFiles}
            {...(selected === undefined ? {} : { selected })}
            {...(active === undefined ? {} : { active })}
          />
        ) : (
          <WorkspaceFileTreeRow
            key={entry.path}
            kind="document"
            name={entry.name}
            active={active === entry.path}
            selected={selected === entry.path}
            title={entry.path}
            draggable={managedTreeEntry(entry)}
            onClick={() => {
              onSelect(entry)
              onOpen(entry.path)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              onSelect(entry)
              onMenu({ entry, x: event.clientX, y: event.clientY })
            }}
            onDragStart={(event) => {
              onSelect(entry)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('application/x-worldline-vault-path', entry.path)
              event.dataTransfer.setData('application/x-worldline-vault-kind', entry.kind)
            }}
          />
        ),
      )}
    </div>
  )
}

function KnowledgeWorkbench({
  scope,
  scopeOption,
  showTree,
  showInfo,
  setShowInfo,
  openRequest,
}: {
  scope: string
  scopeOption: KnowledgeScopeOption
  showTree: boolean
  showInfo: boolean
  setShowInfo: (visible: boolean) => void
  openRequest?: KnowledgeVaultOpenRequest
}) {
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const documentsRef = useRef<OpenDocument[]>([])
  const [activePath, setActivePath] = useState<string>()
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([])
  const searchRevision = useRef(0)
  const [treeRevision, setTreeRevision] = useState(0)
  const [selectedEntry, setSelectedEntry] = useState<KnowledgeTreeEntry>()
  const [clipboard, setClipboard] = useState<TreeClipboard>()
  const [treeMenu, setTreeMenu] = useState<TreeMenu>()
  const [treeDialog, setTreeDialog] = useState<TreeDialog>()
  const [treeDialogValue, setTreeDialogValue] = useState('')
  const [treeError, setTreeError] = useState('')
  const [deleteEntry, setDeleteEntry] = useState<KnowledgeTreeEntry>()
  const [dropActive, setDropActive] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
  const timers = useRef(new Map<string, number>())
  documentsRef.current = documents
  const active = documents.find(item => item.document.path === activePath)
  const openDocument = useCallback(
    async (path: string) => {
      const document = await post<KnowledgeDocument>('knowledge/read', {
        scope,
        path,
        view: 'full',
      })
      setDocuments(current =>
        current.some(item => item.document.path === path)
          ? current
          : [
            ...current,
            {
              document,
              content: document.content,
              status: 'saved',
              viewMode: 'edit',
              error: undefined,
              conflict: undefined,
            },
          ],
      )
      setActivePath(path)
    },
    [scope],
  )
  const saveNow = useCallback(
    async (path: string) => {
      const item = documentsRef.current.find(candidate => candidate.document.path === path)
      if (item === undefined || item.status === 'saved' || item.status === 'saving') return
      const timer = timers.current.get(path)
      if (timer !== undefined) window.clearTimeout(timer)
      timers.current.delete(path)
      setDocuments(current =>
        current.map(value =>
          value.document.path === path ? { ...value, status: 'saving', error: undefined } : value,
        ),
      )
      try {
        const document = await post<KnowledgeDocument>('knowledge/write', {
          scope,
          path,
          content: item.content,
          expectedRevision: item.document.revision,
        })
        setDocuments(current =>
          current.map(value =>
            value.document.path === path
              ? {
                ...value,
                document,
                status: value.content === item.content ? 'saved' : 'dirty',
                error: undefined,
                conflict: undefined,
              }
              : value,
          ),
        )
        setTreeRevision(value => value + 1)
      } catch (reason) {
        const failure = reason as Error & { current?: KnowledgeDocument }
        setDocuments(current =>
          current.map(value =>
            value.document.path === path
              ? {
                ...value,
                status: failure.current === undefined ? 'error' : 'conflict',
                error: failure.message,
                ...(failure.current === undefined ? {} : { conflict: failure.current }),
              }
              : value,
          ),
        )
      }
    },
    [scope],
  )
  const edit = (path: string, content: string): void => {
    setDocuments(current =>
      current.map(value =>
        value.document.path === path
          ? {
            ...value,
            content,
            status: content === value.document.content ? 'saved' : 'dirty',
            error: undefined,
          }
          : value,
      ),
    )
    const old = timers.current.get(path)
    if (old !== undefined) window.clearTimeout(old)
    timers.current.set(
      path,
      window.setTimeout(() => {
        timers.current.delete(path)
        void saveNow(path)
      }, 700),
    )
  }
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
    },
    [],
  )
  useEffect(() => {
    setDocuments([])
    setActivePath(undefined)
    setSearchResults([])
    setQuery('')
    setSelectedEntry(undefined)
    setClipboard(undefined)
    setTreeMenu(undefined)
    setTreeDialog(undefined)
    setTreeError('')
  }, [scope])
  useEffect(() => {
    if (openRequest === undefined) return
    void openDocument(openRequest.path)
  }, [openDocument, openRequest])
  const beginTreeDialog = (dialog: TreeDialog): void => {
    setTreeDialog(dialog)
    setTreeDialogValue(dialog.kind === 'rename' ? dialog.entry.name : '')
    setTreeError('')
    setTreeMenu(undefined)
  }
  const createEntry = async (): Promise<void> => {
    const value = treeDialogValue.trim()
    if (treeDialog === undefined || treeDialog.kind === 'rename' || value === '') return
    try {
      if (treeDialog.kind === 'create-folder') {
        const entry = await post<KnowledgeTreeEntry>('knowledge/create', {
          scope, kind: 'directory', parent: treeDialog.parent, name: value,
        })
        setSelectedEntry(entry)
        setTreeRevision(current => current + 1)
        setTreeDialog(undefined)
        return
      }
      const document = await post<KnowledgeDocument>('knowledge/create', {
        scope, kind: 'document', parent: treeDialog.parent, name: value,
        title: value.replace(/\.md$/iu, ''),
      })
      setDocuments(current => [
        ...current,
        {
          document,
          content: document.content,
          status: 'saved',
          viewMode: 'edit',
          error: undefined,
          conflict: undefined,
        },
      ])
      setActivePath(document.path)
      setSelectedEntry({ name: document.path.replace(/^.*\//u, ''), path: document.path,
        kind: 'document', updatedAt: document.updatedAt, revision: document.revision })
      setTreeRevision(value => value + 1)
      setTreeDialog(undefined)
      setTreeDialogValue('')
      setTreeError('')
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  useEffect(() => {
    const normalized = query.trim()
    const revision = ++searchRevision.current
    if (normalized === '') {
      setSearchResults([])
      return
    }
    setSearchResults([])
    const timer = window.setTimeout(() => {
      void post<KnowledgeSearchResult[]>('knowledge/search', {
        scope,
        query: normalized,
        limit: 30,
      }).then((results) => {
        if (searchRevision.current === revision) setSearchResults(results)
      }).catch(() => {
        if (searchRevision.current === revision) setSearchResults([])
      })
    }, 140)
    return () => { window.clearTimeout(timer) }
  }, [query, scope])
  const useServerVersion = (path: string): void => {
    setDocuments(current =>
      current.map(item =>
        item.document.path === path && item.conflict !== undefined
          ? {
            ...item,
            document: item.conflict,
            content: item.conflict.content,
            status: 'saved',
            error: undefined,
            conflict: undefined,
          }
          : item,
      ),
    )
  }
  const keepLocalVersion = async (path: string): Promise<void> => {
    const item = documentsRef.current.find(value => value.document.path === path)
    if (item?.conflict === undefined) return
    try {
      const document = await post<KnowledgeDocument>('knowledge/write', {
        scope,
        path,
        content: item.content,
        expectedRevision: item.conflict.revision,
      })
      setDocuments(current =>
        current.map(value =>
          value.document.path === path
            ? { ...value, document, status: 'saved', error: undefined, conflict: undefined }
            : value,
        ),
      )
      setTreeRevision(value => value + 1)
    } catch (reason) {
      const failure = reason as Error & { current?: KnowledgeDocument }
      setDocuments(current =>
        current.map(value =>
          value.document.path === path
            ? {
              ...value,
              status: 'conflict',
              error: failure.message,
              ...(failure.current === undefined ? {} : { conflict: failure.current }),
            }
            : value,
        ),
      )
    }
  }
  const closeDocument = (path: string): void => {
    void saveNow(path)
    const current = documentsRef.current
    const index = current.findIndex(item => item.document.path === path)
    const remaining = current.filter(item => item.document.path !== path)
    if (activePath === path) {
      setActivePath((remaining[index] ?? remaining[index - 1])?.document.path)
    }
    setDocuments(remaining)
  }
  const saveEntryDocuments = async (entry: KnowledgeTreeEntry): Promise<void> => {
    await Promise.all(documentsRef.current
      .filter(item => item.document.path === entry.path
        || item.document.path.startsWith(`${entry.path}/`))
      .map(item => saveNow(item.document.path)))
  }
  const applyMovedPath = (source: string, target: string): void => {
    setDocuments(current => current.map((item) => {
      const path = movedPath(item.document.path, source, target)
      return path === item.document.path ? item : {
        ...item,
        document: { ...item.document, path },
      }
    }))
    setActivePath(current => current === undefined ? undefined : movedPath(current, source, target))
  }
  const moveEntry = async (entry: KnowledgeTreeEntry, targetDirectory: string): Promise<void> => {
    const target = `${targetDirectory}/${entry.name}`
    if (target === entry.path) return
    if (targetDirectory === entry.path || targetDirectory.startsWith(`${entry.path}/`)) {
      setTreeError('不能把文件夹移动到它自己里面')
      return
    }
    try {
      await saveEntryDocuments(entry)
      const moved = await post<KnowledgeTreeEntry>('knowledge/move', {
        scope, source: entry.path, target,
      })
      applyMovedPath(entry.path, target)
      setSelectedEntry(moved)
      setTreeRevision(current => current + 1)
      setTreeError('')
      if (clipboard?.mode === 'cut' && clipboard.entry.path === entry.path) setClipboard(undefined)
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const pasteEntry = async (targetDirectory = writableTreeDirectory(selectedEntry)): Promise<void> => {
    if (clipboard === undefined) return
    if (clipboard.mode === 'cut') {
      await moveEntry(clipboard.entry, targetDirectory)
      return
    }
    const sourceDirectory = parentDirectory(clipboard.entry.path)
    const name = sourceDirectory === targetDirectory
      ? clipboard.entry.kind === 'document'
        ? clipboard.entry.name.replace(/(\.md)?$/iu, '-副本.md')
        : `${clipboard.entry.name}-副本`
      : clipboard.entry.name
    try {
      const copied = await post<KnowledgeTreeEntry>('knowledge/copy', {
        scope, source: clipboard.entry.path, target: `${targetDirectory}/${name}`,
      })
      setSelectedEntry(copied)
      setTreeRevision(current => current + 1)
      setTreeError('')
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const renameEntry = async (): Promise<void> => {
    if (treeDialog?.kind !== 'rename') return
    const entry = treeDialog.entry
    let name = treeDialogValue.trim()
    if (name === '') return
    if (entry.kind === 'document' && !name.toLocaleLowerCase().endsWith('.md')) name += '.md'
    const target = `${parentDirectory(entry.path)}/${name}`
    try {
      await saveEntryDocuments(entry)
      const moved = await post<KnowledgeTreeEntry>('knowledge/move', {
        scope, source: entry.path, target,
      })
      applyMovedPath(entry.path, target)
      setSelectedEntry(moved)
      setTreeRevision(current => current + 1)
      setTreeDialog(undefined)
      setTreeError('')
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const trashEntry = async (): Promise<void> => {
    const entry = deleteEntry
    if (entry === undefined) return
    try {
      await saveEntryDocuments(entry)
      await post('knowledge/trash', { scope, path: entry.path })
      for (const [path, timer] of timers.current) {
        if (path === entry.path || path.startsWith(`${entry.path}/`)) {
          window.clearTimeout(timer)
          timers.current.delete(path)
        }
      }
      const remaining = documentsRef.current.filter(item => item.document.path !== entry.path
        && !item.document.path.startsWith(`${entry.path}/`))
      setDocuments(remaining)
      setActivePath(current => current === undefined || (current !== entry.path
        && !current.startsWith(`${entry.path}/`)) ? current : remaining.at(-1)?.document.path)
      setSelectedEntry(undefined)
      setDeleteEntry(undefined)
      setTreeRevision(current => current + 1)
      setTreeError('')
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : String(reason))
      setDeleteEntry(undefined)
    }
  }
  const importFiles = async (files: readonly File[], targetDirectory: string): Promise<void> => {
    setDropActive(false)
    const accepted = files.filter(file => file.size <= 5 * 1_024 * 1_024
      && (file.type.startsWith('text/') || /\.(?:md|markdown|txt)$/iu.test(file.name)))
    if (accepted.length === 0) {
      setTreeError('这里只能导入不超过 5 MB 的 Markdown 或纯文本文件；媒体文件请放入资源画廊')
      return
    }
    try {
      let last: KnowledgeDocument | undefined
      for (const file of accepted) {
        const name = file.name.replace(/\.(?:markdown|txt)$/iu, '.md')
        last = await post<KnowledgeDocument>('knowledge/create', {
          scope, kind: 'document', parent: targetDirectory, name,
          title: name.replace(/\.md$/iu, ''), content: await readTextFile(file),
        })
      }
      setTreeRevision(current => current + 1)
      setTreeError(accepted.length === files.length ? '' : '部分非文本文件未导入；可在资源画廊管理媒体')
      if (last !== undefined) await openDocument(last.path)
    } catch (reason) {
      setTreeError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  useEffect(() => {
    if (treeMenu === undefined) return
    const close = (): void => { setTreeMenu(undefined) }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [treeMenu])
  const handleTreeKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement
    if (target.matches('input, textarea, [contenteditable="true"]')) return
    const command = event.ctrlKey || event.metaKey
    const key = event.key.toLocaleLowerCase()
    if (command && (key === 'c' || key === 'x') && selectedEntry !== undefined
      && managedTreeEntry(selectedEntry)) {
      event.preventDefault()
      setClipboard({ mode: key === 'c' ? 'copy' : 'cut', entry: selectedEntry })
      setTreeError('')
    } else if (command && key === 'v' && clipboard !== undefined) {
      event.preventDefault()
      void pasteEntry()
    } else if (event.key === 'F2' && selectedEntry !== undefined
      && managedTreeEntry(selectedEntry)) {
      event.preventDefault()
      beginTreeDialog({ kind: 'rename', entry: selectedEntry })
    } else if (event.key === 'Delete' && selectedEntry !== undefined
      && managedTreeEntry(selectedEntry)) {
      event.preventDefault()
      setDeleteEntry(selectedEntry)
    }
  }
  return (
    <div
      className={css.knowledgeWorkbench}
      data-tree-open={showTree}
      data-info-open={showInfo}
    >
      {showTree && <aside
        className={css.filePane}
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('Files')) setDropActive(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
            'application/x-worldline-vault-path',
          ) ? 'move' : 'copy'
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDropActive(false)
          const source = event.dataTransfer.getData('application/x-worldline-vault-path')
          const target = writableTreeDirectory(selectedEntry)
          if (source !== '') {
            const entry = source === selectedEntry?.path ? selectedEntry
              : { name: source.replace(/^.*\//u, ''), path: source,
                kind: event.dataTransfer.getData('application/x-worldline-vault-kind') === 'directory'
                  ? 'directory' as const : 'document' as const }
            void moveEntry(entry, target)
          } else if (event.dataTransfer.files.length > 0) {
            void importFiles([...event.dataTransfer.files], target)
          }
        }}
      >
        <div className={css.paneTitle}>
          <div className={css.paneIdentity}>
            <span className={css.treeTitleIcon} aria-hidden="true"><IconFolderOpen16 /></span>
            <span className={css.paneHeading}>
              <small>KNOWLEDGE TREE</small>
              <strong>知识目录</strong>
            </span>
          </div>
          <div className={css.treeToolbar}>
            <button type="button" aria-label="新建文件" title="新建文件"
              onClick={() => { beginTreeDialog({ kind: 'create-file',
                parent: writableTreeDirectory(selectedEntry) }) }}>
              <IconPlusOutline16 />
            </button>
            <button type="button" aria-label="新建文件夹" title="新建文件夹"
              onClick={() => { beginTreeDialog({ kind: 'create-folder',
                parent: writableTreeDirectory(selectedEntry) }) }}>
              <IconFolderClose16 />
            </button>
            <button type="button" className={css.importDocumentButton} aria-label="导入文件"
              title="拖入或选择 Markdown/文本文件"
              onClick={() => { importInput.current?.click() }}><ImportDocumentOutline /></button>
            <input ref={importInput} type="file" hidden multiple accept=".md,.markdown,.txt,text/plain,text/markdown"
              onChange={(event) => {
                void importFiles([...event.currentTarget.files ?? []], writableTreeDirectory(selectedEntry))
                event.currentTarget.value = ''
              }} />
          </div>
        </div>
        <form
          className={css.vaultSearch}
          onSubmit={(event) => {
            event.preventDefault()
          }}
        >
          <IconSearchOutline16 />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
            }}
            placeholder="搜索标题、标签与正文"
          />
        </form>
        {treeError !== '' && <div className={css.treeError} role="status">
          <span>{treeError}</span>
          <button type="button" aria-label="关闭文件操作提示" onClick={() => { setTreeError('') }}>×</button>
        </div>}
        <div className={css.fileTree} data-drop-active={dropActive || undefined}>
          {query.trim() !== '' ? (
            searchResults.length > 0 ? searchResults.map(result => (
              <button
                type="button"
                key={result.path}
                className={css.searchHit}
                onClick={() => {
                  void openDocument(result.path)
                }}
              >
                <strong>{result.title}</strong>
                <span>{result.summary}</span>
              </button>
            )) : <p className={css.searchEmpty}>没有找到相关知识页</p>
          ) : (
            <TreeBranch
              scope={scope}
              directory=""
              onOpen={(path) => {
                void openDocument(path)
              }}
              onSelect={setSelectedEntry}
              onMenu={setTreeMenu}
              onMove={(source, targetDirectory, kind) => {
                const entry = source === selectedEntry?.path ? selectedEntry
                  : { name: source.replace(/^.*\//u, ''), path: source,
                    kind }
                void moveEntry(entry, targetDirectory)
              }}
              onFiles={(files, targetDirectory) => { void importFiles(files, targetDirectory) }}
              revision={treeRevision}
              {...(selectedEntry === undefined ? {} : { selected: selectedEntry.path })}
              {...(activePath === undefined ? {} : { active: activePath })}
            />
          )}
          {dropActive && <div className={css.treeDropHint}>拖到文件夹中即可导入</div>}
        </div>
        {treeMenu !== undefined && <div
          className={css.treeMenu}
          role="menu"
          style={{ left: treeMenu.x, top: treeMenu.y }}
          onClick={(event) => { event.stopPropagation() }}
        >
          <button type="button" role="menuitem" onClick={() => {
            beginTreeDialog({ kind: 'create-file', parent: writableTreeDirectory(treeMenu.entry) })
          }}>新建文件</button>
          <button type="button" role="menuitem" onClick={() => {
            beginTreeDialog({ kind: 'create-folder', parent: writableTreeDirectory(treeMenu.entry) })
          }}>新建文件夹</button>
          <button type="button" role="menuitem" onClick={() => {
            importInput.current?.click(); setTreeMenu(undefined)
          }}>导入文件…</button>
          <hr />
          <button type="button" role="menuitem" disabled={!managedTreeEntry(treeMenu.entry)}
            onClick={() => { setClipboard({ mode: 'copy', entry: treeMenu.entry }); setTreeMenu(undefined) }}>
            复制 <kbd>Ctrl+C</kbd></button>
          <button type="button" role="menuitem" disabled={!managedTreeEntry(treeMenu.entry)}
            onClick={() => { setClipboard({ mode: 'cut', entry: treeMenu.entry }); setTreeMenu(undefined) }}>
            剪切 <kbd>Ctrl+X</kbd></button>
          <button type="button" role="menuitem" disabled={clipboard === undefined}
            onClick={() => { void pasteEntry(writableTreeDirectory(treeMenu.entry)); setTreeMenu(undefined) }}>
            粘贴 <kbd>Ctrl+V</kbd></button>
          <hr />
          <button type="button" role="menuitem" disabled={!managedTreeEntry(treeMenu.entry)}
            onClick={() => { beginTreeDialog({ kind: 'rename', entry: treeMenu.entry }) }}>
            重命名 <kbd>F2</kbd></button>
          <button type="button" role="menuitem" data-danger disabled={!managedTreeEntry(treeMenu.entry)}
            onClick={() => { setDeleteEntry(treeMenu.entry); setTreeMenu(undefined) }}>
            移到回收目录 <kbd>Del</kbd></button>
        </div>}
        {clipboard !== undefined && <div className={css.clipboardStatus}>
          {clipboard.mode === 'copy' ? '已复制' : '已剪切'}：{clipboard.entry.name}
          <button type="button" aria-label="清除剪贴板" onClick={() => { setClipboard(undefined) }}>×</button>
        </div>}
      </aside>}
      <section className={css.documentPane}>
        <div className={css.tabStrip} role="tablist" aria-label="已打开的知识页">
          {documents.map(item => (
            <div
              key={item.document.path}
              className={css.documentTab}
              data-active={item.document.path === activePath || undefined}
            >
              <button
                type="button"
                className={css.documentTabTitle}
                role="tab"
                aria-selected={item.document.path === activePath}
                onClick={() => {
                  setActivePath(item.document.path)
                }}
              >
                <span className={css.documentTabIcon}><MarkdownDocumentOutline /></span>
                <span>{item.document.title}</span>
                <i data-status={item.status} />
              </button>
              <button
                type="button"
                className={css.documentTabClose}
                aria-label={`关闭标签页 ${item.document.title}`}
                title="关闭标签页"
                onClick={() => { closeDocument(item.document.path) }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        {active === undefined ? (
          <div className={css.emptyEditor}>
            <div className={css.emptyMuse}>
              <i aria-hidden="true">✦</i>
              <ScopeAvatar option={scopeOption} size="large" />
              <i aria-hidden="true">♡</i>
            </div>
            <small>{scopeOption.id === 'public' ? 'SHARED MEMORY' : 'PRIVATE MEMORY'}</small>
            <strong>{scopeOption.id === 'public'
              ? '打开大家共同的记忆书页'
              : `翻开 ${scopeOption.name} 的记忆书页`}</strong>
            <p>{scopeOption.id === 'public'
              ? '把灵感、设定与旅途记录整理在这里，让每位伙伴都能找到它。'
              : `这里是你与 ${scopeOption.name} 的专属知识空间，写下设定、回忆与想一起完成的事。`}</p>
            <button
              type="button"
              className={css.emptyCreate}
              onClick={() => {
                beginTreeDialog({ kind: 'create-file', parent: DEFAULT_KNOWLEDGE_DIRECTORY })
              }}
            >
              <span aria-hidden="true">＋</span> 新建知识页
            </button>
          </div>
        ) : (
          <>
            <header className={css.documentToolbar}>
              <div>
                <strong>{active.document.title}</strong>
                <span>{active.document.path}</span>
              </div>
              <MarkdownWorkspaceModeSwitch value={active.viewMode} onChange={(mode) => {
                setDocuments(current => current.map(item => item.document.path === active.document.path
                  ? { ...item, viewMode: mode }
                  : item))
              }} />
              <button
                type="button"
                className={css.saveButton}
                onClick={() => {
                  void saveNow(active.document.path)
                }}
              >
                {active.status === 'saved'
                  ? '已保存'
                  : active.status === 'saving'
                    ? '保存中…'
                    : active.status === 'conflict'
                      ? '存在冲突'
                      : '立即保存'}
              </button>
            </header>
            {active.error !== undefined && (
              <div className={css.editorError}>
                <span>{active.error}</span>
                {active.conflict !== undefined && (
                  <span>
                    <button
                      type="button"
                      onClick={() => {
                        useServerVersion(active.document.path)
                      }}
                    >
                      载入服务器版本
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void keepLocalVersion(active.document.path)
                      }}
                    >
                      保留本地版本
                    </button>
                  </span>
                )}
              </div>
            )}
            <div className={css.documentBody} data-mode={active.viewMode}>
              {active.viewMode !== 'preview' && (
                <MarkdownWorkspaceEditor
                  value={active.content}
                  onChange={(content) => {
                    edit(active.document.path, content)
                  }}
                  onSave={() => {
                    void saveNow(active.document.path)
                  }}
                  ariaLabel={`编辑: ${active.document.path}`}
                  className={css.editorSurface}
                />
              )}
              {active.viewMode !== 'edit' && (
                <MarkdownWorkspacePreview
                  content={active.content}
                  ariaLabel={`预览: ${active.document.path}`}
                  className={css.preview}
                />
              )}
            </div>
          </>
        )}
      </section>
      {showInfo && <aside className={css.infoPane}>
        <div className={css.paneTitle}>
          <span className={css.paneHeading}>
            <small>PAGE DETAILS</small>
            <strong>页面信息</strong>
          </span>
          <button
            type="button"
            aria-label="收起页面信息"
            onClick={() => { setShowInfo(false) }}
            title="收起页面信息"
          >
            ×
          </button>
        </div>
        {active === undefined ? (
          <div className={css.infoEmpty}>
            <span aria-hidden="true">◇</span>
            <strong>等待打开知识页</strong>
            <p>选择一篇文档后，这里会整理它的标签、双链、来源与更新状态。</p>
          </div>
        ) : (
          <div className={css.infoContent}>
            <section className={css.infoDocumentCard}>
              <span className={css.infoDocumentIcon}><MarkdownDocumentOutline /></span>
              <div><strong>{active.document.title}</strong><small>{active.document.path}</small></div>
            </section>
            <div className={css.infoStats}>
              <span><strong>{active.document.totalLines}</strong><small>行内容</small></span>
              <span><strong>{active.document.headings.length}</strong><small>级标题</small></span>
              <span><strong>{active.document.links.length}</strong><small>条出链</small></span>
            </div>
            <small className={css.infoUpdated}>最近更新 · {new Date(active.document.updatedAt).toLocaleString()}</small>
            <section className={css.infoSection}>
              <header><strong>标签</strong><small>{active.document.tags.length}</small></header>
              {active.document.tags.length === 0 ? <p>还没有标签</p> : <div className={css.tagList}>
                {active.document.tags.map(tag => <span key={tag}>#{tag}</span>)}
              </div>}
            </section>
            <section className={css.infoSection}>
              <header><strong>关联页面</strong><small>{active.document.links.length}</small></header>
              {active.document.links.length === 0 ? <p>暂时没有 Wiki 双链</p> : <div className={css.infoLinks}>
                {active.document.links.map(link => (
                  <button
                    type="button"
                    key={link}
                    onClick={() => {
                      void openDocument(link.endsWith('.md') ? link : `${link}.md`)
                    }}
                  >
                    <span aria-hidden="true">↗</span>[[{link}]]
                  </button>
                ))}
              </div>}
            </section>
            <section className={css.infoSection}>
              <header><strong>资料来源</strong><small>{active.document.sources.length}</small></header>
              {active.document.sources.length === 0 ? <p>尚未声明来源</p> : <div className={css.infoSources}>
                {active.document.sources.map(source => <span key={source}>{source}</span>)}
              </div>}
            </section>
          </div>
        )}
      </aside>}
      <Modal
        open={treeDialog !== undefined}
        onClose={() => {
          setTreeDialog(undefined)
          setTreeError('')
        }}
        title={treeDialog?.kind === 'rename' ? '重命名'
          : treeDialog?.kind === 'create-folder' ? '新建文件夹' : '新建 Markdown 文件'}
        description={treeDialog?.kind === 'rename'
          ? treeDialog.entry.path
          : `位置：${treeDialog?.parent ?? DEFAULT_KNOWLEDGE_DIRECTORY}`}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setTreeDialog(undefined)
                setTreeError('')
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={treeDialogValue.trim() === ''}
              onClick={() => {
                void (treeDialog?.kind === 'rename' ? renameEntry() : createEntry())
              }}
            >
              {treeDialog?.kind === 'rename' ? '重命名' : '创建'}
            </Button>
          </>
        }
      >
        <label className={css.newPageField}>
          {treeDialog?.kind === 'create-folder' ? '文件夹名称' : '文件名称'}
          <input
            autoFocus
            value={treeDialogValue}
            onChange={(event) => {
              setTreeDialogValue(event.currentTarget.value)
              setTreeError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && treeDialogValue.trim() !== '') {
                event.preventDefault()
                void (treeDialog?.kind === 'rename' ? renameEntry() : createEntry())
              }
            }}
          />
        </label>
        {treeError !== '' && <p className={css.editorError}>{treeError}</p>}
      </Modal>
      <Modal
        open={deleteEntry !== undefined}
        onClose={() => { setDeleteEntry(undefined) }}
        title="移到回收目录"
        description={`确定删除“${deleteEntry?.name ?? ''}”吗？它会保留在当前 Vault 的隐藏回收目录中。`}
        footer={<>
          <Button variant="outline" onClick={() => { setDeleteEntry(undefined) }}>取消</Button>
          <Button variant="primary" onClick={() => { void trashEntry() }}>确认删除</Button>
        </>}
      >
        <p className={css.deleteHint}>文件夹中的全部内容会一起移动；打开的相关标签页将关闭。</p>
      </Modal>
    </div>
  )
}

const EMPTY_REFERENCE: ReferenceDraft = {
  scope: 'public',
  title: '',
  description: '',
  tags: [],
  transcript: '',
  mimeType: '',
  asset: '',
}
export function inferReferenceTags(file: Pick<File, 'type'>): string[] {
  if (file.type === '') return []
  const mimeType = file.type
  const tags = mimeType.startsWith('image/') ? ['图片']
    : mimeType.startsWith('audio/') ? ['音频']
      : mimeType.startsWith('video/') ? ['视频']
        : mimeType.startsWith('text/') ? ['文本'] : ['文件']
  const subtype = mimeType.split('/', 2)[1]?.split(/[;+]/u, 1)[0]
  return [...tags, ...(subtype === undefined || subtype === 'octet-stream' ? [] : [subtype])]
}

export function referenceTitleFromUrl(value: string): string {
  try {
    const url = new URL(value)
    const candidate = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '')
      .replace(/\.[a-z\d]{1,8}$/iu, '')
      .replaceAll(/[-_]+/gu, ' ')
      .trim()
    return candidate || url.hostname
  } catch {
    return ''
  }
}

function ReferenceMedia({ item }: { item: ReferenceAsset }) {
  return <ReferenceContent resource={{
    id: item.id,
    title: item.title,
    url: item.url,
    mimeType: item.mimeType,
    text: item.transcript,
    description: item.description,
    tags: item.tags,
  }} mode="card" />
}

function ReferencePreviewOutline() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 3.5H3.5V7M13 3.5h3.5V7M7 16.5H3.5V13M13 16.5h3.5V13" />
    <circle cx="10" cy="10" r="2.6" />
  </svg>
}

function formatReferenceBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '大小未知'
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

function ReferencePreviewContent({ item }: { item: ReferenceAsset }) {
  const mimeType = item.mimeType.trim().toLocaleLowerCase('en-US')
  const resource = {
    id: item.id,
    title: item.title,
    url: item.url,
    mimeType: item.mimeType,
    text: item.transcript,
    description: item.description,
    tags: item.tags,
  }
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')
    || mimeType.startsWith('audio/') || mimeType.startsWith('text/'))
    return <ReferenceContent resource={resource} mode="preview" />
  if (item.url !== undefined && item.url !== '') return <object
    className={css.referenceObjectPreview}
    data={item.url}
    type={item.mimeType || undefined}
    aria-label={`${item.title}文件内容`}
  >
    <div className={css.referenceUnsupported}>
      <span>◇</span><strong>此格式由系统预览器打开</strong>
      <p>当前浏览器没有可用的内嵌渲染器，但资源本身仍然可以正常打开。</p>
    </div>
  </object>
  return <ReferenceContent resource={resource} mode="preview" />
}

function ReferencePreviewDialog({ item, onClose }: {
  item: ReferenceAsset
  onClose: () => void
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close) }
  }, [onClose])
  return <div className={css.referencePreviewBackdrop} role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className={css.referenceViewer} role="dialog" aria-modal="true"
      aria-label={`${item.title}资源预览`}>
      <header>
        <div><span>RESOURCE PREVIEW</span><strong>{item.title}</strong><small>{item.mimeType || '未知资源类型'}</small></div>
        <button type="button" onClick={onClose} aria-label="关闭资源预览">×</button>
      </header>
      <div className={css.referenceViewerStage} data-media-type={item.mimeType.split('/', 1)[0]}>
        <ReferencePreviewContent item={item} />
      </div>
      <footer>
        <div className={css.referenceViewerMeta}>
          <span>{formatReferenceBytes(item.bytes)}</span>
          {item.durationMs === undefined ? null : <span>{Math.round(item.durationMs / 1_000)} 秒</span>}
          <span>{item.builtIn ? '内置资源' : '自定义资源'}</span>
        </div>
        <div className={css.referenceViewerActions}>
          {item.url === undefined || item.url === '' ? null : <a href={item.url}
            target="_blank" rel="noreferrer">在新窗口打开</a>}
          <button type="button" onClick={onClose}>完成</button>
        </div>
      </footer>
    </section>
  </div>
}

function ReferenceDraftPreview({
  draft,
  previewUrl,
  current,
  onDuration,
}: {
  draft: ReferenceDraft
  previewUrl: string
  current?: ReferenceAsset | undefined
  onDuration: (milliseconds: number) => void
}) {
  const source = previewUrl || draft.asset || current?.url || ''
  const mimeType = previewUrl === '' ? (current?.mimeType ?? draft.mimeType) : draft.mimeType
  if (source === '') return <div className={css.referencePreviewEmpty}>
    <span>＋</span>
    <strong>把资源放进来</strong>
    <p>支持图片、文本、音频、视频、Canvas 数据和其他扩展文件。</p>
  </div>
  return <ReferenceContent
    resource={{
      title: draft.title || referenceTitleFromUrl(source) || '资源预览',
      url: source,
      mimeType,
      text: draft.transcript,
      description: draft.description,
      tags: draft.tags,
    }}
    mode="preview"
    onDuration={onDuration}
  />
}

function ReferenceTagEditor({
  tags,
  suggestions,
  onChange,
}: {
  tags: readonly string[]
  suggestions: readonly string[]
  onChange: (tags: readonly string[]) => void
}) {
  const [input, setInput] = useState('')
  const add = (raw: string): void => {
    const additions = raw.split(/[,，]/u).map(value => value.trim()).filter(Boolean)
    if (additions.length > 0) onChange([...new Set([...tags, ...additions])])
    setInput('')
  }
  return <div className={css.referenceTagEditor}>
    <span>标签 <small>自由添加；标签就是资源的类别、情绪、角色和使用场景</small></span>
    <div className={css.referenceTagChips}>
      {tags.map(tag => <button
        type="button"
        aria-label={`移除标签 ${tag}`}
        onClick={() => { onChange(tags.filter(value => value !== tag)) }}
        key={tag}
      >#{tag}<span>×</span></button>)}
      <input
        aria-label="添加标签"
        value={input}
        placeholder={tags.length === 0 ? '输入标签，回车添加' : '继续添加…'}
        onChange={(event) => {
          const value = event.currentTarget.value
          if (/[,，]/u.test(value)) add(value)
          else setInput(value)
        }}
        onBlur={() => { if (input.trim() !== '') add(input) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && input.trim() !== '') {
            event.preventDefault()
            add(input)
          }
        }}
      />
    </div>
    {suggestions.some(tag => !tags.includes(tag)) && <div className={css.referenceTagSuggestions}>
      <small>建议：</small>
      {suggestions.filter(tag => !tags.includes(tag)).map(tag => <button
        type="button"
        onClick={() => { onChange([...tags, tag]) }}
        key={tag}
      >+ {tag}</button>)}
    </div>}
  </div>
}

function ReferenceWorkbench({
  scope,
  scopeOption,
  showFilters,
  setShowFilters,
}: {
  scope: string
  scopeOption: KnowledgeScopeOption
  showFilters: boolean
  setShowFilters: (visible: boolean) => void
}) {
  const [items, setItems] = useState<readonly ReferenceAsset[]>([])
  const [catalog, setCatalog] = useState<readonly ReferenceTagCount[]>([])
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [draft, setDraft] = useState<ReferenceDraft>({ ...EMPTY_REFERENCE, scope })
  const [pendingFile, setPendingFile] = useState<File>()
  const [editingId, setEditingId] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ReferenceAsset>()
  const [previewing, setPreviewing] = useState<ReferenceAsset>()
  const [changingEnabledId, setChangingEnabledId] = useState<string>()
  const [error, setError] = useState('')
  const [nextCursor, setNextCursor] = useState(-1)
  const [previewUrl, setPreviewUrl] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const load = useCallback(
    async (cursor = 0, append = false) => {
      const page = await post<ReferencePage>('reference/search', {
        scopes: [scope],
        query,
        tags: tag === '' ? [] : [tag],
        includeDisabled: true,
        ...(enabledFilter === 'all' ? {} : { enabled: enabledFilter === 'enabled' }),
        cursor,
        limit: 48,
      })
      setItems(current => (append ? [...current, ...page.items] : page.items))
      setNextCursor(page.nextCursor)
    },
    [enabledFilter, query, scope, tag],
  )
  const loadCatalog = useCallback(async () => {
    setCatalog(await post<readonly ReferenceTagCount[]>('reference/tags', {
      scopes: [scope],
      includeDisabled: true,
    }))
  }, [scope])
  useEffect(() => {
    setDraft({ ...EMPTY_REFERENCE, scope })
    setPendingFile(undefined)
    setEditing(false)
    setAdvanced(false)
    setEditingId(undefined)
    setPreviewing(undefined)
    void Promise.all([load(), loadCatalog()])
  }, [load, loadCatalog, scope])
  useEffect(() => {
    if (pendingFile === undefined || typeof URL.createObjectURL !== 'function') {
      setPreviewUrl('')
      return
    }
    const value = URL.createObjectURL(pendingFile)
    setPreviewUrl(value)
    return () => {
      URL.revokeObjectURL(value)
    }
  }, [pendingFile])
  const chooseFile = (file: File): void => {
    const mimeType = file.type || 'application/octet-stream'
    setPendingFile(file)
    setError('')
    setDraft(current => ({
      ...current,
      asset: '',
      mimeType,
      title: current.title || file.name.replace(/\.[^.]+$/u, ''),
      tags: [...new Set([...current.tags, ...inferReferenceTags({ type: mimeType })])],
    }))
    if (mimeType.startsWith('text/') && file.size <= 1_024 * 1_024) void file.text().then((text) => {
      setDraft(current => current.mimeType === mimeType
        ? { ...current, transcript: current.transcript || text.slice(0, 80_000) }
        : current)
    })
  }
  const beginCreate = (): void => {
    setDraft({ ...EMPTY_REFERENCE, scope })
    setPendingFile(undefined)
    setEditingId(undefined)
    setAdvanced(false)
    setDragging(false)
    setError('')
    setEditing(true)
  }
  const save = async (): Promise<void> => {
    try {
      if (draft.title.trim() === '') throw new Error('请填写标题；选择文件后会自动使用文件名。')
      if (editingId === undefined && pendingFile === undefined && draft.asset.trim() === '')
        throw new Error('请拖入文件、从电脑选择资源，或填写外部链接。')
      if (editingId === undefined && pendingFile !== undefined)
        await uploadReference(draft, pendingFile)
      else
        await post<ReferenceAsset>(
          editingId === undefined ? 'reference/create' : 'reference/update',
          { ...(editingId === undefined ? {} : { id: editingId }), entry: draft },
        )
      setEditing(false)
      setEditingId(undefined)
      setPendingFile(undefined)
      setDraft({ ...EMPTY_REFERENCE, scope })
      await Promise.all([load(), loadCatalog()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const editReference = (item: ReferenceAsset): void => {
    setDraft({
      scope: item.scope,
      title: item.title,
      description: item.description,
      tags: item.tags,
      transcript: item.transcript,
      mimeType: item.mimeType,
      asset: item.source.type === 'link' ? item.source.url : '',
      ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
    })
    setPendingFile(undefined)
    setEditingId(item.id)
    setAdvanced(false)
    setError('')
    setEditing(true)
  }
  const removeReference = async (): Promise<void> => {
    const item = pendingDelete
    if (item === undefined) return
    setPendingDelete(undefined)
    try {
      await post<{ removed: boolean }>('reference/delete', { scope, id: item.id })
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const setReferenceEnabled = async (item: ReferenceAsset, enabled: boolean): Promise<void> => {
    setChangingEnabledId(item.id)
    setError('')
    try {
      await post<ReferenceAsset>('reference/set-enabled', { scope, id: item.id, enabled })
      await Promise.all([load(), loadCatalog()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangingEnabledId(undefined)
    }
  }
  return (
    <div className={css.referenceWorkbench} data-filters-open={showFilters}>
      {showFilters && <aside className={css.referenceSidebar}>
        <div className={css.paneTitle}>
          <strong>检索与标签</strong>
          <button
            type="button"
            aria-label="收起筛选栏"
            onClick={() => { setShowFilters(false) }}
            title="收起筛选栏"
          >
            ×
          </button>
        </div>
        <label className={css.referenceSearch}>
          <IconSearchOutline16 />
          <input
            value={query}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
            placeholder="搜索引用资料"
          />
        </label>
        <label className={css.referenceStatusFilter}>
          <span>状态</span>
          <select
            aria-label="引用状态"
            value={enabledFilter}
            onChange={(event) => {
              setEnabledFilter(event.currentTarget.value as 'all' | 'enabled' | 'disabled')
            }}
          >
            <option value="all">全部状态</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已禁用</option>
          </select>
        </label>
        <div className={css.referenceTagBrowser}>
          <div className={css.referenceTagTitle}>
            <div><span><TagOutline /></span><strong>标签</strong></div>
            <small>{catalog.length} 个标签</small>
          </div>
          <button
            type="button"
            className={css.allReferencesTag}
            aria-pressed={tag === ''}
            onClick={() => { setTag('') }}
          >
            <ScopeAvatar option={scopeOption} />
            <span className={css.allReferencesCopy}>
              <strong>全部引用</strong><small>浏览这个知识库的所有资源</small>
            </span>
            <b>{items.length}</b>
          </button>
          <div className={css.referenceTagCloud}>
            {catalog.map(item => <button
              type="button"
              key={item.tag}
              data-tone={referenceTagTone(item.tag)}
              aria-pressed={tag === item.tag}
              onClick={() => { setTag(current => current === item.tag ? '' : item.tag) }}
            >
              <i><TagOutline /></i>
              <span>#{item.tag}</span>
              <small>{item.count}</small>
            </button>)}
          </div>
        </div>
      </aside>}
      <section className={css.referenceContent}>
        <header>
          <div className={css.referenceHeading}>
            <ScopeAvatar option={scopeOption} />
            <div>
              <h2>{tag === '' ? '全部引用' : `#${tag}`}</h2>
              <p>{scopeOption.name} · {items.length} 项图片、文本与音视频资源</p>
            </div>
          </div>
          <button type="button" onClick={beginCreate}>新增引用</button>
        </header>
        {error !== '' && !editing && <p className={css.editorError}>{error}</p>}
        <div className={css.referenceGrid}>
          {items.map(item => (
            <article key={item.id} data-enabled={item.enabled || undefined}>
              <div className={css.referenceMedia}>
                <ReferenceMedia item={item} />
                <button type="button" className={css.referencePreviewAction}
                  aria-label={`预览资源 ${item.title}`}
                  onClick={() => { setPreviewing(item) }}>
                  <ReferencePreviewOutline /><span>预览</span>
                </button>
              </div>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <div className={css.tagList}>
                {item.tags.map(tag => (
                  <span key={tag} data-tone={referenceTagTone(tag)}>#{tag}</span>
                ))}
              </div>
              <small>
                {item.mimeType || '外部链接'}
              </small>
              <div className={css.referenceActions}>
                <div className={css.referenceState}>
                  <span data-enabled={item.enabled || undefined}>
                    {item.enabled ? '已启用' : '已禁用'}
                  </span>
                  {item.builtIn && <span>内置</span>}
                </div>
                <button
                  type="button"
                  className={item.enabled ? css.disableAction : css.enableAction}
                  disabled={changingEnabledId === item.id}
                  aria-label={`${item.enabled ? '禁用' : '启用'}引用 ${item.title}`}
                  onClick={() => {
                    void setReferenceEnabled(item, !item.enabled)
                  }}
                >
                  {changingEnabledId === item.id ? '处理中…' : item.enabled ? '禁用' : '启用'}
                </button>
                {!item.builtIn && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        editReference(item)
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className={css.deleteAction}
                      onClick={() => {
                        setPendingDelete(item)
                      }}
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
        {items.length === 0 && <div className={css.referenceEmpty}>
          <ScopeAvatar option={scopeOption} size="large" />
          <strong>没有匹配的引用资料</strong>
          <p>换一个标签看看，或者为 {scopeOption.name} 添加新的引用资料。</p>
        </div>}
        {nextCursor >= 0 && (
          <button
            type="button"
            className={css.loadMore}
            onClick={() => {
              void load(nextCursor, true)
            }}
          >
            加载更多
          </button>
        )}
      </section>
      {editing && (
        <div className={css.modalBackdrop}>
          <section
            className={css.referenceEditor}
            role="dialog"
            aria-label={editingId === undefined ? '新增引用' : '编辑引用'}
          >
            <header>
              <div>
                <h2>{editingId === undefined ? '新增引用' : '编辑引用'}</h2>
                <p>{editingId === undefined
                  ? '放入资源，添加任意标签；没有需要先选定的固定类别。'
                  : '标题、标签和可检索文字会立即用于后续 Agent 检索。'}</p>
              </div>
              <button
                type="button"
                aria-label="关闭引用编辑器"
                onClick={() => {
                  setEditing(false)
                }}
              >
                ×
              </button>
            </header>
            <div className={css.referenceEditorBody}>
              <section className={css.referenceSourcePanel}>
                <div className={css.referencePreview}>
                  <ReferenceDraftPreview
                    draft={draft}
                    previewUrl={previewUrl}
                    current={items.find(item => item.id === editingId)}
                    onDuration={(durationMs) => {
                      setDraft(current => ({ ...current, durationMs }))
                    }}
                  />
                </div>
                {editingId === undefined ? <>
                  <button
                    type="button"
                    className={css.referenceDropZone}
                    data-dragging={dragging || undefined}
                    onClick={() => { fileInput.current?.click() }}
                    onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
                    onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      setDragging(false)
                      const file = event.dataTransfer.files[0]
                      if (file !== undefined) chooseFile(file)
                    }}
                    onPaste={(event) => {
                      const file = [...event.clipboardData.files][0]
                      if (file !== undefined) { event.preventDefault(); chooseFile(file) }
                    }}
                  >
                    <strong>{pendingFile === undefined ? '拖到这里，或点击选择' : pendingFile.name}</strong>
                    <span>{pendingFile === undefined
                      ? '支持任意文件；也可以粘贴剪贴板里的媒体'
                      : '点击可重新选择资源'}</span>
                  </button>
                  <input
                    ref={fileInput}
                    className={css.hiddenFileInput}
                    type="file"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file !== undefined) chooseFile(file)
                      event.currentTarget.value = ''
                    }}
                  />
                  <div className={css.referenceSourceDivider}><span>或</span></div>
                  <label>
                    外部链接
                    <input
                      value={draft.asset}
                      disabled={pendingFile !== undefined}
                      placeholder="粘贴 https://…"
                      onChange={(event) => {
                        const asset = event.currentTarget.value
                        setDraft(current => ({
                          ...current,
                          asset,
                          mimeType: asset.trim() === '' ? current.mimeType : '',
                          tags: asset.trim() === '' || current.tags.includes('链接')
                            ? current.tags
                            : [...current.tags, '链接'],
                          title: current.title || referenceTitleFromUrl(asset),
                        }))
                      }}
                    />
                  </label>
                </> : <p className={css.referenceSourceNotice}>
                  当前版本编辑时保留原始媒体，可以修改它的名称和使用方式。
                </p>}
              </section>
              <section className={css.referenceQuickForm}>
                <label>
                  标题 <span>必填</span>
                  <input
                    value={draft.title}
                    placeholder="选择文件后会自动填写"
                    onChange={(event) => {
                      const title = event.currentTarget.value
                      setDraft(current => ({ ...current, title }))
                    }}
                  />
                </label>
                <label>
                  什么时候适合使用 <span>可选</span>
                  <textarea
                    value={draft.description}
                    placeholder="例如：朋友遇到困难时，用来鼓励和打气"
                    onChange={(event) => {
                      const description = event.currentTarget.value
                      setDraft(current => ({ ...current, description }))
                    }}
                  />
                  <small>写自然语言即可，系统会据此帮助 Agent 找到它。</small>
                </label>
                <ReferenceTagEditor
                  tags={draft.tags}
                  suggestions={[
                    ...inferReferenceTags({ type: draft.mimeType }),
                    ...(draft.mimeType.startsWith('image/') ? ['表情包'] : []),
                    ...catalog.slice(0, 12).map(item => item.tag),
                  ]}
                  onChange={(tags) => { setDraft(current => ({ ...current, tags })) }}
                />
                <details
                  className={css.referenceAdvanced}
                  open={advanced}
                  onToggle={(event) => { setAdvanced(event.currentTarget.open) }}
                >
                  <summary>
                    <span>可检索文字</span>
                    <small>适合文本、台词和音视频转写</small>
                  </summary>
                  <div className={css.referenceEditorGrid}>
                    <label className={css.wideField}>
                      文本正文 / 台词 / 转写
                      <textarea
                        value={draft.transcript}
                        placeholder="粘贴文本内容，或填写音视频中说了什么；这些内容也会参与检索"
                        onChange={(event) => {
                          const transcript = event.currentTarget.value
                          setDraft(current => ({ ...current, transcript }))
                        }}
                      />
                    </label>
                  </div>
                </details>
              </section>
            </div>
            {error !== '' && <p className={css.editorError}>{error}</p>}
            <footer>
              <span>{editingId === undefined ? '只需资源和标题即可保存' : '修改会立即用于后续检索'}</span>
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  void save()
                }}
              >
                保存
              </button>
            </footer>
          </section>
        </div>
      )}
      <Modal
        open={pendingDelete !== undefined}
        onClose={() => {
          setPendingDelete(undefined)
        }}
        title="确认删除引用"
        description={
          pendingDelete === undefined ? '' : `删除引用“${pendingDelete.title}”？此操作不可撤销。`
        }
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setPendingDelete(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void removeReference()
              }}
            >
              确认删除
            </Button>
          </>
        }
      />
      {previewing === undefined ? null : <ReferencePreviewDialog item={previewing}
        onClose={() => { setPreviewing(undefined) }} />}
    </div>
  )
}

function TrashAvatar({ item }: { item: AgentVaultTrashItem }) {
  const [failed, setFailed] = useState(false)
  return <div className={css.trashAvatar} aria-hidden="true">
    {item.avatar && !failed
      ? <img src={item.avatar} alt="" onError={() => { setFailed(true) }} />
      : item.name.trim().slice(0, 1) || '伙'}
  </div>
}

function TrashWorkbench() {
  const [items, setItems] = useState<readonly AgentVaultTrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<
    { kind: 'delete'; item: AgentVaultTrashItem } | { kind: 'empty' } | undefined
  >()
  const load = useCallback(async (): Promise<void> => {
    try {
      setItems(await post<readonly AgentVaultTrashItem[]>('vault/trash/list', {}))
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const restore = async (item: AgentVaultTrashItem): Promise<void> => {
    setBusy(item.id)
    try {
      await post('vault/trash/restore', { id: item.id })
      await companionStore.load(true)
      await load()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      await load()
      setError(message)
    } finally {
      setBusy(undefined)
    }
  }
  const remove = async (): Promise<void> => {
    if (confirm?.kind !== 'delete') return
    setBusy(confirm.item.id)
    try {
      await post('vault/trash/delete', { id: confirm.item.id })
      setConfirm(undefined)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }
  const empty = async (): Promise<void> => {
    setBusy('all')
    try {
      await post('vault/trash/empty', {})
      setConfirm(undefined)
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(undefined)
    }
  }

  return <section className={css.trashWorkbench}>
    <header className={css.trashHeader}>
      <div>
        <span className={css.trashHeadingIcon} aria-hidden="true"><IconTrashOutline16 /></span>
        <span><small>RECOVERABLE AGENT VAULTS</small><strong>回收站</strong>
          <p>统一管理已删除伙伴的完整资料、记忆、能力与资源。</p></span>
      </div>
      <button type="button" className={css.emptyTrashButton} disabled={items.length === 0 || busy !== undefined}
        onClick={() => { setConfirm({ kind: 'empty' }) }}>清空回收站</button>
    </header>
    {error !== '' && <div className={css.trashError} role="alert">{error}</div>}
    {loading ? <div className={css.trashEmpty}><span aria-hidden="true">⌛</span><strong>正在读取回收站</strong></div>
      : items.length === 0 ? <div className={css.trashEmpty}>
        <span aria-hidden="true"><IconTrashOutline16 /></span><strong>回收站是空的</strong>
        <p>删除伙伴或恢复内置伙伴原版后，旧的完整 Agent Vault 会出现在这里。</p>
      </div> : <div className={css.trashGrid}>
        {items.map(item => <article key={item.id} data-blocked={!item.restorable || undefined}>
          <TrashAvatar item={item} />
          <div className={css.trashCardCopy}>
            <div><strong>{item.name}</strong><span>{item.restorable ? '可恢复' : '同 ID 伙伴正在使用'}</span></div>
            <code>{item.agentId}</code>
            <p>删除于 {new Date(item.deletedAt).toLocaleString('zh-CN')}</p>
          </div>
          <div className={css.trashCardActions}>
            <button type="button" disabled={!item.restorable || busy !== undefined}
              title={item.restorable ? '恢复伙伴及完整 Agent Vault' : '当前已有相同 ID 的伙伴，不能覆盖恢复'}
              onClick={() => { void restore(item) }}>{busy === item.id ? '处理中…' : '恢复伙伴'}</button>
            <button type="button" data-danger disabled={busy !== undefined}
              onClick={() => { setConfirm({ kind: 'delete', item }) }}>永久删除</button>
          </div>
        </article>)}
      </div>}
    <Modal open={confirm !== undefined} onClose={() => { if (busy === undefined) setConfirm(undefined) }}
      title={confirm?.kind === 'empty' ? '清空回收站' : '永久删除 Vault'}
      description={confirm?.kind === 'empty'
        ? `将永久删除回收站中的 ${String(items.length)} 个完整 Agent Vault。此操作无法撤销。`
        : confirm?.kind === 'delete'
          ? `将永久删除“${confirm.item.name}”的完整 Agent Vault。此操作无法撤销。`
          : ''}
      footer={<>
        <Button variant="outline" disabled={busy !== undefined} onClick={() => { setConfirm(undefined) }}>取消</Button>
        <Button variant="primary" className={css.confirmTrashButton} disabled={busy !== undefined}
          onClick={() => { if (confirm?.kind === 'empty') void empty(); else void remove() }}>
          {busy === undefined ? '确认永久删除' : '正在删除…'}
        </Button>
      </>} />
  </section>
}

export function KnowledgeVaultPage(props: KnowledgeVaultPageProps) {
  const list = useCompanionStore().companions
  const subscribeOpenRequest = useCallback((listener: () => void) =>
    props.subscribeOpenRequest?.(listener) ?? (() => undefined), [props])
  const getOpenRequest = useCallback(() => props.getOpenRequest?.(), [props])
  const openRequest = useSyncExternalStore(
    subscribeOpenRequest,
    getOpenRequest,
    getOpenRequest,
  )
  const [scope, setScope] = useState('public')
  const [tab, setTab] = useState<VaultTab>('knowledge')
  const [showTree, setShowTree] = useState(true)
  const [showInfo, setShowInfo] = useState(false)
  const [showReferenceFilters, setShowReferenceFilters] = useState(true)
  useEffect(() => {
    void companionStore.load()
  }, [])
  useEffect(() => {
    if (openRequest === undefined) return
    setScope(openRequest.scope)
    setTab('knowledge')
    setShowTree(true)
  }, [openRequest])
  const scopes = useMemo(
    () => [
      {
        id: 'public',
        name: '公共 Agent Vault',
        description: '所有 Agent 共享的认知、能力与资源',
        avatar: '',
        sharedAvatars: list.map(companion => companion.avatar),
      },
      ...list.map(companion => ({
        id: companion.id,
        name: companion.name,
        description: '伙伴完整的自我、记忆、能力与资源',
        avatar: companion.avatar,
      })),
    ],
    [list],
  )
  const selectedScope = scopes.find(item => item.id === scope) ?? scopes[0]
  if (selectedScope === undefined) return null
  return (
    <main className={css.page}>
      <section className={css.main}>
        <header className={css.topbar}>
          {tab === 'trash' ? <div className={css.trashScopeLabel}>
            <span aria-hidden="true"><IconTrashOutline16 /></span>
            <span><strong>统一回收站</strong><small>所有伙伴的完整 Vault 快照</small></span>
          </div> : <ScopeSwitcher options={scopes} value={scope} onChange={setScope} />}
          <nav className={css.vaultTabs} role="tablist" aria-label="知识库内容类型">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'knowledge'}
              onClick={() => { setTab('knowledge') }}
            >
              <span><KnowledgeBookOutline /></span><span><strong>知识文档</strong><small>认知、记忆与方法</small></span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'references'}
              onClick={() => { setTab('references') }}
            >
              <span><ResourceGalleryOutline /></span><span><strong>资源画廊</strong><small>图片、表情与音视频</small></span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'trash'}
              onClick={() => { setTab('trash') }}
            >
              <span><IconTrashOutline16 /></span><span><strong>回收站</strong><small>恢复或永久清理</small></span>
            </button>
          </nav>
          <div className={css.viewControls}>
            <small>{tab === 'trash' ? '范围' : '视图'}</small>
            <div className={css.paneToggles}>
              {tab === 'knowledge' ? <>
                <button
                  type="button"
                  aria-pressed={showTree}
                  onClick={() => { setShowTree(value => !value) }}
                >
                  文件树
                </button>
                <button
                  type="button"
                  aria-pressed={showInfo}
                  onClick={() => { setShowInfo(value => !value) }}
                >
                  页面信息
                </button>
              </> : tab === 'references' ? <button
                type="button"
                aria-pressed={showReferenceFilters}
                onClick={() => { setShowReferenceFilters(value => !value) }}
              >
                筛选栏
              </button> : <small>账户级</small>}
            </div>
          </div>
        </header>
        {tab === 'knowledge' ? (
          <KnowledgeWorkbench
            key={`knowledge:${scope}`}
            scope={scope}
            scopeOption={selectedScope}
            showTree={showTree}
            showInfo={showInfo}
            setShowInfo={setShowInfo}
            {...openRequest?.scope === scope ? { openRequest } : {}}
          />
        ) : tab === 'references' ? (
          <ReferenceWorkbench
            key={`reference:${scope}`}
            scope={scope}
            scopeOption={selectedScope}
            showFilters={showReferenceFilters}
            setShowFilters={setShowReferenceFilters}
          />
        ) : <TrashWorkbench />}
      </section>
    </main>
  )
}
