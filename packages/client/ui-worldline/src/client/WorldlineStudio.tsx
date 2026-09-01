/* oxlint-disable @stylistic/max-len -- JSX keeps compact project-card and dialog rows structurally visible. */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ProjectLibraryPage,
  ProjectRootView,
  ProjectSummary,
  DocumentView,
  RootRelocationPlan,
  TransferJob,
  TrashedProject,
} from '@deepseek-ai/dsh-worldline-project/types'
import type { EntityId, ProjectTemplate, RunId } from '@deepseek-ai/dsh-worldline-standard/types'
import { BuildWorkbench } from './BuildWorkbench.tsx'
import { CanonWorkbench } from './CanonWorkbench.tsx'
import { MapWorkbench } from './MapWorkbench.tsx'
import { SimulationWorkbench } from './SimulationWorkbench.tsx'
import { TextPlayWorkbench } from './TextPlayWorkbench.tsx'
import { useWorldlineEntrance, useWorldlineParallax } from './motion.ts'
import type { EditorDocumentState, WorldlineStudioInjected } from './types.ts'
import css from './WorldlineStudio.module.css'

type StudioTab = 'overview' | 'canon' | 'map' | 'build' | 'simulation' | 'textPlay'
type Dialog = 'create' | 'trash' | 'import' | 'export' | 'root' | undefined

export type WorldlineStudioProps = PropsRuntime<'worldline.main.page'>
  & PropsLocale<'worldlineStudio'>
  & InjectFace<WorldlineStudioInjected>

const TEMPLATES: readonly ProjectTemplate[] = [
  'blank', 'world-encyclopedia', 'character-story', 'social-simulation',
  'civilization-sandbox', 'playable-scenario',
]

function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function projectAccent(project: ProjectSummary): string {
  let value = 0
  for (const character of project.manifest.id) value = (value * 31 + (character.codePointAt(0) ?? 0)) % 360
  return `hsl(${String(value)} 70% 58%)`
}

