/* oxlint-disable @stylistic/max-len -- JSX keeps each compact file/audit row structurally visible. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
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
import { CanonObjectView } from './CanonObjectView.tsx'
import { useWorldlineEntrance } from './motion.ts'
import type { EditorDocumentState, ProjectClient } from './types.ts'
import css from './CanonWorkbench.module.css'

type ViewMode = 'edit' | 'object' | 'preview' | 'split'
type SidePanel = 'details' | 'history' | 'backlinks' | 'trash'

interface CanonWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly projects: ProjectClient
  readonly openDocuments: readonly EditorDocumentState[]
  readonly activePath?: string | undefined
  readonly openPath: (path: string) => Promise<void>
  readonly activatePath: (path: string) => void
  readonly closePath: (path: string) => Promise<void>
  readonly editDocument: (content: string) => void
  readonly saveDocument: () => Promise<void>
  readonly useDiskVersion: () => void
  readonly retryLocalVersion: () => Promise<void>
  readonly treeRevision: number
  readonly refreshTree: () => void
}

interface EntryClipboard {
  readonly mode: 'copy' | 'cut'
  readonly entry: ProjectTreeEntry
}

interface EntryOperation {
  readonly kind: 'move' | 'copy' | 'trash'
  readonly entry: ProjectTreeEntry
  readonly destination: string
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

export async function uploadProjectEntry(
  projectId: ProjectSummary['manifest']['id'],
  directory: string,
  file: File,
): Promise<void> {
  const query = new URLSearchParams({
    projectId,
    path: joinPath(directory, file.name),
    expectedBytes: String(file.size),
  })
  const response = await fetch(`/api/worldline/project/upload?${query.toString()}`, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'project entry upload failed')
  }
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
  const [clipboard, setClipboard] = useState<EntryClipboard>()
  const [operation, setOperation] = useState<EntryOperation>()
  const [importing, setImporting] = useState(0)
  const [notice, setNotice] = useState<string>()
  const searchGeneration = useRef(0)
  const motionRoot = useRef<HTMLDivElement>(null)
  const projectId = props.project.manifest.id
  const activePath = props.activePath
  useWorldlineEntrance(motionRoot, [activePath, sidePanel, viewMode])

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

  const applyOperation = async (): Promise<void> => {
    if (operation === undefined) return
    const destination = operation.destination.trim().replace(/\\/gu, '/')
    try {
      if (operation.kind === 'move') await props.projects.move({
        projectId, source: operation.entry.path, destination,
        ...(operation.entry.revision === undefined ? {} : { expectedRevision: operation.entry.revision }),
      })
      if (operation.kind === 'copy') await props.projects.copyEntry({
        projectId, source: operation.entry.path, destination,
      })
      if (operation.kind === 'trash') await props.projects.trashEntry({
        projectId, path: operation.entry.path,
        ...(operation.entry.revision === undefined ? {} : { expectedRevision: operation.entry.revision }),
      })
      if (operation.kind === 'trash' && activePath === operation.entry.path) {
        await props.closePath(operation.entry.path)
      }
      setSelected(undefined)
      setOperation(undefined)
      props.refreshTree()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }

  const pasteClipboard = async (): Promise<void> => {
    if (clipboard === undefined) return
    const directory = selected?.kind === 'directory' ? selected.path : parentPath(selected?.path ?? activePath ?? '')
    const destination = joinPath(directory, clipboard.entry.name)
    if (destination === clipboard.entry.path) {
      setNotice(props.t('pasteSamePath'))
      return
    }
    try {
      if (clipboard.mode === 'copy') await props.projects.copyEntry({ projectId, source: clipboard.entry.path, destination })
      else await props.projects.move({
        projectId, source: clipboard.entry.path, destination,
        ...(clipboard.entry.revision === undefined ? {} : { expectedRevision: clipboard.entry.revision }),
      })
      if (clipboard.mode === 'cut') setClipboard(undefined)
      props.refreshTree()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }

  const importFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    const directory = selected?.kind === 'directory' ? selected.path : parentPath(selected?.path ?? activePath ?? '')
    setImporting(files.length)
    setNotice(undefined)
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        if (file === undefined) continue
        setImporting(files.length - index)
        await uploadProjectEntry(projectId, directory, file)
      }
      props.refreshTree()
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setImporting(0)
    }
  }

  const selectFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    void importFiles([...event.currentTarget.files ?? []])
    event.currentTarget.value = ''
  }

  const dropFiles = (event: DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    void importFiles([...event.dataTransfer.files])
  }

  const document = props.openDocuments.find(item => item.document.path === activePath)
  return <div ref={motionRoot} className={css.workbench}>
    <aside className={css.treePane} aria-label={props.t('files')} data-worldline-reveal data-importing={importing > 0 || undefined} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={dropFiles}>
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
        <label title={props.t('importFiles')}>⇩<input type="file" multiple onChange={selectFiles} /></label>
      </div>
      {importing > 0 && <div className={css.dropStatus} role="status">{props.t('importingFiles')} · {importing}</div>}
    </aside>

    <section className={css.editorPane} data-worldline-hero>
      {document === undefined ? <div className={css.emptyEditor}>
        <span aria-hidden="true">◇</span><h2>{props.t('files')}</h2><p>{props.t('autosave')}</p>
      </div> : <>
        <nav className={css.documentTabs} aria-label={props.t('openDocuments')} data-worldline-stagger>
          {props.openDocuments.map(item => <div key={item.document.path} data-active={item.document.path === activePath || undefined}>
            <button type="button" onClick={() => { props.activatePath(item.document.path) }}>
              <span>{basename(item.document.path)}</span><i data-state={item.saveState}>{item.saveState === 'saved' ? '' : '●'}</i>
            </button>
            <button type="button" aria-label={`${props.t('close')} ${basename(item.document.path)}`} onClick={() => { void props.closePath(item.document.path) }}>×</button>
          </div>)}
        </nav>
        <header className={css.editorHeader}>
          <div><strong>{basename(document.document.path)}</strong><small>{document.document.path}</small></div>
          <div className={css.editorActions}>
            <span data-state={document.saveState}>{props.t(document.saveState === 'error' ? 'error' : document.saveState)}</span>
            {(['edit', 'object', 'preview', 'split'] as const).map(mode => <button
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
          {viewMode !== 'preview' && viewMode !== 'object' && <MarkdownEditor
            value={document.content}
            onChange={props.editDocument}
            onSave={() => { void props.saveDocument() }}
            ariaLabel={`${props.t('edit')}: ${document.document.path}`}
          />}
          {viewMode === 'object' && <CanonObjectView path={document.document.path} content={document.content} explicitKind={document.document.objectKind} documentId={document.document.id} revision={document.document.revision} tags={document.document.tags} t={props.t} />}
          {(viewMode === 'preview' || viewMode === 'split') && <article className={css.preview}><MarkdownText text={document.content} /></article>}
        </div>
      </>}
    </section>

    <aside className={css.inspector} data-worldline-reveal>
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
            <button type="button" onClick={() => { setOperation({ kind: 'move', entry: selected, destination: selected.path }) }}>{props.t('renameMove')}</button>
            <button type="button" onClick={() => { setOperation({ kind: 'copy', entry: selected, destination: joinPath(parentPath(selected.path), `copy-${selected.name}`) }) }}>{props.t('duplicateEntry')}</button>
            <div className={css.inlineActions}><button type="button" onClick={() => { setClipboard({ mode: 'cut', entry: selected }) }}>{props.t('cut')}</button><button type="button" onClick={() => { setClipboard({ mode: 'copy', entry: selected }) }}>{props.t('copy')}</button></div>
            <button type="button" data-danger onClick={() => { setOperation({ kind: 'trash', entry: selected, destination: '' }) }}>{props.t('deleteEntry')}</button>
          </div>
        </>}
        {clipboard !== undefined && <div className={css.clipboard}>
          <span>{props.t(clipboard.mode)}: {clipboard.entry.path}</span>
          <button type="button" onClick={() => { void pasteClipboard() }}>{props.t('paste')}</button>
          <button type="button" onClick={() => { setClipboard(undefined) }}>{props.t('cancel')}</button>
        </div>}
        {operation !== undefined && <form className={css.operation} onSubmit={(event) => { event.preventDefault(); void applyOperation() }}>
          <strong>{props.t(operation.kind === 'trash' ? 'deleteEntry' : operation.kind === 'move' ? 'renameMove' : 'duplicateEntry')}</strong>
          <span>{operation.entry.path}</span>
          {operation.kind !== 'trash' && <input autoFocus value={operation.destination} onChange={(event) => { setOperation({ ...operation, destination: event.target.value }) }} aria-label={props.t('destinationPath')} />}
          {operation.kind === 'trash' && <p>{props.t('trashConfirm')}</p>}
          <div><button type="button" onClick={() => { setOperation(undefined) }}>{props.t('cancel')}</button><button type="submit" data-danger={operation.kind === 'trash' || undefined} disabled={operation.kind !== 'trash' && operation.destination.trim() === ''}>{props.t('confirm')}</button></div>
        </form>}
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
