/* oxlint-disable @stylistic/max-len -- JSX keeps compact project-card and dialog rows structurally visible. */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type {
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { PathPickerRequest } from '@deepseek-ai/dsh-client-runtime/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  ProjectLibraryPage,
  ProjectImportConflict,
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
import {
  chineseDate,
  templateDescription,
  templateLabel,
  worldlineLabel,
} from './presentation.ts'
import type { EditorDocumentState, WorldlineStudioInjected } from './types.ts'
import css from './WorldlineStudio.module.css'

type StudioTab = 'overview' | 'canon' | 'map' | 'build' | 'simulation' | 'textPlay'
type Dialog =
  | 'create'
  | 'copy'
  | 'trash'
  | 'trash-project'
  | 'import'
  | 'export'
  | 'root'
  | 'import-blueprint'
  | 'export-blueprint'
  | 'import-run'
  | 'export-run'
  | undefined

type PathFlowTarget = {
  readonly field: 'bind' | 'relocate' | 'source' | 'destination'
  readonly request: PathPickerRequest
}

export type WorldlineStudioProps = PropsRuntime<'worldline.main.page'>
  & PropsRenderSlots<'host.directoryFlow'>
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

function archiveFileName(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '')
  return normalized === '' ? '未命名世界' : normalized
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
  const [projectActionTarget, setProjectActionTarget] = useState<ProjectSummary>()
  const [name, setName] = useState('未命名世界')
  const [copyName, setCopyName] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState<ProjectTemplate>('character-story')
  const [tags, setTags] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [importConflict, setImportConflict] = useState<ProjectImportConflict>('copy')
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
  const [archiveRunId, setArchiveRunId] = useState<RunId>()
  const [pathTarget, setPathTarget] = useState<PathFlowTarget>()
  const saveTimers = useRef(new Map<string, number>())
  const documentsRef = useRef(documents)
  const activeDocumentPathRef = useRef(activeDocumentPath)
  documentsRef.current = documents
  activeDocumentPathRef.current = activeDocumentPath
  const document = documents.find(item => item.document.path === activeDocumentPath)

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

  const chooseRoot = (): void => {
    setPathTarget({ field: 'bind', request: { mode: 'directory', title: props.t('chooseRoot') } })
  }

  const chooseArchive = (title: string, extensions: readonly string[]): void => {
    setPathTarget({ field: 'source', request: { mode: 'open-file', title, extensions } })
  }

  const chooseDestination = (title: string, suggestedName: string, extensions: readonly string[]): void => {
    setPathTarget({ field: 'destination', request: { mode: 'save-file', title, suggestedName, extensions } })
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

  const navigateStudio = (next: StudioTab): void => {
    setTab(next)
    if (next !== 'map') return
    const mapSource = documentsRef.current.find(item => item.content.includes('```worldline-map'))
      ?? documentsRef.current.find(item => item.document.path.startsWith('maps/'))
    if (mapSource !== undefined) {
      setActiveDocumentPath(mapSource.document.path)
      return
    }
    void action('open-map', async () => { await openPath('maps/world.md') })
  }

  const directoryFlowOwner: DirectoryFlowOwnerProps = {
    request: pathTarget?.request ?? { mode: 'directory', title: props.t('chooseDirectory') },
    open: pathTarget !== undefined,
    busy: busy !== undefined,
    onPicked: (path) => {
      const target = pathTarget?.field
      setPathTarget(undefined)
      if (target === 'source') { setSourcePath(path); return }
      if (target === 'destination') { setDestinationPath(path); return }
      if (target === 'relocate') {
        setRootPath(path)
        return
      }
      if (target !== 'bind') return
      void action('root', async () => {
        await props.projects.setRoot({ path, create: true })
        setRootPath(path)
        setProject(undefined)
        await initialize()
      })
    },
    onCancel: () => { setPathTarget(undefined) },
    onError: (message) => { setPathTarget(undefined); setError(message) },
  }
  const withDirectoryFlow = (content: ReactNode): ReactNode => <>{content}
    {props.renderSlot('host.directoryFlow', directoryFlowOwner)}
  </>

  if (loading) return withDirectoryFlow(<main className={css.center}><span className={css.spinner} /><p>{props.t('loading')}</p></main>)
  if (root?.configured !== true) return withDirectoryFlow(<main className={css.onboarding}>
    <Atmosphere />
    <section className={css.onboardingCard}>
      <div className={css.storyEmblem} aria-hidden="true"><span>✦</span><i>世界线</i></div>
      <span className={css.kicker}>原创世界创作工坊</span>
      <h1>{props.t('chooseRoot')}</h1>
      <p>{props.t('chooseRootHint')}</p>
      <div className={css.promiseRow}>
        <span><i>01</i>角色与设定</span><span><i>02</i>世界演算</span><span><i>03</i>故事游玩</span>
      </div>
      {error !== undefined && <div className={css.error} role="alert">{props.t('rootError')}: {error}</div>}
      <button type="button" aria-label={props.t('chooseDirectory')} disabled={busy !== undefined} onClick={chooseRoot}><span>选择本地创作目录</span><i>→</i></button>
      <small>{props.t('localPromise')}</small>
    </section>
    <aside className={css.onboardingNotes} aria-hidden="true">
      <article><span>角色手记</span><strong>“她为什么踏上旅途？”</strong><i>等待你写下答案</i></article>
      <article><span>世界天气</span><strong>晴空与微风</strong><i>故事适合启程</i></article>
    </aside>
  </main>)

  if (project === undefined) return withDirectoryFlow(<main className={css.library}>
    <Atmosphere />
    <header className={css.libraryHero}>
      <div className={css.libraryHeroCopy}><span className={css.kicker}>世界线 · 原创世界工坊</span><h1>{props.t('libraryGreeting')}</h1><p>{props.t('libraryLead')}</p><small>{props.t('localPromise')}</small></div>
      <div className={css.headerActions}><button type="button" onClick={() => { setSourcePath(''); setTransfer(undefined); setDialog('import') }}>从世界包导入</button><button type="button" data-primary onClick={() => { setDialog('create') }}>{props.t('newProject')} <i>＋</i></button></div>
      <div className={css.heroConstellation} aria-hidden="true"><i /><i /><i /><span>✦</span></div>
    </header>
    <section className={css.libraryTools}>
      <div className={css.search}><span>⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={props.t('search')} /></div>
      <span>{library?.total ?? 0} {props.t('worldCount')}</span>
      <button type="button" onClick={() => { void action('rescan', async () => { await pollTransfer(await props.projects.rescan()); await loadLibrary() }) }}>{props.t('rescan')}</button>
      <button type="button" onClick={() => { setRootPath(root.path ?? ''); setDialog('root') }}>{props.t('rootSettings')}</button>
      <button type="button" onClick={() => { void action('trash-list', async () => { setTrashedProjects(await props.projects.listTrashedProjects()); setDialog('trash') }) }}>{props.t('trashBin')}</button>
    </section>
    {error !== undefined && <div className={css.error} role="alert">{props.t('error')}: {error}</div>}
    {library?.projects.length === 0 ? <section className={css.emptyLibrary}>
      <div className={css.emptyStorybook} aria-hidden="true"><i /><i /><span>✦</span></div>
      <div><span className={css.kicker}>{props.t('quickStart')}</span><h2>{props.t('noProjects')}</h2><p>{props.t('emptyInspiration')}</p></div>
      <div className={css.templateCards}>{(['character-story', 'world-encyclopedia', 'playable-scenario'] as const).map((value, index) => <button type="button" key={value} onClick={() => { setTemplate(value); setName(index === 0 ? '她与未寄出的信' : index === 1 ? '云海群岛志' : '星港物语'); setDialog('create') }}>
        <i>{['角', '界', '游'][index]}</i><span><strong>{templateLabel(value)}</strong><small>{templateDescription(value)}</small></span><b>→</b>
      </button>)}</div>
      <button type="button" className={css.blankStart} onClick={() => { setTemplate('blank'); setName('未命名世界'); setDialog('create') }}>或从空白世界开始</button>
    </section> : <><header className={css.sectionTitle}><div><span>✦</span><h2>{props.t('recentWorlds')}</h2></div><small>{library?.total ?? 0} {props.t('worldCount')}</small></header><section className={css.projectGrid}>
      {library?.projects.map(item => <article key={item.manifest.id} style={{ '--project-accent': projectAccent(item) } as CSSProperties}>
        <button type="button" className={css.projectCover} onClick={() => { setProject(item) }} aria-label={`${props.t('open')} ${item.manifest.name}`}>
          {item.manifest.cover === undefined ? <><span>{item.manifest.name.slice(0, 1).toUpperCase()}</span><b aria-hidden="true">✦</b></> : <img src={item.manifest.cover} alt="" />}
          <i>{worldlineLabel(item.status)}</i>
        </button>
        <div className={css.projectInfo}><h2>{item.manifest.name}</h2><p>{item.manifest.description || templateDescription(item.manifest.template)}</p><div>{item.manifest.tags.map(tag => <span key={tag}>#{tag}</span>)}</div><small>{item.documentCount} 份设定 · {bytes(item.sizeBytes)} · {chineseDate(item.manifest.updatedAt)}</small></div>
        <div className={css.cardActions}><button type="button" onClick={() => { setProject(item) }}>{props.t('open')}</button><button type="button" aria-label={props.t('copy')} onClick={() => { setProjectActionTarget(item); setCopyName(`${item.manifest.name} 副本`); setDialog('copy') }}>⧉</button><button type="button" aria-label={props.t('exportProject')} onClick={() => { setProject(item); setDestinationPath(''); setTransfer(undefined); setDialog('export') }}>⇧</button><button type="button" aria-label={props.t('trash')} onClick={() => { setProjectActionTarget(item); setDialog('trash-project') }}>⌫</button></div>
      </article>)}
    </section></>}
    <DialogSurface open={dialog !== undefined} title={dialog === 'create' ? props.t('newProject') : dialog === 'copy' ? props.t('copyProjectTitle') : dialog === 'trash-project' ? props.t('trashProjectTitle') : dialog === 'import' ? props.t('importProject') : dialog === 'root' ? props.t('rootSettings') : props.t('trashBin')} closeLabel={props.t('close')} close={() => { setDialog(undefined) }}>
      {dialog === 'create' && <form onSubmit={(event) => { event.preventDefault(); void action('create', async () => { const created = await props.projects.create({ name: name.trim(), description: description.trim(), template, tags: tags.split(',').map(value => value.trim()).filter(Boolean) }); setDialog(undefined); await loadLibrary(); setProject(created) }) }}>
        <Field label={props.t('projectName')}><input required value={name} onChange={(event) => { setName(event.target.value) }} /></Field><Field label={props.t('description')}><textarea value={description} onChange={(event) => { setDescription(event.target.value) }} placeholder="用一两句话写下这个世界最想讲述的故事…" /></Field><Field label={props.t('template')}><select value={template} onChange={(event) => { setTemplate(event.target.value as ProjectTemplate) }}>{TEMPLATES.map(value => <option key={value} value={value}>{templateLabel(value)}</option>)}</select><small>{templateDescription(template)}</small></Field><Field label={props.t('tags')}><input value={tags} onChange={(event) => { setTags(event.target.value) }} placeholder="幻想，校园，悬疑" /></Field><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('create')} busy={busy !== undefined} />
      </form>}
      {dialog === 'copy' && projectActionTarget !== undefined && <form onSubmit={(event) => { event.preventDefault(); void action(`copy:${projectActionTarget.manifest.id}`, async () => { await props.projects.copyProject({ projectId: projectActionTarget.manifest.id, name: copyName.trim() }); setDialog(undefined); setProjectActionTarget(undefined); await loadLibrary() }) }}><p>{projectActionTarget.manifest.name}</p><Field label={props.t('projectName')}><input required autoFocus value={copyName} onChange={(event) => { setCopyName(event.target.value) }} /></Field><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('copy')} busy={busy !== undefined || copyName.trim() === ''} /></form>}
      {dialog === 'trash-project' && projectActionTarget !== undefined && <form onSubmit={(event) => { event.preventDefault(); void action(`trash:${projectActionTarget.manifest.id}`, async () => { await props.projects.trashProject({ projectId: projectActionTarget.manifest.id }); setDialog(undefined); setProjectActionTarget(undefined); await loadLibrary() }) }}><div className={css.confirmation}><strong>{projectActionTarget.manifest.name}</strong><p>{props.t('trashProjectHint')}</p></div><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('trash')} busy={busy !== undefined} danger /></form>}
      {dialog === 'import' && <form onSubmit={(event) => { event.preventDefault(); void action('import', async () => { await pollTransfer(await props.projects.importProject({ source: sourcePath.trim(), conflict: importConflict })); setDialog(undefined); await loadLibrary() }) }}><PathField label={props.t('sourcePath')} value={sourcePath} onChange={setSourcePath} chooseLabel={props.t('chooseArchive')} onChoose={() => { chooseArchive(props.t('chooseProjectArchive'), ['worldline.zip']) }} /><Field label={props.t('importConflict')}><select value={importConflict} onChange={(event) => { setImportConflict(event.target.value as ProjectImportConflict) }}><option value="copy">{props.t('importAsCopy')}</option><option value="replace">{props.t('replaceRecoverably')}</option><option value="cancel">{props.t('cancelOnConflict')}</option></select></Field><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('importProject')} busy={busy !== undefined || sourcePath.trim() === ''} /></form>}
      {dialog === 'root' && <form onSubmit={(event) => { event.preventDefault(); void action('relocate', async () => { await props.projects.setRoot({ path: rootPath.trim(), create: true }); setDialog(undefined); setRelocation(undefined); await initialize() }) }}><PathField label={props.t('projectPath')} value={rootPath} onChange={setRootPath} chooseLabel={props.t('chooseDirectory')} onChoose={() => { setPathTarget({ field: 'relocate', request: { mode: 'directory', title: props.t('chooseRoot') } }) }} /><button type="button" onClick={() => { void action('dry-run', async () => { setRelocation(await props.projects.setRoot({ path: rootPath.trim(), create: true, dryRun: true })) }) }}>{props.t('dryRun')}</button>{relocation !== undefined && <div className={css.relocation}><p>{relocation.projects.length} 个项目 · {bytes(relocation.requiredBytes)}</p>{relocation.conflicts.map(value => <p key={value}>{value}</p>)}</div>}<DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('applyRelocation')} busy={busy !== undefined} /></form>}
      {dialog === 'trash' && <ul className={css.trashList}>{trashedProjects.map(item => <li key={item.trashId}><div><strong>{item.manifest?.name ?? item.originalName}</strong><small>{new Date(item.deletedAt).toLocaleString()} · {bytes(item.sizeBytes)}</small></div><button type="button" onClick={() => { void action(`restore:${item.trashId}`, async () => { await props.projects.restoreProject({ trashId: item.trashId }); setTrashedProjects(await props.projects.listTrashedProjects()); await loadLibrary() }) }}>{props.t('restore')}</button></li>)}</ul>}
    </DialogSurface>
  </main>)

  const tabs: readonly StudioTab[] = ['overview', 'canon', 'map', 'build', 'simulation', 'textPlay']
  return withDirectoryFlow(<main className={css.workspace}>
    <header className={css.workspaceHeader}>
      <button type="button" className={css.back} onClick={closeProject}>‹ <span>{props.t('back')}</span></button>
      <div className={css.projectIdentity}><i style={{ background: projectAccent(project) }}>{project.manifest.name.slice(0, 1).toUpperCase()}</i><div><strong>{project.manifest.name}</strong><small>{worldlineLabel(project.status)} · {worldlineLabel(project.health)}</small></div></div>
      <nav>{tabs.map(value => <button type="button" key={value} data-active={tab === value || undefined} onClick={() => { navigateStudio(value) }}>{props.t(value)}</button>)}</nav>
      <button type="button" className={css.more} onClick={() => { setDestinationPath(''); setTransfer(undefined); setDialog('export') }}>•••</button>
    </header>
    <section className={css.workspaceContent}>
      {tab === 'overview' && <Overview project={project} t={props.t} openFolder={() => props.openPath(project.path)} launchConversation={() => props.launchConversation(project)} navigate={navigateStudio} />}
      {tab === 'canon' && <CanonWorkbench {...props} project={project} openDocuments={documents} activePath={activeDocumentPath} openPath={openPath} activatePath={setActiveDocumentPath} closePath={closeDocument} editDocument={editDocument} saveDocument={() => saveDocument()} useDiskVersion={useDiskVersion} retryLocalVersion={retryLocalVersion} treeRevision={treeRevision} refreshTree={() => { setTreeRevision(value => value + 1) }} />}
      {tab === 'map' && <MapWorkbench t={props.t} document={document} editDocument={editDocument} saveDocument={saveDocument} />}
      {tab === 'build' && <BuildWorkbench t={props.t} project={project} compiler={props.compiler} onImportBlueprint={() => { setSourcePath(''); setTransfer(undefined); setDialog('import-blueprint') }} onExportBlueprint={() => { setDestinationPath(''); setTransfer(undefined); setDialog('export-blueprint') }} onFrozen={() => { setRunRevision(value => value + 1); void loadLibrary('').then((page) => { setProject(current => page.projects.find(item => item.manifest.id === current?.manifest.id) ?? current) }) }} />}
      {tab === 'simulation' && <SimulationWorkbench t={props.t} project={project} runs={props.runs} ai={props.ai} runRevision={runRevision} onRunsChanged={() => { setRunRevision(value => value + 1) }} onImportRun={() => { setSourcePath(''); setTransfer(undefined); setDialog('import-run') }} onExportRun={(runId) => { setArchiveRunId(runId); setDestinationPath(''); setTransfer(undefined); setDialog('export-run') }} onOpenTextPlay={(runId, actorId) => { setPreferredRun(runId); setPreferredActor(actorId); setTab('textPlay') }} />}
      {tab === 'textPlay' && <TextPlayWorkbench t={props.t} project={project} runs={props.runs} narrative={props.narrative} preferredRunId={preferredRun} preferredActorId={preferredActor} />}
    </section>
    <DialogSurface open={dialog === 'export'} title={props.t('exportProject')} closeLabel={props.t('close')} close={() => { setDialog(undefined) }}><form onSubmit={(event) => { event.preventDefault(); void action('export', async () => { await pollTransfer(await props.projects.exportProject({ projectId: project.manifest.id, destination: destinationPath.trim(), includeRuns })); setDialog(undefined); setNotice(destinationPath.trim()) }) }}><PathField label={props.t('destinationPath')} value={destinationPath} onChange={setDestinationPath} chooseLabel={props.t('chooseSavePath')} onChoose={() => { chooseDestination(props.t('chooseSavePath'), `${archiveFileName(project.manifest.name)}.worldline.zip`, ['worldline.zip']) }} /><label className={css.checkbox}><input type="checkbox" checked={includeRuns} onChange={(event) => { setIncludeRuns(event.target.checked) }} />{props.t('includeRuns')}</label><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('exportProject')} busy={busy !== undefined || destinationPath.trim() === ''} /></form></DialogSurface>
    <DialogSurface open={dialog === 'import-blueprint'} title={props.t('importBlueprint')} closeLabel={props.t('close')} close={() => { setDialog(undefined) }}><form onSubmit={(event) => { event.preventDefault(); void action('import-blueprint', async () => { await pollTransfer(await props.projects.importBlueprint({ projectId: project.manifest.id, source: sourcePath.trim() })); setDialog(undefined); setRunRevision(value => value + 1); setNotice(props.t('importBlueprint')) }) }}><p>{props.t('blueprintArchiveHint')}</p><PathField label={props.t('sourcePath')} value={sourcePath} onChange={setSourcePath} chooseLabel={props.t('chooseArchive')} onChoose={() => { chooseArchive(props.t('chooseBlueprintArchive'), ['worldline-blueprint.zip']) }} /><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('importBlueprint')} busy={busy !== undefined || sourcePath.trim() === ''} /></form></DialogSurface>
    <DialogSurface open={dialog === 'export-blueprint'} title={props.t('exportBlueprint')} closeLabel={props.t('close')} close={() => { setDialog(undefined) }}><form onSubmit={(event) => { event.preventDefault(); void action('export-blueprint', async () => { await pollTransfer(await props.projects.exportBlueprint({ projectId: project.manifest.id, destination: destinationPath.trim() })); setDialog(undefined); setNotice(destinationPath.trim()) }) }}><p>{props.t('blueprintArchiveHint')}</p><PathField label={props.t('destinationPath')} value={destinationPath} onChange={setDestinationPath} chooseLabel={props.t('chooseSavePath')} onChoose={() => { chooseDestination(props.t('chooseSavePath'), `${archiveFileName(project.manifest.name)}.worldline-blueprint.zip`, ['worldline-blueprint.zip']) }} /><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('exportBlueprint')} busy={busy !== undefined || destinationPath.trim() === ''} /></form></DialogSurface>
    <DialogSurface open={dialog === 'import-run'} title={props.t('importRun')} closeLabel={props.t('close')} close={() => { setDialog(undefined) }}><form onSubmit={(event) => { event.preventDefault(); void action('import-run', async () => { await pollTransfer(await props.projects.importRun({ projectId: project.manifest.id, source: sourcePath.trim() })); setDialog(undefined); setRunRevision(value => value + 1); setNotice(props.t('importRun')) }) }}><p>{props.t('runArchiveHint')}</p><PathField label={props.t('sourcePath')} value={sourcePath} onChange={setSourcePath} chooseLabel={props.t('chooseArchive')} onChoose={() => { chooseArchive(props.t('chooseRunArchive'), ['worldline-run.zip']) }} /><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('importRun')} busy={busy !== undefined || sourcePath.trim() === ''} /></form></DialogSurface>
    <DialogSurface open={dialog === 'export-run'} title={props.t('exportRun')} closeLabel={props.t('close')} close={() => { setDialog(undefined) }}><form onSubmit={(event) => { event.preventDefault(); if (archiveRunId === undefined) return; void action('export-run', async () => { await pollTransfer(await props.projects.exportRun({ projectId: project.manifest.id, runId: archiveRunId, destination: destinationPath.trim() })); setDialog(undefined); setNotice(destinationPath.trim()) }) }}><p>{props.t('runArchiveHint')}</p><PathField label={props.t('destinationPath')} value={destinationPath} onChange={setDestinationPath} chooseLabel={props.t('chooseSavePath')} onChoose={() => { chooseDestination(props.t('chooseSavePath'), `${archiveFileName(project.manifest.name)}-${archiveFileName(archiveRunId ?? '运行')}.worldline-run.zip`, ['worldline-run.zip']) }} /><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('exportRun')} busy={busy !== undefined || archiveRunId === undefined || destinationPath.trim() === ''} /></form></DialogSurface>
    {notice !== undefined && <button type="button" className={css.toast} onClick={() => { setNotice(undefined) }}>{notice}</button>}
    {error !== undefined && <button type="button" className={`${css.toast} ${css.toastError}`} onClick={() => { setError(undefined) }}>{props.t('error')}: {error}</button>}
  </main>)
}