export function WorldlineStudio(props: WorldlineStudioProps) {
  const [root, setRoot] = useState<ProjectRootView>()
  const [library, setLibrary] = useState<ProjectLibraryPage>()
  const [project, setProject] = useState<ProjectSummary>()
  const [tab, setTab] = useState<StudioTab>('overview')
  const [dialog, setDialog] = useState<Dialog>()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [trashedProjects, setTrashedProjects] = useState<readonly TrashedProject[]>([])
  const [name, setName] = useState('Untitled World')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState<ProjectTemplate>('character-story')
  const [tags, setTags] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [destinationPath, setDestinationPath] = useState('')
  const [includeRuns, setIncludeRuns] = useState(false)
  const [rootPath, setRootPath] = useState('')
  const [relocation, setRelocation] = useState<RootRelocationPlan>()
  const [transfer, setTransfer] = useState<TransferJob>()
  const [documents, setDocuments] = useState<readonly EditorDocumentState[]>([])
  const [activeDocumentPath, setActiveDocumentPath] = useState<string>()
  const [treeRevision, setTreeRevision] = useState(0)
  const [runRevision, setRunRevision] = useState(0)
  const [preferredRun, setPreferredRun] = useState<RunId>()
  const [preferredActor, setPreferredActor] = useState<EntityId>()
  const saveTimers = useRef(new Map<string, number>())
  const motionRoot = useRef<HTMLElement>(null)
  const documentsRef = useRef(documents)
  const activeDocumentPathRef = useRef(activeDocumentPath)
  documentsRef.current = documents
  activeDocumentPathRef.current = activeDocumentPath
  const document = documents.find(item => item.document.path === activeDocumentPath)
  useWorldlineEntrance(motionRoot, [loading, root?.configured, project?.manifest.id, tab, dialog])
  useWorldlineParallax(motionRoot, [loading, root?.configured, project?.manifest.id, tab])

  const loadLibrary = useCallback(async (search = ''): Promise<ProjectLibraryPage> => {
    const page = await props.projects.library({ search: search.trim(), sort: 'updated-desc', limit: 200 })
    setRoot(page.root)
    setLibrary(page)
    return page
  }, [props.projects])

  const initialize = useCallback(async (): Promise<void> => {
    setLoading(true); setError(undefined)
    try {
      const currentRoot = await props.projects.root()
      setRoot(currentRoot)
      setRootPath(currentRoot.path ?? '')
      if (currentRoot.configured) await loadLibrary('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }, [loadLibrary, props.projects])

  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => {
    if (root?.configured !== true) return
    const timer = window.setTimeout(() => { void loadLibrary(query).catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, 180)
    return () => { window.clearTimeout(timer) }
  }, [loadLibrary, query, root?.configured])
  useEffect(() => () => {
    for (const timer of saveTimers.current.values()) window.clearTimeout(timer)
    saveTimers.current.clear()
  }, [])

  const action = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(key); setError(undefined); setNotice(undefined)
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(undefined) }
  }

  const chooseRoot = async (): Promise<void> => {
    const path = await props.pickDirectory()
    if (path === null) return
    await action('root', async () => {
      await props.projects.setRoot({ path, create: true })
      setRootPath(path)
      setProject(undefined)
      await initialize()
    })
  }

  const pollTransfer = async (job: TransferJob): Promise<TransferJob> => {
    let current = job
    setTransfer(current)
    while (current.state === 'queued' || current.state === 'running') {
      await new Promise(resolve => window.setTimeout(resolve, 180))
      current = await props.projects.transfer(current.id)
      setTransfer(current)
    }
    if (current.state === 'failed') throw new Error(current.error ?? 'transfer failed')
    return current
  }

  const saveDocument = useCallback(async (path = activeDocumentPathRef.current): Promise<void> => {
    const item = documentsRef.current.find(candidate => candidate.document.path === path)
    if (item === undefined || item.saveState === 'saving' || item.saveState === 'saved') return
    const timer = saveTimers.current.get(item.document.path)
    if (timer !== undefined) window.clearTimeout(timer)
    saveTimers.current.delete(item.document.path)
    setDocuments(current => current.map(candidate => candidate.document.path === item.document.path
      ? { document: candidate.document, content: candidate.content, saveState: 'saving' }
      : candidate))
    try {
      const saved = await props.projects.write({
        projectId: item.document.projectId,
        path: item.document.path,
        content: item.content,
        expectedRevision: item.document.revision,
        tags: item.document.tags,
        ...(item.document.objectKind === undefined ? {} : { objectKind: item.document.objectKind }),
      })
      setDocuments(current => current.map(candidate => candidate.document.path === saved.path
        ? { document: saved, content: candidate.content, saveState: 'saved' }
        : candidate))
      setTreeRevision(value => value + 1)
    } catch (reason) {
      let diskVersion: DocumentView | undefined
      try { diskVersion = await props.projects.read({ projectId: item.document.projectId, path: item.document.path }) } catch {}
      setDocuments(current => current.map(candidate => candidate.document.path === item.document.path
        ? {
          ...candidate,
          saveState: diskVersion === undefined ? 'error' : 'conflict',
          error: reason instanceof Error ? reason.message : String(reason),
          ...(diskVersion === undefined ? {} : { diskVersion }),
        }
        : candidate))
    }
  }, [props.projects])

  const openPath = useCallback(async (path: string): Promise<void> => {
    const active = documentsRef.current.find(item => item.document.path === activeDocumentPathRef.current)
    if (active?.document.path === path) return
    if (active?.saveState === 'dirty') await saveDocument(active.document.path)
    if (project === undefined) return
    if (documentsRef.current.some(item => item.document.path === path)) {
      setActiveDocumentPath(path)
      return
    }
    const next = await props.projects.read({ projectId: project.manifest.id, path })
    setDocuments(current => [...current, { document: next, content: next.content, saveState: 'saved' }])
    setActiveDocumentPath(path)
  }, [project, props.projects, saveDocument])

  const editDocument = (content: string): void => {
    const path = activeDocumentPathRef.current
    if (path === undefined) return
    setDocuments(current => current.map(item => item.document.path === path ? {
      document: item.document,
      content,
      saveState: content === item.document.content ? 'saved' : 'dirty',
    } : item))
    const previous = saveTimers.current.get(path)
    if (previous !== undefined) window.clearTimeout(previous)
    saveTimers.current.set(path, window.setTimeout(() => {
      saveTimers.current.delete(path)
      void saveDocument(path)
    }, 700))
  }

  const retryLocalVersion = async (): Promise<void> => {
    const path = activeDocumentPathRef.current
    const item = documentsRef.current.find(candidate => candidate.document.path === path)
    if (item?.diskVersion === undefined) return
    const saved = await props.projects.write({
      projectId: item.document.projectId,
      path: item.document.path,
      content: item.content,
      expectedRevision: item.diskVersion.revision,
      tags: item.document.tags,
      ...(item.document.objectKind === undefined ? {} : { objectKind: item.document.objectKind }),
    })
    setDocuments(current => current.map(candidate => candidate.document.path === saved.path
      ? { document: saved, content: saved.content, saveState: 'saved' }
      : candidate))
  }

  const useDiskVersion = (): void => {
    const path = activeDocumentPathRef.current
    if (path === undefined) return
    setDocuments(current => current.map(item => item.document.path === path && item.diskVersion !== undefined
      ? { document: item.diskVersion, content: item.diskVersion.content, saveState: 'saved' }
      : item))
  }

  const closeDocument = async (path: string): Promise<void> => {
    const item = documentsRef.current.find(candidate => candidate.document.path === path)
    if (item?.saveState === 'dirty') await saveDocument(path)
    const timer = saveTimers.current.get(path)
    if (timer !== undefined) window.clearTimeout(timer)
    saveTimers.current.delete(path)
    setDocuments((current) => {
      const index = current.findIndex(candidate => candidate.document.path === path)
      const next = current.filter(candidate => candidate.document.path !== path)
      if (activeDocumentPathRef.current === path) {
        setActiveDocumentPath(next[Math.min(Math.max(0, index), next.length - 1)]?.document.path)
      }
      return next
    })
  }

  useEffect(() => {
    if (project === undefined || documents.length === 0) return
    let current = true
    const inspect = async (): Promise<void> => {
      const open = documentsRef.current
      const disk = await Promise.all(open.map(async (item) => {
        try { return await props.projects.read({ projectId: project.manifest.id, path: item.document.path }) }
        catch { return undefined }
      }))
      if (!current) return
      setDocuments(existing => existing.map((item) => {
        const next = disk.find(candidate => candidate?.path === item.document.path)
        if (next === undefined || next.revision === item.document.revision) return item
        if (item.saveState === 'saved') return { document: next, content: next.content, saveState: 'saved' }
        if (item.saveState === 'conflict' && item.diskVersion?.revision === next.revision) return item
        return { ...item, saveState: 'conflict', error: props.t('externalChange'), diskVersion: next }
      }))
    }
    const timer = window.setInterval(() => { void inspect() }, 3000)
    return () => { current = false; window.clearInterval(timer) }
  }, [documents.length, project, props.projects, props.t])

  const closeProject = (): void => {
    for (const item of documentsRef.current) void saveDocument(item.document.path)
    setProject(undefined); setDocuments([]); setActiveDocumentPath(undefined); setTab('overview'); setPreferredRun(undefined); setPreferredActor(undefined)
  }

  if (loading) return <main ref={motionRoot} className={css.center}><span className={css.spinner} /><p>{props.t('loading')}</p></main>
  if (root?.configured !== true) return <main ref={motionRoot} className={css.onboarding}>
    <div className={css.orbit} data-worldline-orbit aria-hidden="true"><span>◇</span></div>
    <span className={css.kicker}>WORLDLINE BOX</span><h1>{props.t('chooseRoot')}</h1><p>{props.t('chooseRootHint')}</p>
    {error !== undefined && <div className={css.error} role="alert">{props.t('rootError')}: {error}</div>}
    <button type="button" disabled={busy !== undefined} onClick={() => { void chooseRoot() }}>{props.t('chooseDirectory')}</button>
    <small>{props.t('local')}</small>
  </main>

  if (project === undefined) return <main ref={motionRoot} className={css.library}>
    <header className={css.libraryHeader} data-worldline-hero data-worldline-depth="1">
      <div><span className={css.kicker}>WORLDLINE BOX</span><h1>{props.t('title')}</h1><p>{props.t('subtitle')}</p></div>
      <div className={css.headerActions}><button type="button" onClick={() => { setDialog('import') }}>{props.t('importProject')}</button><button type="button" data-primary onClick={() => { setDialog('create') }}>{props.t('newProject')}</button></div>
    </header>
    <section className={css.libraryTools} data-worldline-reveal>
      <div className={css.search}><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={props.t('search')} /></div>
      <span>{library?.total ?? 0} {props.t('documents')}</span>
      <button type="button" onClick={() => { void action('rescan', async () => { await pollTransfer(await props.projects.rescan()); await loadLibrary() }) }}>{props.t('rescan')}</button>
      <button type="button" onClick={() => { setRootPath(root.path ?? ''); setDialog('root') }}>{props.t('rootSettings')}</button>
      <button type="button" onClick={() => { void action('trash-list', async () => { setTrashedProjects(await props.projects.listTrashedProjects()); setDialog('trash') }) }}>{props.t('trashBin')}</button>
    </section>
    {error !== undefined && <div className={css.error} role="alert">{props.t('error')}: {error}</div>}
    {library?.projects.length === 0 ? <section className={css.emptyLibrary} data-worldline-hero><span>◎</span><h2>{props.t('noProjects')}</h2><p>{props.t('noProjectsHint')}</p><button type="button" onClick={() => { setDialog('create') }}>{props.t('newProject')}</button></section> : <section className={css.projectGrid} data-worldline-stagger>
      {library?.projects.map(item => <article key={item.manifest.id} style={{ '--project-accent': projectAccent(item) } as CSSProperties}>
        <button type="button" className={css.projectCover} onClick={() => { setProject(item) }} aria-label={`${props.t('open')} ${item.manifest.name}`}>
          {item.manifest.cover === undefined ? <span>{item.manifest.name.slice(0, 1).toUpperCase()}</span> : <img src={item.manifest.cover} alt="" />}
          <i>{item.status}</i>
        </button>
        <div className={css.projectInfo}><h2>{item.manifest.name}</h2><p>{item.manifest.description || item.manifest.template}</p><div>{item.manifest.tags.map(tag => <span key={tag}>{tag}</span>)}</div><small>{item.documentCount} docs · {bytes(item.sizeBytes)} · {new Date(item.manifest.updatedAt).toLocaleDateString()}</small></div>
        <div className={css.cardActions}><button type="button" onClick={() => { setProject(item) }}>{props.t('open')}</button><button type="button" aria-label={props.t('copy')} onClick={() => { const copyName = window.prompt(props.t('projectName'), `${item.manifest.name} Copy`); if (copyName !== null && copyName.trim() !== '') void action(`copy:${item.manifest.id}`, async () => { await props.projects.copyProject({ projectId: item.manifest.id, name: copyName.trim() }); await loadLibrary() }) }}>⧉</button><button type="button" aria-label={props.t('exportProject')} onClick={() => { setProject(item); setDestinationPath(`${item.path}.tar.gz`); setDialog('export') }}>⇧</button><button type="button" aria-label={props.t('trash')} onClick={() => { if (window.confirm(`${props.t('trash')} “${item.manifest.name}”?`)) void action(`trash:${item.manifest.id}`, async () => { await props.projects.trashProject({ projectId: item.manifest.id }); await loadLibrary() }) }}>⌫</button></div>
      </article>)}
    </section>}
    <DialogSurface open={dialog !== undefined} title={dialog === 'create' ? props.t('newProject') : dialog === 'import' ? props.t('importProject') : dialog === 'root' ? props.t('rootSettings') : props.t('trashBin')} close={() => { setDialog(undefined) }}>
      {dialog === 'create' && <form onSubmit={(event) => { event.preventDefault(); void action('create', async () => { const created = await props.projects.create({ name: name.trim(), description: description.trim(), template, tags: tags.split(',').map(value => value.trim()).filter(Boolean) }); setDialog(undefined); await loadLibrary(); setProject(created) }) }}>
        <Field label={props.t('projectName')}><input required value={name} onChange={(event) => { setName(event.target.value) }} /></Field><Field label={props.t('description')}><textarea value={description} onChange={(event) => { setDescription(event.target.value) }} /></Field><Field label={props.t('template')}><select value={template} onChange={(event) => { setTemplate(event.target.value as ProjectTemplate) }}>{TEMPLATES.map(value => <option key={value}>{value}</option>)}</select></Field><Field label={props.t('tags')}><input value={tags} onChange={(event) => { setTags(event.target.value) }} placeholder="fantasy, city, mystery" /></Field><DialogActions cancel={() => { setDialog(undefined) }} submit={props.t('create')} busy={busy !== undefined} />
      </form>}
      {dialog === 'import' && <form onSubmit={(event) => { event.preventDefault(); void action('import', async () => { await pollTransfer(await props.projects.importProject({ source: sourcePath.trim() })); setDialog(undefined); await loadLibrary() }) }}><Field label={props.t('sourcePath')}><input required value={sourcePath} onChange={(event) => { setSourcePath(event.target.value) }} placeholder="C:\\Worlds\\archive.tar.gz" /></Field><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} submit={props.t('importProject')} busy={busy !== undefined} /></form>}
      {dialog === 'root' && <form onSubmit={(event) => { event.preventDefault(); void action('relocate', async () => { await props.projects.setRoot({ path: rootPath.trim(), create: true }); setDialog(undefined); setRelocation(undefined); await initialize() }) }}><Field label={props.t('projectPath')}><div className={css.pathPicker}><input required value={rootPath} onChange={(event) => { setRootPath(event.target.value) }} /><button type="button" onClick={() => { void props.pickDirectory().then((path) => { if (path !== null) setRootPath(path) }) }}>…</button></div></Field><button type="button" onClick={() => { void action('dry-run', async () => { setRelocation(await props.projects.setRoot({ path: rootPath.trim(), create: true, dryRun: true })) }) }}>{props.t('dryRun')}</button>{relocation !== undefined && <div className={css.relocation}><p>{relocation.projects.length} projects · {bytes(relocation.requiredBytes)}</p>{relocation.conflicts.map(value => <p key={value}>{value}</p>)}</div>}<DialogActions cancel={() => { setDialog(undefined) }} submit={props.t('applyRelocation')} busy={busy !== undefined} /></form>}
      {dialog === 'trash' && <ul className={css.trashList}>{trashedProjects.map(item => <li key={item.trashId}><div><strong>{item.manifest?.name ?? item.originalName}</strong><small>{new Date(item.deletedAt).toLocaleString()} · {bytes(item.sizeBytes)}</small></div><button type="button" onClick={() => { void action(`restore:${item.trashId}`, async () => { await props.projects.restoreProject({ trashId: item.trashId }); setTrashedProjects(await props.projects.listTrashedProjects()); await loadLibrary() }) }}>{props.t('restore')}</button></li>)}</ul>}
    </DialogSurface>
  </main>

  const tabs: readonly StudioTab[] = ['overview', 'canon', 'map', 'build', 'simulation', 'textPlay']
  return <main ref={motionRoot} className={css.workspace}>
    <header className={css.workspaceHeader} data-worldline-reveal>
      <button type="button" className={css.back} onClick={closeProject}>‹ <span>{props.t('back')}</span></button>
      <div className={css.projectIdentity}><i style={{ background: projectAccent(project) }}>{project.manifest.name.slice(0, 1).toUpperCase()}</i><div><strong>{project.manifest.name}</strong><small>{project.status} · {project.health}</small></div></div>
      <nav>{tabs.map(value => <button type="button" key={value} data-active={tab === value || undefined} onClick={() => { setTab(value) }}>{props.t(value)}</button>)}</nav>
      <button type="button" className={css.more} onClick={() => { setDestinationPath(`${project.path}.tar.gz`); setDialog('export') }}>•••</button>
    </header>
    <section className={css.workspaceContent} data-worldline-hero>
      {tab === 'overview' && <Overview project={project} t={props.t} openFolder={() => props.openPath(project.path)} launchConversation={() => props.launchConversation(project)} navigate={setTab} />}
      {tab === 'canon' && <CanonWorkbench {...props} project={project} openDocuments={documents} activePath={activeDocumentPath} openPath={openPath} activatePath={setActiveDocumentPath} closePath={closeDocument} editDocument={editDocument} saveDocument={() => saveDocument()} useDiskVersion={useDiskVersion} retryLocalVersion={retryLocalVersion} treeRevision={treeRevision} refreshTree={() => { setTreeRevision(value => value + 1) }} />}
      {tab === 'map' && <MapWorkbench t={props.t} document={document} editDocument={editDocument} saveDocument={saveDocument} />}
      {tab === 'build' && <BuildWorkbench t={props.t} project={project} compiler={props.compiler} onFrozen={() => { setRunRevision(value => value + 1); void loadLibrary('').then((page) => { setProject(current => page.projects.find(item => item.manifest.id === current?.manifest.id) ?? current) }) }} />}
      {tab === 'simulation' && <SimulationWorkbench t={props.t} project={project} runs={props.runs} ai={props.ai} runRevision={runRevision} onRunsChanged={() => { setRunRevision(value => value + 1) }} onOpenTextPlay={(runId, actorId) => { setPreferredRun(runId); setPreferredActor(actorId); setTab('textPlay') }} />}
      {tab === 'textPlay' && <TextPlayWorkbench t={props.t} project={project} runs={props.runs} narrative={props.narrative} preferredRunId={preferredRun} preferredActorId={preferredActor} />}
    </section>
    <DialogSurface open={dialog === 'export'} title={props.t('exportProject')} close={() => { setDialog(undefined) }}><form onSubmit={(event) => { event.preventDefault(); void action('export', async () => { await pollTransfer(await props.projects.exportProject({ projectId: project.manifest.id, destination: destinationPath.trim(), includeRuns })); setDialog(undefined); setNotice(destinationPath.trim()) }) }}><Field label={props.t('destinationPath')}><input required value={destinationPath} onChange={(event) => { setDestinationPath(event.target.value) }} /></Field><label className={css.checkbox}><input type="checkbox" checked={includeRuns} onChange={(event) => { setIncludeRuns(event.target.checked) }} />{props.t('includeRuns')}</label><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} submit={props.t('exportProject')} busy={busy !== undefined} /></form></DialogSurface>
    {notice !== undefined && <button type="button" className={css.toast} onClick={() => { setNotice(undefined) }}>{notice}</button>}
    {error !== undefined && <button type="button" className={`${css.toast} ${css.toastError}`} onClick={() => { setError(undefined) }}>{props.t('error')}: {error}</button>}
  </main>
}

