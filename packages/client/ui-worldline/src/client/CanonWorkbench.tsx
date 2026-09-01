/* oxlint-disable @stylistic/max-len -- JSX keeps each compact file/audit row structurally visible. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DocumentHistoryEntry,
  ProjectLink,
  ProjectSearchHit,
  ProjectSummary,
  ProjectTreeEntry,
} from '@deepseek-ai/dsh-worldline-project/types'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import type { EditorDocumentState, ProjectClient } from './types.ts'
import css from './CanonWorkbench.module.css'

type ViewMode = 'edit' | 'preview' | 'split'
type SidePanel = 'details' | 'history' | 'backlinks' | 'trash'

interface CanonWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly projects: ProjectClient
  readonly openDocument: EditorDocumentState | undefined
  readonly openPath: (path: string) => Promise<void>
  readonly editDocument: (content: string) => void
  readonly saveDocument: () => Promise<void>
  readonly useDiskVersion: () => void
  readonly retryLocalVersion: () => Promise<void>
  readonly treeRevision: number
  readonly refreshTree: () => void
}

function joinPath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function TreeBranch({
  project,
  projects,
  directory,
  revision,
  active,
  onOpen,
  onSelect,
}: {
  readonly project: ProjectSummary
  readonly projects: ProjectClient
  readonly directory: string
  readonly revision: number
  readonly active?: string | undefined
  readonly onOpen: (path: string) => void
  readonly onSelect: (entry: ProjectTreeEntry) => void
}): ReactNode {
  const [entries, setEntries] = useState<readonly ProjectTreeEntry[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string>()
  useEffect(() => {
    let current = true
    void projects.tree({ projectId: project.manifest.id, path: directory })
      .then((value) => { if (current) { setEntries(value.entries); setError(undefined) } })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { current = false }
  }, [directory, project.manifest.id, projects, revision])
  if (error !== undefined) return <p className={css.treeError}>{error}</p>
  return <ul className={css.treeList} data-nested={directory !== '' || undefined}>
    {entries.map((entry) => {
      const open = expanded.has(entry.path)
      return <li key={entry.id}>
        <button
          type="button"
          className={css.treeEntry}
          data-active={active === entry.path || undefined}
          onClick={() => {
            onSelect(entry)
            if (entry.kind === 'directory') {
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(entry.path)) next.delete(entry.path)
                else next.add(entry.path)
                return next
              })
            } else if (entry.kind === 'document') onOpen(entry.path)
          }}
        >
          <span aria-hidden="true">{entry.kind === 'directory' ? (open ? '▾' : '▸') : '◇'}</span>
          <span>{entry.name}</span>
          {entry.tags.length > 0 && <small>{entry.tags.length}</small>}
        </button>
        {entry.kind === 'directory' && open && <TreeBranch
          project={project}
          projects={projects}
          directory={entry.path}
          revision={revision}
          active={active}
          onOpen={onOpen}
          onSelect={onSelect}
        />}
      </li>
    })}
  </ul>
}

export function CanonWorkbench(props: CanonWorkbenchProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [sidePanel, setSidePanel] = useState<SidePanel>('details')
  const [selected, setSelected] = useState<ProjectTreeEntry>()
  const [query, setQuery] = useState('')
  const [searchHits, setSearchHits] = useState<readonly ProjectSearchHit[]>([])
  const [history, setHistory] = useState<readonly DocumentHistoryEntry[]>([])
  const [backlinks, setBacklinks] = useState<readonly ProjectLink[]>([])
  const [trash, setTrash] = useState<readonly import('@deepseek-ai/dsh-worldline-project/types').TrashedEntry[]>([])
  const [newPath, setNewPath] = useState('canon/new-document.md')
  const [notice, setNotice] = useState<string>()
  const searchGeneration = useRef(0)
  const projectId = props.project.manifest.id
  const activePath = props.openDocument?.document.path

  useEffect(() => {
    const normalized = query.trim()
    const generation = ++searchGeneration.current
    if (normalized === '') { setSearchHits([]); return }
    const timer = window.setTimeout(() => {
      void props.projects.search({ projectId, query: normalized, limit: 40 })
        .then((value) => { if (searchGeneration.current === generation) setSearchHits(value) })
        .catch(() => { if (searchGeneration.current === generation) setSearchHits([]) })
    }, 180)
    return () => { window.clearTimeout(timer) }
  }, [projectId, props.projects, query])

  const loadSidePanel = useCallback(async (panel: SidePanel): Promise<void> => {
    setSidePanel(panel)
    if (panel === 'trash') {
      setTrash(await props.projects.listTrashedEntries(projectId))
      return
    }
    if (activePath === undefined) return
    if (panel === 'history') setHistory(await props.projects.history({ projectId, path: activePath, limit: 100 }))
    if (panel === 'backlinks') setBacklinks(await props.projects.backlinks({ projectId, path: activePath }))
  }, [activePath, projectId, props.projects])

  const createDocument = async (): Promise<void> => {
    const path = newPath.trim().replace(/\\/gu, '/')
    if (path === '') return
    try {
      await props.projects.write({
        projectId,
        path,
        content: `# ${basename(path).replace(/\.md$/iu, '')}\n`,
        createParents: true,
      })
      props.refreshTree()
      await props.openPath(path)
      setNotice(undefined)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const createDirectory = async (): Promise<void> => {
    const path = newPath.trim().replace(/\\/gu, '/').replace(/\.md$/iu, '')
    if (path === '') return
    try {
      await props.projects.createDirectory({ projectId, path })
      props.refreshTree()
      setNotice(undefined)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const moveSelected = async (): Promise<void> => {
    if (selected === undefined) return
    const destination = window.prompt(props.t('renameMove'), selected.path)
    if (destination === null || destination.trim() === '' || destination === selected.path) return
    try {
      await props.projects.move({
        projectId,
        source: selected.path,
        destination: destination.trim().replace(/\\/gu, '/'),
        ...(selected.revision === undefined ? {} : { expectedRevision: selected.revision }),
      })
      setSelected(undefined)
      props.refreshTree()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }

  const copySelected = async (): Promise<void> => {
    if (selected === undefined) return
    const suggestion = joinPath(parentPath(selected.path), `copy-${selected.name}`)
    const destination = window.prompt(props.t('duplicateEntry'), suggestion)
    if (destination === null || destination.trim() === '') return
    try {
      await props.projects.copyEntry({ projectId, source: selected.path, destination: destination.trim() })
      props.refreshTree()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }

  const trashSelected = async (): Promise<void> => {
    if (selected === undefined || !window.confirm(`${props.t('trash')} “${selected.name}”?`)) return
    try {
      await props.projects.trashEntry({
        projectId,
        path: selected.path,
        ...(selected.revision === undefined ? {} : { expectedRevision: selected.revision }),
      })
      setSelected(undefined)
      props.refreshTree()
      if (activePath === selected.path) setNotice(props.t('trash'))
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }

  const document = props.openDocument
  return <div className={css.workbench}>
    <aside className={css.treePane} aria-label={props.t('files')}>
      <div className={css.searchBox}>
        <span aria-hidden="true">⌕</span>
        <input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={props.t('searchInProject')} />
      </div>
      {query.trim() !== '' ? <ul className={css.searchResults}>
        {searchHits.map(hit => <li key={hit.id}><button type="button" onClick={() => { void props.openPath(hit.path) }}>
          <strong>{hit.title}</strong><small>{hit.path}</small><span>{hit.excerpt}</span>
        </button></li>)}
      </ul> : <TreeBranch
        project={props.project}
        projects={props.projects}
        directory=""
        revision={props.treeRevision}
        active={activePath}
        onOpen={(path) => { void props.openPath(path) }}
        onSelect={setSelected}
      />}
      <div className={css.createBar}>
        <input aria-label={props.t('path')} value={newPath} onChange={(event) => { setNewPath(event.target.value) }} />
        <button type="button" title={props.t('createFile')} onClick={() => { void createDocument() }}>＋</button>
        <button type="button" title={props.t('createFolder')} onClick={() => { void createDirectory() }}>▱</button>
      </div>
    </aside>

    <section className={css.editorPane}>
      {document === undefined ? <div className={css.emptyEditor}>
        <span aria-hidden="true">◇</span><h2>{props.t('files')}</h2><p>{props.t('autosave')}</p>
      </div> : <>
        <header className={css.editorHeader}>
          <div><strong>{basename(document.document.path)}</strong><small>{document.document.path}</small></div>
          <div className={css.editorActions}>
            <span data-state={document.saveState}>{props.t(document.saveState === 'error' ? 'error' : document.saveState)}</span>
            {(['edit', 'preview', 'split'] as const).map(mode => <button
              type="button" key={mode} data-active={viewMode === mode || undefined}
              onClick={() => { setViewMode(mode) }}
            >{props.t(mode)}</button>)}
            <button type="button" onClick={() => { void props.saveDocument() }}>{props.t('save')}</button>
          </div>
        </header>
        {document.saveState === 'conflict' && <div className={css.conflictBanner} role="alert">
          <strong>{props.t('conflict')}</strong><span>{document.error}</span>
          <button type="button" onClick={props.useDiskVersion}>{props.t('restoreServer')}</button>
          <button type="button" onClick={() => { void props.retryLocalVersion() }}>{props.t('overwrite')}</button>
        </div>}
        <div className={css.documentSurface} data-mode={viewMode}>
          {viewMode !== 'preview' && <MarkdownEditor
            value={document.content}
            onChange={props.editDocument}
            onSave={() => { void props.saveDocument() }}
            ariaLabel={`${props.t('edit')}: ${document.document.path}`}
          />}
          {viewMode !== 'edit' && <article className={css.preview}><MarkdownText text={document.content} /></article>}
        </div>
      </>}
    </section>

    <aside className={css.inspector}>
      <nav>
        {(['details', 'history', 'backlinks', 'trash'] as const).map(panel => <button
          type="button" key={panel} data-active={sidePanel === panel || undefined}
          onClick={() => { void loadSidePanel(panel) }}
        >{panel === 'details' ? props.t('overview') : props.t(panel === 'trash' ? 'trashBin' : panel)}</button>)}
      </nav>
      {sidePanel === 'details' && <div className={css.inspectorBody}>
        <h3>{selected?.name ?? document?.document.path ?? props.project.manifest.name}</h3>
        {selected !== undefined && <>
          <dl><dt>{props.t('path')}</dt><dd>{selected.path}</dd><dt>{props.t('size')}</dt><dd>{selected.sizeBytes.toLocaleString()} B</dd><dt>{props.t('updated')}</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></dl>
          <div className={css.stackActions}>
            <button type="button" onClick={() => { void moveSelected() }}>{props.t('renameMove')}</button>
            <button type="button" onClick={() => { void copySelected() }}>{props.t('duplicateEntry')}</button>
            <button type="button" data-danger onClick={() => { void trashSelected() }}>{props.t('deleteEntry')}</button>
          </div>
        </>}
        {document !== undefined && <><p>{document.document.objectKind ?? 'document'}</p><div className={css.tags}>{document.document.tags.map(tag => <span key={tag}>{tag}</span>)}</div></>}
      </div>}
      {sidePanel === 'history' && <ul className={css.auditList}>{history.map(item => <li key={item.revision}>
        <div><strong>{item.reason}</strong><small>{new Date(item.savedAt).toLocaleString()}</small></div>
        <button type="button" disabled={document === undefined} onClick={() => {
          if (document === undefined) return
          void props.projects.restoreRevision({ projectId, path: document.document.path, revision: item.revision, expectedRevision: document.document.revision })
            .then(() => props.openPath(document.document.path)).then(props.refreshTree)
        }}>{props.t('restore')}</button>
      </li>)}</ul>}
      {sidePanel === 'backlinks' && <ul className={css.auditList}>{backlinks.map(link => <li key={`${link.sourceId}:${link.target}`}>
        <button type="button" onClick={() => { void props.openPath(link.sourcePath) }}><strong>{link.sourcePath}</strong><small>{link.kind}{link.broken ? ' · broken' : ''}</small></button>
      </li>)}</ul>}
      {sidePanel === 'trash' && <ul className={css.auditList}>{trash.map(item => <li key={item.trashId}>
        <div><strong>{item.originalPath}</strong><small>{new Date(item.deletedAt).toLocaleString()}</small></div>
        <button type="button" onClick={() => { void props.projects.restoreEntry({ projectId, trashId: item.trashId }).then(() => { props.refreshTree(); return loadSidePanel('trash') }) }}>{props.t('restore')}</button>
      </li>)}</ul>}
      {notice !== undefined && <p className={css.notice} role="alert">{notice}</p>}
    </aside>
  </div>
}
