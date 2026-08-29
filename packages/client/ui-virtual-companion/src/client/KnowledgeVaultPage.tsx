import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import {
  Button,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconSearchOutline16,
  MarkdownText,
  Modal,
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

type VaultTab = 'knowledge' | 'references'
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
export interface KnowledgeVaultPageInjected {}
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

function MarkdownEditor({
  value,
  onChange,
  onSave,
}: {
  value: string
  onChange: (value: string) => void
  onSave: () => void
}) {
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
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                save.current()
                return true
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString())
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: 'ui-monospace,SFMono-Regular,Cascadia Code,Consolas,monospace',
            },
            '.cm-content': { padding: '18px 0 48px' },
            '.cm-line': { padding: '0 18px' },
            '.cm-gutters': {
              backgroundColor: '#f8fafc',
              color: '#9aa6b2',
              border: 'none',
              borderRight: '1px solid #edf0f4',
            },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [])
  useEffect(() => {
    const editor = view.current
    if (editor === null || editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])
  return <div ref={host} className={css.editorSurface} />
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

function TreeBranch({
  scope,
  directory,
  onOpen,
  active,
  revision,
}: {
  scope: string
  directory: string
  onOpen: (path: string) => void
  active?: string
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
  if (directory !== '' && !open)
    return (
      <button
        type="button"
        className={css.treeFolder}
        onClick={() => {
          setOpen(true)
        }}
      >
        <span className={css.treeChevron}><IconChevronRightOutline14 /></span>
        <span className={css.treeGlyph}><IconFolderClose16 /></span>
        {directory.replace(/^.*\//u, '')}
      </button>
    )
  return (
    <div className={directory === '' ? css.treeRoot : css.treeChildren}>
      {directory !== '' && (
        <button
          type="button"
          className={css.treeFolder}
          onClick={() => {
            setOpen(false)
          }}
        >
          <span className={css.treeChevron}><IconChevronDownOutline14 /></span>
          <span className={css.treeGlyph}><IconFolderOpen16 /></span>
          {directory.replace(/^.*\//u, '')}
        </button>
      )}
      {entries.map(entry =>
        entry.kind === 'directory' ? (
          <TreeBranch
            key={entry.path}
            scope={scope}
            directory={entry.path}
            onOpen={onOpen}
            revision={revision}
            {...(active === undefined ? {} : { active })}
          />
        ) : (
          <button
            type="button"
            key={entry.path}
            className={css.treeFile}
            aria-current={active === entry.path}
            title={entry.path}
            onClick={() => {
              onOpen(entry.path)
            }}
          >
            <span className={css.treeChevron} />
            <span className={css.treeFileGlyph}><MarkdownDocumentOutline /></span>
            <span className={css.treeName}>{entry.name}</span>
          </button>
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
  setShowTree,
  setShowInfo,
}: {
  scope: string
  scopeOption: KnowledgeScopeOption
  showTree: boolean
  showInfo: boolean
  setShowTree: (visible: boolean) => void
  setShowInfo: (visible: boolean) => void
}) {
  const [documents, setDocuments] = useState<OpenDocument[]>([])
  const documentsRef = useRef<OpenDocument[]>([])
  const [activePath, setActivePath] = useState<string>()
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([])
  const [treeRevision, setTreeRevision] = useState(0)
  const [creating, setCreating] = useState(false)
  const [newPageTitle, setNewPageTitle] = useState('')
  const [createError, setCreateError] = useState('')
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
  }, [scope])
  const create = async (): Promise<void> => {
    const title = newPageTitle.trim()
    if (title === '') return
    try {
      const document = await post<KnowledgeDocument>('knowledge/create', {
        scope,
        folder: 'pages',
        title,
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
      setTreeRevision(value => value + 1)
      setCreating(false)
      setNewPageTitle('')
      setCreateError('')
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const search = async (): Promise<void> => {
    if (query.trim() === '') {
      setSearchResults([])
      return
    }
    const results = await post<KnowledgeSearchResult[]>('knowledge/search', {
      scope,
      query,
      limit: 30,
    })
    setSearchResults(results)
  }
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
  return (
    <div
      className={css.knowledgeWorkbench}
      data-tree-open={showTree}
      data-info-open={showInfo}
    >
      {showTree && <aside className={css.filePane}>
        <div className={css.paneTitle}>
          <strong>文件</strong>
          <div>
            <button
              type="button"
              onClick={() => {
                setNewPageTitle('')
                setCreateError('')
                setCreating(true)
              }}
              title="新建 Markdown"
            >
              <IconPlusOutline16 />
            </button>
            <button
              type="button"
              aria-label="收起文件树"
              onClick={() => { setShowTree(false) }}
              title="收起文件树"
            >
              ×
            </button>
          </div>
        </div>
        <form
          className={css.vaultSearch}
          onSubmit={(event) => {
            event.preventDefault()
            void search()
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
        <div className={css.fileTree}>
          {searchResults.length > 0 ? (
            searchResults.map(result => (
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
            ))
          ) : (
            <TreeBranch
              scope={scope}
              directory=""
              onOpen={(path) => {
                void openDocument(path)
              }}
              revision={treeRevision}
              {...(activePath === undefined ? {} : { active: activePath })}
            />
          )}
        </div>
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
                setNewPageTitle('')
                setCreateError('')
                setCreating(true)
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
              <div className={css.viewModes}>
                {(['edit', 'preview', 'split'] as const).map(mode => (
                  <button
                    type="button"
                    key={mode}
                    aria-pressed={active.viewMode === mode}
                    onClick={() => {
                      setDocuments(current =>
                        current.map(item =>
                          item.document.path === active.document.path
                            ? { ...item, viewMode: mode }
                            : item,
                        ),
                      )
                    }}
                  >
                    {mode === 'edit' ? '编辑' : mode === 'preview' ? '预览' : '分屏'}
                  </button>
                ))}
              </div>
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
                <MarkdownEditor
                  value={active.content}
                  onChange={(content) => {
                    edit(active.document.path, content)
                  }}
                  onSave={() => {
                    void saveNow(active.document.path)
                  }}
                />
              )}
              {active.viewMode !== 'edit' && (
                <div className={css.preview}>
                  <MarkdownText text={active.content} />
                </div>
              )}
            </div>
          </>
        )}
      </section>
      {showInfo && <aside className={css.infoPane}>
        <div className={css.paneTitle}>
          <strong>页面信息</strong>
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
          <p>打开页面后显示标题、标签、双链和来源。</p>
        ) : (
          <div className={css.infoContent}>
            <label>标签</label>
            <div className={css.tagList}>
              {active.document.tags.map(tag => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
            <label>出链</label>
            {active.document.links.map(link => (
              <button
                type="button"
                key={link}
                onClick={() => {
                  void openDocument(link.endsWith('.md') ? link : `${link}.md`)
                }}
              >
                [[{link}]]
              </button>
            ))}
            <label>来源</label>
            {active.document.sources.length === 0 ? (
              <p>尚未声明来源</p>
            ) : (
              active.document.sources.map(source => <span key={source}>{source}</span>)
            )}
          </div>
        )}
      </aside>}
      <Modal
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
        title="新建知识页"
        description="页面将作为 Markdown 文件保存到当前知识库。"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setCreating(false)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={newPageTitle.trim() === ''}
              onClick={() => {
                void create()
              }}
            >
              创建
            </Button>
          </>
        }
      >
        <label className={css.newPageField}>
          页面标题
          <input
            autoFocus
            value={newPageTitle}
            onChange={(event) => {
              setNewPageTitle(event.currentTarget.value)
              setCreateError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && newPageTitle.trim() !== '') {
                event.preventDefault()
                void create()
              }
            }}
          />
        </label>
        {createError !== '' && <p className={css.editorError}>{createError}</p>}
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
    </div>
  )
}

export function KnowledgeVaultPage(_props: KnowledgeVaultPageProps) {
  const list = useCompanionStore().companions
  const [scope, setScope] = useState('public')
  const [tab, setTab] = useState<VaultTab>('knowledge')
  const [showTree, setShowTree] = useState(true)
  const [showInfo, setShowInfo] = useState(false)
  const [showReferenceFilters, setShowReferenceFilters] = useState(true)
  useEffect(() => {
    void companionStore.load()
  }, [])
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
          <ScopeSwitcher options={scopes} value={scope} onChange={setScope} />
          <div className={css.topbarActions}>
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
              </> : <button
                type="button"
                aria-pressed={showReferenceFilters}
                onClick={() => { setShowReferenceFilters(value => !value) }}
              >
                筛选栏
              </button>}
            </div>
            <nav>
              <button
                type="button"
                aria-current={tab === 'knowledge'}
                onClick={() => {
                  setTab('knowledge')
                }}
              >
                认知与记忆
              </button>
              <button
                type="button"
                aria-current={tab === 'references'}
                onClick={() => {
                  setTab('references')
                }}
              >
                资源画廊
              </button>
            </nav>
          </div>
        </header>
        {tab === 'knowledge' ? (
          <KnowledgeWorkbench
            key={`knowledge:${scope}`}
            scope={scope}
            scopeOption={selectedScope}
            showTree={showTree}
            showInfo={showInfo}
            setShowTree={setShowTree}
            setShowInfo={setShowInfo}
          />
        ) : (
          <ReferenceWorkbench
            key={`reference:${scope}`}
            scope={scope}
            scopeOption={selectedScope}
            showFilters={showReferenceFilters}
            setShowFilters={setShowReferenceFilters}
          />
        )}
      </section>
    </main>
  )
}