function Overview({ project, t, openFolder, launchConversation, navigate }: { readonly project: ProjectSummary; readonly t: WorldlineStudioProps['t']; readonly openFolder: () => Promise<void>; readonly launchConversation: () => Promise<void>; readonly navigate: (tab: StudioTab) => void }) {
  return <div className={css.overview}>
    <section className={css.overviewHero}><div><span>WORLDLINE PROJECT</span><h1>{project.manifest.name}</h1><p>{project.manifest.description || project.manifest.template}</p><div>{project.manifest.tags.map(tag => <i key={tag}>{tag}</i>)}</div></div><div className={css.projectGlyph} data-worldline-depth="2" style={{ '--project-accent': projectAccent(project) } as CSSProperties}>{project.manifest.name.slice(0, 1).toUpperCase()}</div></section>
    <section className={css.overviewStats}><div><small>{t('status')}</small><strong>{project.status}</strong></div><div><small>{t('documents')}</small><strong>{project.documentCount}</strong></div><div><small>{t('size')}</small><strong>{bytes(project.sizeBytes)}</strong></div><div><small>{t('updated')}</small><strong>{new Date(project.manifest.updatedAt).toLocaleDateString()}</strong></div></section>
    <div className={css.overviewGrid}><section><h2>{t('projectPath')}</h2><code>{project.path}</code><button type="button" onClick={() => { void openFolder() }}>{t('openFolder')}</button><button type="button" data-primary onClick={() => { void launchConversation() }}>{t('chatWithAuthor')}</button></section><section><h2>Workflow</h2>{(['canon', 'map', 'build', 'simulation', 'textPlay'] as const).map((value, index) => <button type="button" key={value} onClick={() => { navigate(value) }}><span>{String(index + 1).padStart(2, '0')}</span><strong>{t(value)}</strong><i>→</i></button>)}</section></div>
  </div>
}