function Overview({ project, t, openFolder, launchConversation, navigate }: { readonly project: ProjectSummary; readonly t: WorldlineStudioProps['t']; readonly openFolder: () => Promise<void>; readonly launchConversation: () => Promise<void>; readonly navigate: (tab: StudioTab) => void }) {
  return <div className={css.overview}>
    <section className={css.overviewHero}><div><span>{t('projectHome')}</span><h1>{project.manifest.name}</h1><p>{project.manifest.description || templateDescription(project.manifest.template)}</p><div>{project.manifest.tags.map(tag => <i key={tag}>#{tag}</i>)}</div><section><button type="button" aria-label={t('chatWithAuthor')} data-primary onClick={() => { void launchConversation() }}>✦ {t('chatWithAuthor')}</button><button type="button" onClick={() => { navigate('canon') }}>{t('beginJourney')} →</button></section></div><div className={css.projectGlyph} style={{ '--project-accent': projectAccent(project) } as CSSProperties}><small>世界编号</small><strong>{project.manifest.name.slice(0, 1).toUpperCase()}</strong><i>{worldlineLabel(project.status)}</i></div></section>
    <section className={css.overviewStats}><div><small>{t('status')}</small><strong>{worldlineLabel(project.status)}</strong><i>当前世界可继续创作</i></div><div><small>{t('documents')}</small><strong>{project.documentCount}</strong><i>份世界真源</i></div><div><small>{t('size')}</small><strong>{bytes(project.sizeBytes)}</strong><i>本地创作内容</i></div><div><small>{t('updated')}</small><strong>{chineseDate(project.manifest.updatedAt)}</strong><i>最近一次落笔</i></div></section>
    <header className={css.journeyTitle}><div><span>✦</span><h2>{t('workflow')}</h2></div><p>{t('workflowHint')}</p></header>
    <section className={css.journeyGrid}>{(['canon', 'map', 'build', 'simulation', 'textPlay'] as const).map((value, index) => <button type="button" key={value} data-accent={value} onClick={() => { navigate(value) }}><i>{['书', '境', '验', '演', '游'][index]}</i><span><small>第 {String(index + 1)} 站</small><strong>{t(value)}</strong><em>{['编写角色、地点和世界规则', '让地点与路径真正参与结算', '检查来源、冲突与可运行性', '观察角色与系统持续演化', '从角色视角走进你的故事'][index]}</em></span><b>→</b></button>)}</section>
    <div className={css.overviewGrid}><section><h2>{t('projectPath')}</h2><code>{project.path}</code><button type="button" onClick={() => { void openFolder() }}>{t('openFolder')}</button></section><section><h2>{t('projectHomeHint')}</h2><p>{templateDescription(project.manifest.template)}</p><span>{templateLabel(project.manifest.template)}</span></section></div>
  </div>
}

function Atmosphere(): ReactNode {
  return <div className={css.atmosphere} aria-hidden="true">
    <i /><i />
  </div>
}

function DialogSurface({ open, title, closeLabel = title, close, children }: { readonly open: boolean; readonly title: string; readonly closeLabel?: string; readonly close: () => void; readonly children: ReactNode }) {
  const surface = useRef<HTMLElement>(null)
  const closeRef = useRef(close)
  const titleId = useId()
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = (): HTMLElement[] => surface.current === null ? [] : [...surface.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    const initialFocus = surface.current?.querySelector<HTMLElement>('[autofocus]')
      ?? focusable()[0]
      ?? surface.current
    initialFocus?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const elements = focusable()
      const first = elements[0]
      const last = elements.at(-1)
      if (first === undefined || last === undefined) { event.preventDefault(); surface.current?.focus(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); document.body.style.overflow = previousOverflow; previousFocus?.focus() }
  }, [open])
  if (!open) return null
  return createPortal(<div className={css.dialogBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section ref={surface} className={css.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><h2 id={titleId}>{title}</h2><button type="button" aria-label={closeLabel} onClick={close}>×</button></header>{children}</section></div>, document.body)
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) { return <label className={css.field}><span>{label}</span>{children}</label> }
function PathField({ label, value, onChange, chooseLabel, onChoose }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly chooseLabel: string; readonly onChoose: () => void }) { return <Field label={label}><div className={css.pathPicker}><input required value={value} onChange={(event) => { onChange(event.target.value) }} /><button type="button" onClick={onChoose}>{chooseLabel}</button></div></Field> }
function DialogActions({ cancel, cancelText, submit, busy, danger = false }: { readonly cancel: () => void; readonly cancelText: string; readonly submit: string; readonly busy: boolean; readonly danger?: boolean }) { return <div className={css.dialogActions}><button type="button" onClick={cancel}>{cancelText}</button><button type="submit" data-primary={!danger || undefined} data-danger={danger || undefined} disabled={busy}>{busy ? '…' : submit}</button></div> }
function TransferProgress({ transfer }: { readonly transfer?: TransferJob | undefined }) { if (transfer === undefined) return null; const percent = transfer.totalBytes === undefined || transfer.totalBytes === 0 ? undefined : Math.round(transfer.completedBytes / transfer.totalBytes * 100); return <div className={css.transfer}><span>{worldlineLabel(transfer.state)}</span><i><b style={{ width: `${String(percent ?? 8)}%` }} /></i><small>{bytes(transfer.completedBytes)}{transfer.totalBytes === undefined ? '' : ` / ${bytes(transfer.totalBytes)}`}</small></div> }