function DialogSurface({ open, title, close, children }: { readonly open: boolean; readonly title: string; readonly close: () => void; readonly children: ReactNode }) {
  if (!open) return null
  return <div className={css.dialogBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section className={css.dialog} role="dialog" aria-modal="true" aria-label={title} data-worldline-hero><header><h2>{title}</h2><button type="button" onClick={close}>×</button></header>{children}</section></div>
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) { return <label className={css.field}><span>{label}</span>{children}</label> }
function DialogActions({ cancel, submit, busy }: { readonly cancel: () => void; readonly submit: string; readonly busy: boolean }) { return <div className={css.dialogActions}><button type="button" onClick={cancel}>Cancel</button><button type="submit" data-primary disabled={busy}>{busy ? '…' : submit}</button></div> }
function TransferProgress({ transfer }: { readonly transfer?: TransferJob | undefined }) { if (transfer === undefined) return null; const percent = transfer.totalBytes === undefined || transfer.totalBytes === 0 ? undefined : Math.round(transfer.completedBytes / transfer.totalBytes * 100); return <div className={css.transfer}><span>{transfer.state}</span><i><b style={{ width: `${String(percent ?? 8)}%` }} /></i><small>{bytes(transfer.completedBytes)}{transfer.totalBytes === undefined ? '' : ` / ${bytes(transfer.totalBytes)}`}</small></div> }
