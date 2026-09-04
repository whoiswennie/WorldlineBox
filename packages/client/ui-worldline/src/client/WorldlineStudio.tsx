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
  ProjectTreeEntry,
  RootRelocationPlan,
  TransferJob,
  TrashedProject,
} from '@deepseek-ai/dsh-worldline-project/types'
import type { CanonObjectKind, EntityId, JsonObject, JsonValue, ModelRoute, ProjectId, ProjectTemplate, RunId } from '@deepseek-ai/dsh-worldline-standard/types'
import { WORLDLINE_PROJECT_LAYOUT, canonDirectory } from '@deepseek-ai/dsh-worldline-standard/project-layout'
import { ArtworkImage } from './ArtworkImage.tsx'
import { BuildWorkbench } from './BuildWorkbench.tsx'
import { CanonWorkbench } from './CanonWorkbench.tsx'
import { CanonObjectView } from './CanonObjectView.tsx'
import { MapWorkbench } from './MapWorkbench.tsx'
import { SaveManagementWorkbench } from './SaveManagementWorkbench.tsx'
import { StorylineWorkbench } from './StorylineWorkbench.tsx'
import { TextPlayWorkbench } from './TextPlayWorkbench.tsx'
import { artworkSources, DEFAULT_ARTWORK, DEFAULT_CHARACTER_ART, defaultArtwork, randomCharacterArtwork } from './default-artwork.ts'
import { inferCanonObjectKind } from './canon-kind.ts'
import {
  NATIVE_CANON_KINDS,
  NATIVE_CANON_SECTIONS,
  dossierDraft,
  dossierMarkdown,
  dossierPath,
  emptyDossierDraft,
  emptyLocationDraft,
  emptyPlotDraft,
  locationDraft,
  locationMarkdown,
  nativeCanonDefinition,
  plotDraft,
  plotMarkdown,
  type EditableCanonKind,
  type NativeCanonSectionId,
  type NativeDossierDraft,
  type NativeLocationDraft,
  type NativePlotDraft,
} from './nativeOc.ts'
import {
  characterEntityIds,
  characterResources,
  chineseDate,
  entityName,
  projectMediaUrl,
  snapshotEntities,
  templateDescription,
  templateLabel,
  worldlineLabel,
} from './presentation.ts'
import type { EditorDocumentState, WorldlineStudioInjected } from './types.ts'
import { PROJECT_UPLOAD_PATH } from '../contract.ts'
import css from './WorldlineStudio.module.css'

type StudioTab = 'overview' | 'canon' | 'storyline' | 'map' | 'saves' | 'textPlay'
type ArchiveGroup = 'all' | NativeCanonSectionId
type AuthoringMode = 'native' | 'source'
type SourceReturnTab = 'overview' | 'canon' | 'storyline'
type StudioNavigationMemory = {
  readonly projectId?: string
  readonly tab: StudioTab
  readonly authoringMode: AuthoringMode
  readonly sourceReturnTab: SourceReturnTab
  readonly archiveSelectionPath?: string
  readonly archiveFilter: ArchiveGroup
  readonly activeDocumentPath?: string
  readonly overviewScrollTop: number
  readonly archiveIndexScrollTop: number
}
type Dialog =
  | 'create'
  | 'copy'
  | 'trash'
  | 'trash-project'
  | 'empty-trash'
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
const ARCHIVE_GROUPS: readonly ArchiveGroup[] = [
  'all', ...NATIVE_CANON_SECTIONS.map(section => section.id),
]
const STUDIO_NAVIGATION_KEY = 'worldline-studio.navigation.v1'
const DEFAULT_STUDIO_NAVIGATION: StudioNavigationMemory = {
  tab: 'overview',
  authoringMode: 'native',
  sourceReturnTab: 'canon',
  archiveFilter: 'all',
  overviewScrollTop: 0,
  archiveIndexScrollTop: 0,
}

function readStudioNavigation(): StudioNavigationMemory {
  if (typeof window === 'undefined') return DEFAULT_STUDIO_NAVIGATION
  try {
    const value = JSON.parse(window.sessionStorage.getItem(STUDIO_NAVIGATION_KEY) ?? '') as Partial<StudioNavigationMemory>
    return {
      ...DEFAULT_STUDIO_NAVIGATION,
      ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
      ...(value.tab === 'overview' || value.tab === 'canon' || value.tab === 'storyline'
        || value.tab === 'map' || value.tab === 'saves' || value.tab === 'textPlay'
        ? { tab: value.tab } : {}),
      ...(value.authoringMode === 'native' || value.authoringMode === 'source'
        ? { authoringMode: value.authoringMode } : {}),
      ...(value.sourceReturnTab === 'overview' || value.sourceReturnTab === 'canon'
        || value.sourceReturnTab === 'storyline' ? { sourceReturnTab: value.sourceReturnTab } : {}),
      ...(typeof value.archiveSelectionPath === 'string'
        ? { archiveSelectionPath: value.archiveSelectionPath } : {}),
      ...(ARCHIVE_GROUPS.includes(value.archiveFilter as ArchiveGroup)
        ? { archiveFilter: value.archiveFilter as ArchiveGroup } : {}),
      ...(typeof value.activeDocumentPath === 'string'
        ? { activeDocumentPath: value.activeDocumentPath } : {}),
      overviewScrollTop: typeof value.overviewScrollTop === 'number'
        ? Math.max(0, value.overviewScrollTop) : 0,
      archiveIndexScrollTop: typeof value.archiveIndexScrollTop === 'number'
        ? Math.max(0, value.archiveIndexScrollTop) : 0,
    }
  } catch { return DEFAULT_STUDIO_NAVIGATION }
}

function writeStudioNavigation(value: StudioNavigationMemory): void {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.setItem(STUDIO_NAVIGATION_KEY, JSON.stringify(value)) } catch {}
}

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

function assetSlug(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/gu, '')
  return slug === '' ? 'untitled' : slug
}

function assetExtension(file: File): string {
  const extension = /\.([a-z0-9]{1,8})$/iu.exec(file.name)?.[1]?.toLowerCase()
  if (extension !== undefined) return extension
  return file.type.startsWith('audio/') ? 'mp3' : 'png'
}

async function uploadProjectAsset(projectId: string, path: string, file: File): Promise<string> {
  const query = new URLSearchParams({ projectId, path, expectedBytes: String(file.size) })
  const response = await fetch(`${PROJECT_UPLOAD_PATH}?${query.toString()}`, { method: 'PUT', body: file })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { readonly error?: string } | undefined
    throw new Error(payload?.error ?? `资源上传失败（${String(response.status)}）`)
  }
  return path
}

type NativeCharacterDraft = {
  readonly path?: string
  readonly revision?: DocumentView['revision']
  readonly documentId?: DocumentView['id']
  readonly originalContent?: string
  name: string
  summary: string
  age: string
  gender: string
  identity: string
  personality: string
  keywords: string
  goals: string
  knowledge: string
  stateSchema: string
  initialState: string
  portrait: string
  expression: string
  voice: string
  theme: string
  gallery: string
}

function emptyCharacterDraft(): NativeCharacterDraft {
  const artwork = randomCharacterArtwork()
  return {
    name: '', summary: '', age: '', gender: '', identity: '', personality: '', keywords: '',
    goals: '', knowledge: '',
    stateSchema: [
      'locationId:',
      '  type: string',
      '  mutable: false',
      '  description: 地图中的真实初始地点',
      'emotion:',
      '  type: string',
      '  mutable: true',
      '  description: 当前情绪',
      'inventory:',
      '  type: array',
      '  mutable: true',
      '  description: 随身物品',
    ].join('\n'),
    initialState: ["locationId: ''", 'emotion: 平静', 'inventory: []'].join('\n'),
    portrait: artwork, expression: artwork, voice: '', theme: '', gallery: '',
  }
}

function nativeField(content: string, label: string): string {
  return new RegExp(`^\\s*[-*]\\s*${label}\\s*[：:]\\s*(.+)$`, 'mu').exec(content)?.[1]?.trim() ?? ''
}

function nativeFence(content: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp('```' + escaped + '\\s*\\r?\\n([\\s\\S]*?)\\r?\\n```', 'u')
    .exec(content)?.[1]?.trim() ?? ''
}

function firstCharacterValue(...values: readonly (string | undefined)[]): string {
  return values.find(value => value !== undefined && value.trim() !== '')?.trim() ?? ''
}

function joinedCharacterValues(...values: readonly (string | undefined)[]): string {
  return [...new Set(values.map(value => value?.trim() ?? '').filter(Boolean))].join('\n')
}

function characterLead(document: DocumentView): string {
  const visible = document.content
    .replace(/<!-- oc-native-fields:start -->[\s\S]*?<!-- oc-native-fields:end -->/gu, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/^#\s+.*$/mu, '')
  const lead = visible.split(/^##\s+/mu)[0] ?? ''
  return lead
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function inferredAge(content: string, identity: string): string {
  return /(?:年龄\s*[：:]?\s*)?(\d{1,3})\s*岁/u.exec(identity)?.[1]
    ?? /(?:年龄\s*[：:]\s*)(\d{1,3})/u.exec(content)?.[1]
    ?? ''
}

function inferredGender(content: string): string {
  return /(?:性别|性别／形态|性别\/形态)\s*[：:]\s*([^\n，。,；;]+)/u.exec(content)?.[1]?.trim() ?? ''
}

function profileValue(profile: JsonObject | undefined, key: string): string {
  const value = profile?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function characterDraft(document: DocumentView, runtimeFacets?: JsonObject): NativeCharacterDraft {
  const visible = document.content.replace(/<!--[\s\S]*?-->/gu, '').trim()
  const profile = archiveObject(runtimeFacets?.['profile'])
  const identity = firstCharacterValue(
    nativeField(visible, '身份(?:／职业|/职业)?'),
    archiveSection(document, '身份(?:／职业|/职业)?'),
    profileValue(profile, 'identity'),
  )
  const runtimeGender = joinedCharacterValues(
    profileValue(profile, 'gender'),
    profileValue(profile, 'form'),
    profileValue(profile, 'pronouns'),
  ).replace(/\n/gu, '／')
  const runtime = characterResourcePaths(runtimeFacets)
  return {
    path: document.path,
    revision: document.revision,
    documentId: document.id,
    originalContent: document.content,
    name: archiveTitle(document),
    summary: firstCharacterValue(
      characterLead(document),
      archiveSection(document, '(?:人物)?(?:简介|概述)'),
      identity,
      archiveSummary(document),
    ),
    age: nativeField(visible, '年龄') || inferredAge(visible, identity)
      || profileValue(profile, 'age'),
    gender: nativeField(visible, '性别(?:／形态|/形态)?') || inferredGender(visible)
      || archiveSection(document, '性别(?:／形态|/形态)?') || runtimeGender,
    identity,
    personality: nativeField(visible, '性格') || archiveSection(document, '性格')
      || profileValue(profile, 'personality'),
    keywords: nativeField(visible, '关键词') || archiveSection(document, '关键词')
      || document.tags.filter(tag => !/^(?:角色|人物)$/u.test(tag)).join('、'),
    goals: nativeField(visible, '目标') || archiveSection(document, '目标(?:与愿望)?')
      || profileValue(profile, 'goal'),
    knowledge: joinedCharacterValues(
      nativeField(visible, '知识(?:资料|库)?'),
      archiveSection(document, '(?:私有)?知识(?:资料|库)?'),
      archiveSection(document, '(?:初始)?记忆(?:\\([^)]*\\))?(?:与知识)?'),
    ).replace(/[；;]/gu, '\n'),
    stateSchema: nativeFence(document.content, 'worldline-state-schema'),
    initialState: nativeFence(document.content, 'worldline-initial-state'),
    portrait: nativeField(visible, '头像') || runtime.portrait || defaultArtwork('character', document.path),
    expression: nativeField(visible, '默认立绘') || runtime.expression || runtime.portrait
      || defaultArtwork('character', document.path),
    voice: nativeField(visible, '语音') || runtime.voice || '',
    theme: nativeField(visible, '角色曲') || runtime.theme || '',
    gallery: nativeField(visible, '形象画廊').replace(/[；;]/gu, '\n'),
  }
}

export function characterMarkdown(draft: NativeCharacterDraft): string {
  const knowledge = draft.knowledge.split(/\r?\n/gu).map(item => item.trim()).filter(Boolean).join('；')
  const gallery = draft.gallery.split(/\r?\n/gu).map(item => item.trim()).filter(Boolean).join('；')
  const image = draft.portrait.trim() === '' ? '' : `\n![${draft.name.trim() || '角色'}头像](${draft.portrait.trim()})\n`
  const fields = `## 原生编辑资料\n\n### 基本信息\n\n- 年龄：${draft.age.trim() || '待补充'}\n- 性别／形态：${draft.gender.trim() || '待补充'}\n- 身份／职业：${draft.identity.trim() || '待补充'}\n\n### 性格与人生\n\n- 性格：${draft.personality.trim() || '待补充'}\n- 关键词：${draft.keywords.trim() || '待补充'}\n- 目标：${draft.goals.trim() || '待补充'}\n\n### 记忆与知识\n\n- 知识资料：${knowledge || '待补充'}\n\n### 可运行状态\n\n\`\`\`worldline-state-schema\n${draft.stateSchema.trim()}\n\`\`\`\n\n\`\`\`worldline-initial-state\n${draft.initialState.trim()}\n\`\`\`\n\n### 角色资源\n\n- 头像：${draft.portrait.trim() || '待补充'}\n- 默认立绘：${draft.expression.trim() || '待补充'}\n- 形象画廊：${gallery || '待补充'}\n- 语音：${draft.voice.trim() || '待补充'}\n- 角色曲：${draft.theme.trim() || '待补充'}`
  if (draft.originalContent !== undefined) {
    const preserved = draft.originalContent
      .replace(/\n<!-- oc-native-fields:start -->[\s\S]*?<!-- oc-native-fields:end -->\s*$/u, '')
      .trimEnd()
    const title = `# ${draft.name.trim() || '未命名角色'}`
    const titleMatch = /^#\s+.*$/mu.exec(preserved)
    const afterTitle = titleMatch === null
      ? preserved
      : preserved.slice(titleMatch.index + titleMatch[0].length)
    const sectionIndex = afterTitle.search(/^##\s+/mu)
    const lead = sectionIndex < 0 ? afterTitle : afterTitle.slice(0, sectionIndex)
    const sections = sectionIndex < 0 ? '' : afterTitle.slice(sectionIndex).trimStart()
    const images = [...lead.matchAll(/!\[[^\]]*\]\([^)]*\)/gu)].map(match => match[0])
    const summary = draft.summary.trim() || '这位角色的故事仍在书写中。'
    const authored = [title, summary, ...images, sections].filter(Boolean).join('\n\n')
    return `${authored}\n\n<!-- oc-native-fields:start -->\n${fields}\n<!-- oc-native-fields:end -->\n`
  }
  return `# ${draft.name.trim() || '未命名角色'}\n\n${draft.summary.trim() || '这位角色的故事仍在书写中。'}\n${image}\n${fields}\n`
}

export function WorldlineStudio(props: WorldlineStudioProps) {
  const navigationMemory = useRef<StudioNavigationMemory>(readStudioNavigation())
  const [root, setRoot] = useState<ProjectRootView>()
  const [library, setLibrary] = useState<ProjectLibraryPage>()
  const [project, setProject] = useState<ProjectSummary>()
  const [tab, setTab] = useState<StudioTab>(navigationMemory.current.tab)
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
  const [activeDocumentPath, setActiveDocumentPath] = useState<string | undefined>(navigationMemory.current.activeDocumentPath)
  const [treeRevision, setTreeRevision] = useState(0)
  const [runRevision, setRunRevision] = useState(0)
  const [preferredRun, setPreferredRun] = useState<RunId>()
  const [preferredActor, setPreferredActor] = useState<EntityId>()
  const [storyModelSettingsSignal, setStoryModelSettingsSignal] = useState(0)
  const [storyNarratorRoute, setStoryNarratorRoute] = useState<ModelRoute>()
  const [archiveRunId, setArchiveRunId] = useState<RunId>()
  const [archiveSelectionPath, setArchiveSelectionPath] = useState<string | undefined>(navigationMemory.current.archiveSelectionPath)
  const [archiveFilter, setArchiveFilter] = useState<ArchiveGroup>(navigationMemory.current.archiveFilter)
  const [authoringMode, setAuthoringMode] = useState<AuthoringMode>(navigationMemory.current.authoringMode)
  const [sourceReturnTab, setSourceReturnTab] = useState<SourceReturnTab>(navigationMemory.current.sourceReturnTab)
  const [pathTarget, setPathTarget] = useState<PathFlowTarget>()
  const saveTimers = useRef(new Map<string, number>())
  const documentsRef = useRef(documents)
  const activeDocumentPathRef = useRef(activeDocumentPath)
  documentsRef.current = documents
  activeDocumentPathRef.current = activeDocumentPath

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
      if (currentRoot.configured) {
        const page = await loadLibrary('')
        const rememberedProject = page.projects.find(item => item.manifest.id === navigationMemory.current.projectId)
        if (rememberedProject !== undefined) setProject(rememberedProject)
      }
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
  useEffect(() => {
    if (project === undefined) return
    const next: StudioNavigationMemory = {
      projectId: project.manifest.id,
      tab,
      authoringMode,
      sourceReturnTab,
      archiveFilter,
      overviewScrollTop: navigationMemory.current.overviewScrollTop,
      archiveIndexScrollTop: navigationMemory.current.archiveIndexScrollTop,
      ...(archiveSelectionPath === undefined ? {} : { archiveSelectionPath }),
      ...(activeDocumentPath === undefined ? {} : { activeDocumentPath }),
    }
    navigationMemory.current = next
    writeStudioNavigation(next)
  }, [activeDocumentPath, archiveFilter, archiveSelectionPath, authoringMode, project, sourceReturnTab, tab])

  const rememberScroll = useCallback((field: 'overviewScrollTop' | 'archiveIndexScrollTop', value: number): void => {
    const next = { ...navigationMemory.current, [field]: Math.max(0, value) }
    navigationMemory.current = next
    writeStudioNavigation(next)
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

  useEffect(() => {
    if (project === undefined || authoringMode !== 'source') return
    const rememberedPath = activeDocumentPathRef.current
    if (rememberedPath === undefined
      || documentsRef.current.some(item => item.document.path === rememberedPath)) return
    void openPath(rememberedPath).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [authoringMode, openPath, project])

  const editDocumentAtPath = (path: string, content: string): void => {
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

  const editDocument = (content: string): void => {
    const path = activeDocumentPathRef.current
    if (path !== undefined) editDocumentAtPath(path, content)
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
    setArchiveSelectionPath(undefined); setSourceReturnTab('canon'); setAuthoringMode('native')
    setArchiveFilter('all')
    navigationMemory.current = DEFAULT_STUDIO_NAVIGATION
    writeStudioNavigation(DEFAULT_STUDIO_NAVIGATION)
  }

  const navigateStudio = (next: StudioTab): void => {
    if (next === 'map' && project !== undefined
      && !documentsRef.current.some(item => item.document.path === 'maps/places/world.md')) {
      void openPath('maps/places/world.md').catch(() => {})
    }
    setTab(next)
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
          <ArtworkImage sources={[item.manifest.cover, DEFAULT_ARTWORK.charter]} alt="" />
          <i>{worldlineLabel(item.status)}</i>
        </button>
        <div className={css.projectInfo}><h2>{item.manifest.name}</h2><p>{item.manifest.description || templateDescription(item.manifest.template)}</p><div>{item.manifest.tags.map(tag => <span key={tag}>#{tag}</span>)}</div><small>{item.documentCount} 份设定 · {bytes(item.sizeBytes)} · {chineseDate(item.manifest.updatedAt)}</small></div>
        <div className={css.cardActions}><button type="button" onClick={() => { setProject(item) }}>{props.t('open')}</button><button type="button" aria-label={props.t('copy')} onClick={() => { setProjectActionTarget(item); setCopyName(`${item.manifest.name} 副本`); setDialog('copy') }}>⧉</button><button type="button" aria-label={props.t('exportProject')} onClick={() => { setProject(item); setDestinationPath(''); setTransfer(undefined); setDialog('export') }}>⇧</button><button type="button" className={css.trashAction} aria-label={props.t('trash')} title={props.t('trash')} onClick={() => { setProjectActionTarget(item); setDialog('trash-project') }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6m-9 4h12m-10 0 .7 13h6.6L16 7M10 10v7m4-7v7" /></svg><span>{props.t('trashShort')}</span></button></div>
      </article>)}
    </section></>}
    <DialogSurface open={dialog !== undefined} title={dialog === 'create' ? props.t('newProject') : dialog === 'copy' ? props.t('copyProjectTitle') : dialog === 'trash-project' ? props.t('trashProjectTitle') : dialog === 'empty-trash' ? props.t('emptyTrashTitle') : dialog === 'import' ? props.t('importProject') : dialog === 'root' ? props.t('rootSettings') : props.t('trashBin')} closeLabel={props.t('close')} close={() => { setDialog(undefined) }}>
      {dialog === 'create' && <form onSubmit={(event) => { event.preventDefault(); void action('create', async () => { const created = await props.projects.create({ name: name.trim(), description: description.trim(), template, tags: tags.split(',').map(value => value.trim()).filter(Boolean) }); setDialog(undefined); await loadLibrary(); setProject(created) }) }}>
        <Field label={props.t('projectName')}><input required value={name} onChange={(event) => { setName(event.target.value) }} /></Field><Field label={props.t('description')}><textarea value={description} onChange={(event) => { setDescription(event.target.value) }} placeholder="用一两句话写下这个世界最想讲述的故事…" /></Field><Field label={props.t('template')}><select value={template} onChange={(event) => { setTemplate(event.target.value as ProjectTemplate) }}>{TEMPLATES.map(value => <option key={value} value={value}>{templateLabel(value)}</option>)}</select><small>{templateDescription(template)}</small></Field><Field label={props.t('tags')}><input value={tags} onChange={(event) => { setTags(event.target.value) }} placeholder="幻想，校园，悬疑" /></Field><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('create')} busy={busy !== undefined} />
      </form>}
      {dialog === 'copy' && projectActionTarget !== undefined && <form onSubmit={(event) => { event.preventDefault(); void action(`copy:${projectActionTarget.manifest.id}`, async () => { await props.projects.copyProject({ projectId: projectActionTarget.manifest.id, name: copyName.trim() }); setDialog(undefined); setProjectActionTarget(undefined); await loadLibrary() }) }}><p>{projectActionTarget.manifest.name}</p><Field label={props.t('projectName')}><input required autoFocus value={copyName} onChange={(event) => { setCopyName(event.target.value) }} /></Field><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('copy')} busy={busy !== undefined || copyName.trim() === ''} /></form>}
      {dialog === 'trash-project' && projectActionTarget !== undefined && <form onSubmit={(event) => { event.preventDefault(); void action(`trash:${projectActionTarget.manifest.id}`, async () => { await props.projects.trashProject({ projectId: projectActionTarget.manifest.id }); setDialog(undefined); setProjectActionTarget(undefined); await loadLibrary() }) }}><div className={css.confirmation}><strong>{projectActionTarget.manifest.name}</strong><p>{props.t('trashProjectHint')}</p></div><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('trash')} busy={busy !== undefined} danger /></form>}
      {dialog === 'import' && <form onSubmit={(event) => { event.preventDefault(); void action('import', async () => { await pollTransfer(await props.projects.importProject({ source: sourcePath.trim(), conflict: importConflict })); setDialog(undefined); await loadLibrary() }) }}><PathField label={props.t('sourcePath')} value={sourcePath} onChange={setSourcePath} chooseLabel={props.t('chooseArchive')} onChoose={() => { chooseArchive(props.t('chooseProjectArchive'), ['worldline.zip']) }} /><Field label={props.t('importConflict')}><select value={importConflict} onChange={(event) => { setImportConflict(event.target.value as ProjectImportConflict) }}><option value="copy">{props.t('importAsCopy')}</option><option value="replace">{props.t('replaceRecoverably')}</option><option value="cancel">{props.t('cancelOnConflict')}</option></select></Field><TransferProgress transfer={transfer} /><DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('importProject')} busy={busy !== undefined || sourcePath.trim() === ''} /></form>}
      {dialog === 'root' && <form onSubmit={(event) => { event.preventDefault(); void action('relocate', async () => { await props.projects.setRoot({ path: rootPath.trim(), create: true }); setDialog(undefined); setRelocation(undefined); await initialize() }) }}><PathField label={props.t('projectPath')} value={rootPath} onChange={setRootPath} chooseLabel={props.t('chooseDirectory')} onChoose={() => { setPathTarget({ field: 'relocate', request: { mode: 'directory', title: props.t('chooseRoot') } }) }} /><button type="button" onClick={() => { void action('dry-run', async () => { setRelocation(await props.projects.setRoot({ path: rootPath.trim(), create: true, dryRun: true })) }) }}>{props.t('dryRun')}</button>{relocation !== undefined && <div className={css.relocation}><p>{relocation.projects.length} 个项目 · {bytes(relocation.requiredBytes)}</p>{relocation.conflicts.map(value => <p key={value}>{value}</p>)}</div>}<DialogActions cancel={() => { setDialog(undefined) }} cancelText={props.t('cancel')} submit={props.t('applyRelocation')} busy={busy !== undefined} /></form>}
      {dialog === 'trash' && <section className={css.trashPanel}>
        <header><span>{trashedProjects.length} {props.t('worldCount')}</span><button type="button" data-danger disabled={trashedProjects.length === 0 || busy !== undefined} onClick={() => { setDialog('empty-trash') }}>{props.t('emptyTrash')}</button></header>
        {trashedProjects.length === 0 ? <p className={css.trashEmpty}>{props.t('trashEmpty')}</p> : <ul className={css.trashList}>{trashedProjects.map(item => <li key={item.trashId}><div><strong>{item.manifest?.name ?? item.originalName}</strong><small>{new Date(item.deletedAt).toLocaleString()} · {bytes(item.sizeBytes)}</small></div><button type="button" onClick={() => { void action(`restore:${item.trashId}`, async () => { await props.projects.restoreProject({ trashId: item.trashId }); setTrashedProjects(await props.projects.listTrashedProjects()); await loadLibrary() }) }}>{props.t('restore')}</button></li>)}</ul>}
      </section>}
      {dialog === 'empty-trash' && <form onSubmit={(event) => { event.preventDefault(); void action('empty-trash', async () => { await props.projects.emptyProjectTrash(); setTrashedProjects([]); setDialog('trash'); setNotice(props.t('emptyTrashDone')) }) }}><div className={css.confirmation}><strong>{trashedProjects.length} {props.t('worldCount')}</strong><p>{props.t('emptyTrashHint')}</p></div><DialogActions cancel={() => { setDialog('trash') }} cancelText={props.t('cancel')} submit={props.t('emptyTrash')} busy={busy !== undefined || trashedProjects.length === 0} danger /></form>}
    </DialogSurface>
    {notice !== undefined && <button type="button" className={css.toast} onClick={() => { setNotice(undefined) }}>{notice}</button>}
  </main>)

  const tabs: readonly StudioTab[] = ['overview', 'canon', 'storyline', 'map', 'saves', 'textPlay']
  return withDirectoryFlow(<main className={css.workspace}>
    <header className={css.workspaceHeader}>
      <button type="button" className={css.back} onClick={closeProject}>‹ <span>{props.t('back')}</span></button>
      <div className={css.projectIdentity}><i style={{ background: projectAccent(project) }}>{project.manifest.name.slice(0, 1).toUpperCase()}</i><div><strong>{project.manifest.name}</strong><small>{worldlineLabel(project.status)} · {worldlineLabel(project.health)}</small></div></div>
      <nav>{tabs.map(value => <button type="button" key={value} data-active={tab === value || undefined} onClick={() => { navigateStudio(value) }}>{props.t(value)}</button>)}</nav>
      <div className={css.workspaceHeaderActions}>
        {tab === 'textPlay' && <button type="button" className={css.storyModelButton} onClick={() => { setStoryModelSettingsSignal(value => value + 1) }}><span>LLM</span><strong>{storyNarratorRoute === undefined ? '配置叙事模型' : `${storyNarratorRoute.provider} / ${storyNarratorRoute.model}`}</strong></button>}
        <button type="button" className={css.more} onClick={() => { setDestinationPath(''); setTransfer(undefined); setDialog('export') }}>•••</button>
      </div>
    </header>
    <section className={css.workspaceContent}>
      {tab === 'overview' && <Overview project={project} projects={props.projects} compiler={props.compiler} runs={props.runs} treeRevision={treeRevision} t={props.t} openFolder={() => props.openPath(project.path)} openPath={path => openPath(path).then(() => { setSourceReturnTab('overview'); setAuthoringMode('source'); setTab('canon') })} launchConversation={() => props.launchConversation(project)} navigate={navigateStudio} preferredArchivePath={archiveSelectionPath} onArchiveSelection={setArchiveSelectionPath} archiveFilter={archiveFilter} onArchiveFilter={setArchiveFilter} overviewScrollTop={navigationMemory.current.overviewScrollTop} archiveIndexScrollTop={navigationMemory.current.archiveIndexScrollTop} onRememberScroll={rememberScroll} />}
      {tab === 'canon' && <div className={css.authoringWorkspace}>
        <nav className={css.authoringModeSwitch} aria-label="创作设定编辑方式"><div><strong>{authoringMode === 'native' ? '原生创作工作室' : '高级源码工作区'}</strong><span>{authoringMode === 'native' ? '用对象档案与表单创作；Markdown 仍是唯一真源。' : '正在直接编辑 Markdown 真源；可随时无损返回进入源码前的原生视图。'}</span></div><section><button type="button" data-active={authoringMode === 'native' || undefined} onClick={() => { setAuthoringMode('native'); if (sourceReturnTab !== 'canon') setTab(sourceReturnTab) }}>{sourceReturnTab === 'overview' && authoringMode === 'source' ? '← 返回世界档案馆' : sourceReturnTab === 'storyline' && authoringMode === 'source' ? '← 返回剧情线' : '← 原生档案与表单'}</button><button type="button" data-active={authoringMode === 'source' || undefined} onClick={() => { setSourceReturnTab('canon'); setAuthoringMode('source') }}>Markdown 源文本 IDE</button></section></nav>
        {authoringMode === 'native' ? <><Overview project={project} projects={props.projects} compiler={props.compiler} runs={props.runs} treeRevision={treeRevision} t={props.t} openFolder={() => props.openPath(project.path)} openPath={path => openPath(path).then(() => { setSourceReturnTab('canon'); setAuthoringMode('source') })} launchConversation={() => props.launchConversation(project)} navigate={navigateStudio} authoring /><details className={css.inlineBuild}><summary><span><strong>可运行性检查与发布</strong><small>编辑时自动提示；需要生成可推演版本时再展开。</small></span><i>展开</i></summary><BuildWorkbench t={props.t} project={project} compiler={props.compiler} onImportBlueprint={() => { setSourcePath(''); setTransfer(undefined); setDialog('import-blueprint') }} onExportBlueprint={() => { setDestinationPath(''); setTransfer(undefined); setDialog('export-blueprint') }} onFrozen={() => { setRunRevision(value => value + 1); void loadLibrary('').then((page) => { setProject(current => page.projects.find(item => item.manifest.id === current?.manifest.id) ?? current) }) }} /></details></> : <CanonWorkbench {...props} project={project} openDocuments={documents} activePath={activeDocumentPath} openPath={openPath} activatePath={setActiveDocumentPath} closePath={closeDocument} editDocument={editDocument} saveDocument={() => saveDocument()} useDiskVersion={useDiskVersion} retryLocalVersion={retryLocalVersion} treeRevision={treeRevision} refreshTree={() => { setTreeRevision(value => value + 1) }} />}
      </div>}
      {tab === 'storyline' && <StorylineWorkbench project={project} projects={props.projects} runs={props.runs} narrative={props.narrative} treeRevision={treeRevision} openPath={path => openPath(path).then(() => { setSourceReturnTab('storyline'); setAuthoringMode('source'); setTab('canon') })} openVisualStory={(runId, actorId) => { setPreferredRun(runId); setPreferredActor(actorId); setTab('textPlay') }} />}
      {tab === 'map' && <MapWorkbench t={props.t} project={project} projects={props.projects} runs={props.runs} runRevision={runRevision} openAuthoring={() => { setAuthoringMode('native'); setTab('canon') }} />}
      {tab === 'saves' && <SaveManagementWorkbench project={project} runs={props.runs} revision={runRevision} onChanged={() => { setRunRevision(value => value + 1) }} onImport={() => { setSourcePath(''); setTransfer(undefined); setDialog('import-run') }} onExport={(runId) => { setArchiveRunId(runId); setDestinationPath(''); setTransfer(undefined); setDialog('export-run') }} onContinue={(runId, actorId) => { setPreferredRun(runId); setPreferredActor(actorId); setTab('textPlay') }} />}
      {tab === 'textPlay' && <TextPlayWorkbench t={props.t} project={project} projects={props.projects} runs={props.runs} ai={props.ai} narrative={props.narrative} preferredRunId={preferredRun} preferredActorId={preferredActor} modelSettingsSignal={storyModelSettingsSignal} onNarratorRouteChange={setStoryNarratorRoute} onRunsChanged={() => { setRunRevision(value => value + 1) }} onImportRun={() => { setSourcePath(''); setTransfer(undefined); setDialog('import-run') }} onExportRun={(runId) => { setArchiveRunId(runId); setDestinationPath(''); setTransfer(undefined); setDialog('export-run') }} />}
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

function archiveObject(value: JsonValue | undefined): JsonObject | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined }
function archiveGroup(document: DocumentView): Exclude<ArchiveGroup, 'all'> {
  const kind = inferCanonObjectKind(document.path, document.objectKind).kind
  if (kind === 'character' || kind === 'species') return 'characters'
  if (kind === 'place') return 'places'
  if (kind === 'organization' || kind === 'relation') return 'society'
  if (kind === 'rule' || kind === 'concept' || kind === 'fact') return 'systems'
  if (kind === 'item' || kind === 'asset') return 'items'
  if (kind === 'scenario' || kind === 'timeline-event') return 'stories'
  return 'systems'
}
function archiveGroupLabel(group: ArchiveGroup): string {
  if (group === 'all') return '全部档案'
  return NATIVE_CANON_SECTIONS.find(section => section.id === group)?.label ?? group
}
function archiveGroupOrder(document: DocumentView): number {
  return ARCHIVE_GROUPS.indexOf(archiveGroup(document))
}
function archiveTitle(document: DocumentView): string { return /^#\s+(.+)$/mu.exec(document.content)?.[1]?.trim() ?? document.path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? '未命名角色' }
function archiveSummary(document: DocumentView): string { return document.content.replace(/<!--[\s\S]*?-->/gu, '').replace(/^#.*$/mu, '').replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/[#*_>`-]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 120) || '这位角色的档案仍在书写中。' }
function archiveSection(document: DocumentView, label: string): string {
  const section = new RegExp(`(?:^|\\n)##\\s+${label}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, 'iu').exec(document.content)?.[1] ?? ''
  return section.replace(/!\[[^\]]*\]\([^)]*\)/gu, '').replace(/[#*_>`]/gu, '').replace(/^\s*[-+]\s*/gmu, '').replace(/\s+/gu, ' ').trim().slice(0, 240)
}
type ArchiveImage = { readonly alt: string; readonly src: string }

const UNTOUCHED_CHARACTER_TEMPLATE = '# 主角\n\n写明身份、外观、性格、价值观、目标、能力、资源、关系、经历与初始位置。'

function untouchedCharacterTemplate(document: DocumentView): boolean {
  return document.content.replace(/\r\n/gu, '\n').trim() === UNTOUCHED_CHARACTER_TEMPLATE
}

function resourcePath(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value.trim()
  const entry = archiveObject(value)
  for (const key of ['path', 'url', 'src'] as const) {
    const candidate = entry?.[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

function characterResourcePaths(facets: JsonObject | undefined): Pick<NativeCharacterDraft, 'portrait' | 'expression' | 'voice' | 'theme'> {
  const resources = archiveObject(facets?.['resources']) ?? archiveObject(facets?.['resourceIndex'])
  const visual = archiveObject(resources?.['visual']) ?? archiveObject(resources?.['art'])
  const audio = archiveObject(resources?.['audio'])
  const expressions = archiveObject(visual?.['expressions'])
  return {
    portrait: resourcePath(visual?.['portrait']) || resourcePath(resources?.['portrait']),
    expression: resourcePath(expressions?.['default']) || resourcePath(visual?.['expression']),
    voice: resourcePath(audio?.['voice']) || resourcePath(resources?.['voice']),
    theme: resourcePath(audio?.['theme']) || resourcePath(resources?.['theme']),
  }
}

function usableMediaPath(value: string): boolean {
  return /^(?:https?:|data:|blob:|\/|assets\/)/iu.test(value)
}

function mediaList(value: string): readonly string[] {
  return value.split(/(?:\r?\n|[；;])/gu).map(item => item.trim()).filter(usableMediaPath)
}

function uniqueImages(images: readonly ArchiveImage[]): readonly ArchiveImage[] {
  const seen = new Set<string>()
  return images.filter(image => image.src !== '' && !seen.has(image.src) && seen.add(image.src))
}

function archiveImages(document: DocumentView): readonly ArchiveImage[] {
  return uniqueImages([...document.content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/gu)]
    .map(match => ({ alt: match[1] || archiveTitle(document), src: match[2] ?? '' }))
    .filter(item => usableMediaPath(item.src)))
}

function characterImages(document: DocumentView, runtimeFacets?: JsonObject): readonly ArchiveImage[] {
  const draft = characterDraft(document, runtimeFacets)
  const runtime = characterResources(document.projectId, runtimeFacets === undefined ? undefined : { facets: runtimeFacets })
  const hasPortrait = usableMediaPath(draft.portrait)
  const hasExpression = usableMediaPath(draft.expression)
  return uniqueImages([
    ...archiveImages(document),
    ...(hasPortrait ? [{ alt: `${draft.name} · 头像`, src: draft.portrait }] : []),
    ...(hasExpression ? [{ alt: `${draft.name} · 默认立绘`, src: draft.expression }] : []),
    ...(hasPortrait || runtime.portrait === undefined ? [] : [{ alt: `${draft.name} · 运行时头像`, src: runtime.portrait }]),
    ...(hasExpression || runtime.expression === undefined ? [] : [{ alt: `${draft.name} · 运行时立绘`, src: runtime.expression }]),
    ...mediaList(draft.gallery).map((src, index) => ({ alt: `${draft.name} · 画廊 ${String(index + 1)}`, src })),
  ])
}

function locationImages(document: DocumentView): readonly ArchiveImage[] {
  const draft = locationDraft(document)
  return uniqueImages([
    ...archiveImages(document),
    ...(usableMediaPath(draft.background) ? [{ alt: `${draft.name} · 主场景`, src: draft.background }] : []),
    ...mediaList(draft.gallery).map((src, index) => ({ alt: `${draft.name} · 场景 ${String(index + 1)}`, src })),
  ])
}

function primaryMedia(projectId: string, images: readonly ArchiveImage[]): string | undefined {
  const first = images[0]?.src
  return first === undefined ? undefined : projectMediaUrl(projectId, first) ?? first
}

function CardVisual({ src, label, kind, alt }: { readonly src: string | undefined; readonly label: string; readonly kind: CanonObjectKind; readonly alt?: string }): ReactNode {
  return <div className={css.ocCardVisual} data-kind={kind}>
    <ArtworkImage sources={artworkSources(src, kind, label)} alt={alt ?? `${label}主视觉`} />
  </div>
}

function ProjectAssetField({ projectId, owner, kind, label, accept, value, onChange }: { readonly projectId: string; readonly owner: string; readonly kind: string; readonly label: string; readonly accept: string; readonly value: string; readonly onChange: (path: string) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>()
  const inputId = useId()
  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setUploading(true); setError(undefined)
    try {
      const path = `${WORLDLINE_PROJECT_LAYOUT.mediaDirectory}/${owner}/${kind}-${String(Date.now())}.${assetExtension(file)}`
      onChange(await uploadProjectAsset(projectId, path, file))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setUploading(false) }
  }
  return <Field label={label}><div className={css.projectAssetField}><input value={value} placeholder={`${WORLDLINE_PROJECT_LAYOUT.mediaDirectory}/${owner}/${kind}.png`} onChange={(event) => { onChange(event.target.value) }} /><label htmlFor={inputId} data-disabled={uploading || undefined}>{uploading ? '上传中…' : '选择文件'}<input id={inputId} type="file" accept={accept} disabled={uploading} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }} /></label></div>{error !== undefined && <small className={css.nativeEditorError}>{error}</small>}</Field>
}

function ProjectGalleryField({ projectId, owner, label, value, onChange }: { readonly projectId: string; readonly owner: string; readonly label: string; readonly value: string; readonly onChange: (paths: string) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>()
  const inputId = useId()
  const items = mediaList(value)
  const upload = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    setUploading(true); setError(undefined)
    try {
      const next = [...items]
      for (const file of files) {
        next.push(await uploadProjectAsset(projectId, `${WORLDLINE_PROJECT_LAYOUT.mediaDirectory}/${owner}/gallery-${String(Date.now())}-${assetSlug(file.name)}.${assetExtension(file)}`, file))
      }
      onChange([...new Set(next)].join('\n'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setUploading(false) }
  }
  return <Field label={label}><div className={css.projectGalleryField}>{items.map((item, index) => <div key={item}><ArtworkImage sources={[projectMediaUrl(projectId, item) ?? item, DEFAULT_ARTWORK.asset]} alt={`${label} ${String(index + 1)}`} /><button type="button" aria-label={`移除${label} ${String(index + 1)}`} onClick={() => { onChange(items.filter(path => path !== item).join('\n')) }}>×</button></div>)}<label htmlFor={inputId}>{uploading ? '上传中…' : '＋ 添加图片'}<input id={inputId} type="file" accept="image/*" multiple disabled={uploading} onChange={(event) => { void upload(event.target.files); event.target.value = '' }} /></label></div>{error !== undefined && <small className={css.nativeEditorError}>{error}</small>}</Field>
}

function NativeCharacterDialog({ projectId, draft, setDraft, saving, error, close, save }: { readonly projectId: string; readonly draft: NativeCharacterDraft | undefined; readonly setDraft: (draft: NativeCharacterDraft) => void; readonly saving: boolean; readonly error: string | undefined; readonly close: () => void; readonly save: () => void }) {
  if (draft === undefined) return null
  const input = (key: keyof NativeCharacterDraft, label: string, placeholder = '') => <Field label={label}><input value={draft[key] ?? ''} placeholder={placeholder} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} /></Field>
  const area = (key: keyof NativeCharacterDraft, label: string, placeholder = '') => <Field label={label}><textarea value={draft[key] ?? ''} placeholder={placeholder} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} /></Field>
  return <DialogSurface open title={draft.path === undefined ? '新建人物档案' : `编辑 · ${draft.name}`} closeLabel="关闭人物编辑器" close={close}>
    <form className={css.nativeCharacterEditor} onSubmit={(event) => { event.preventDefault(); save() }}>
      <header><div><span>OC NATIVE EDITOR</span><h3>原生人物编辑器</h3><p>这里填写的是给人阅读的设定；保存后会同步为可运行的角色数据。</p></div><i>{(draft.name.trim() || '角').slice(0, 1)}</i></header>
      <section className={css.nativeEditorGrid}>
        {input('name', '角色名称', '例如：林澈')}
        {input('identity', '身份／职业', '例如：潮汐邮局投递员')}
        {input('age', '年龄', '例如：19 岁')}
        {input('gender', '性别／形态', '例如：女／人类')}
      </section>
      <fieldset><legend>默认角色形象</legend><p>新建角色会随机选用“幻”的白色或黑色形态，并为该角色稳定保留；也可手动更换。</p><section className={css.defaultArtworkPicker}>{DEFAULT_CHARACTER_ART.map(option => <button type="button" key={option.value} data-selected={draft.portrait === option.value || undefined} onClick={() => { setDraft({ ...draft, portrait: option.value, expression: option.value }) }}><ArtworkImage sources={[option.value]} alt={option.label} /><span>{option.label}</span></button>)}</section></fieldset>
      {area('summary', '人物简介', '用一段自然语言介绍角色的来历与现状。')}
      <section className={css.nativeEditorGrid}>
        {area('personality', '性格', '谨慎、温和，但遇到失约会变得固执。')}
        {area('keywords', '关键词', '潮汐、邮差、失物、回声')}
        {area('goals', '长期目标', '完成七封无法投递的信。')}
        {area('knowledge', '记忆／知识库', `每行一个项目内路径，例如 ${WORLDLINE_PROJECT_LAYOUT.mediaDirectory}/characters/linche/knowledge.md`)}
      </section>
      <fieldset><legend>可运行状态模型</legend><p>用 YAML 定义这部故事真正需要的属性、背包或特殊状态。状态导演只能修改 schema 中明确标记 mutable: true 的字段。</p><section className={css.nativeEditorGrid}>{area('stateSchema', '状态 Schema（YAML）', 'emotion:\n  type: string\n  mutable: true')}{area('initialState', '初始状态（YAML）', 'emotion: 平静\ninventory: []')}</section></fieldset>
      <fieldset><legend>互动小说与音频资源</legend><p>可直接上传到当前世界；角色出场时会按世界状态读取对应立绘、表情、CG、服装、语音与主题音乐。</p><section className={css.nativeEditorGrid}><ProjectAssetField projectId={projectId} owner={`characters/${assetSlug(draft.name)}`} kind="avatar" label="头像" accept="image/*" value={draft.portrait} onChange={(portrait) => { setDraft({ ...draft, portrait }) }} /><ProjectAssetField projectId={projectId} owner={`characters/${assetSlug(draft.name)}`} kind="standing" label="默认立绘" accept="image/*" value={draft.expression} onChange={(expression) => { setDraft({ ...draft, expression }) }} /><ProjectAssetField projectId={projectId} owner={`characters/${assetSlug(draft.name)}`} kind="voice" label="语音" accept="audio/*" value={draft.voice} onChange={(voice) => { setDraft({ ...draft, voice }) }} /><ProjectAssetField projectId={projectId} owner={`characters/${assetSlug(draft.name)}`} kind="theme" label="角色曲" accept="audio/*" value={draft.theme} onChange={(theme) => { setDraft({ ...draft, theme }) }} /></section><ProjectGalleryField projectId={projectId} owner={`characters/${assetSlug(draft.name)}`} label="形象画廊（表情／服装／剧情 CG）" value={draft.gallery} onChange={(gallery) => { setDraft({ ...draft, gallery }) }} /></fieldset>
      {error !== undefined && <p className={css.nativeEditorError}>{error}</p>}
      <DialogActions cancel={close} cancelText="取消" submit="保存人物档案" busy={saving || draft.name.trim() === ''} />
    </form>
  </DialogSurface>
}

function NativeLocationDialog({ projectId, draft, setDraft, saving, error, close, save }: { readonly projectId: string; readonly draft: NativeLocationDraft | undefined; readonly setDraft: (draft: NativeLocationDraft) => void; readonly saving: boolean; readonly error: string | undefined; readonly close: () => void; readonly save: () => void }) {
  if (draft === undefined) return null
  return <DialogSurface open title={draft.path === undefined ? '新建地点档案' : `编辑 · ${draft.name}`} closeLabel="关闭地点编辑器" close={close}>
    <form className={css.nativeCharacterEditor} onSubmit={(event) => { event.preventDefault(); save() }}>
      <header><div><span>OC PLACE EDITOR</span><h3>原生地点编辑器</h3><p>先定义地点本身，再到世界地图画布中拖拽编排和连接。</p></div><i>地</i></header>
      <section className={css.nativeEditorGrid}>
        <Field label="地点名称"><input value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} /></Field>
        <Field label="地点类型"><select value={draft.kind} onChange={(event) => { setDraft({ ...draft, kind: event.target.value as NativeLocationDraft['kind'] }) }}>{(['world', 'plane', 'region', 'city', 'building', 'room', 'slot'] as const).map(kind => <option key={kind} value={kind}>{worldlineLabel(kind)}</option>)}</select></Field>
        <Field label="稳定 ID"><input value={draft.id} readOnly /></Field>
        <Field label="上级地点 ID"><input value={draft.parentId} placeholder="可留空" onChange={(event) => { setDraft({ ...draft, parentId: event.target.value }) }} /></Field>
      </section>
      <Field label="地点简介"><textarea value={draft.summary} placeholder="这里是什么地方，谁会来，通常会发生什么？" onChange={(event) => { setDraft({ ...draft, summary: event.target.value }) }} /></Field>
      <section className={css.nativeEditorGrid}><Field label="地图 X"><input type="number" value={draft.x} onChange={(event) => { setDraft({ ...draft, x: Number(event.target.value) }) }} /></Field><Field label="地图 Y"><input type="number" value={draft.y} onChange={(event) => { setDraft({ ...draft, y: Number(event.target.value) }) }} /></Field><Field label="容纳人数"><input type="number" min="0" value={draft.capacity} onChange={(event) => { setDraft({ ...draft, capacity: event.target.value }) }} /></Field><ProjectAssetField projectId={projectId} owner={`locations/${assetSlug(draft.name)}`} kind="background" label="互动小说场景背景" accept="image/*" value={draft.background} onChange={(background) => { setDraft({ ...draft, background }) }} /></section>
      <ProjectGalleryField projectId={projectId} owner={`locations/${assetSlug(draft.name)}`} label="地点画廊（昼夜／天气／灾前灾后）" value={draft.gallery} onChange={(gallery) => { setDraft({ ...draft, gallery }) }} />
      <Field label="相邻地点与游戏内路程"><textarea value={draft.connections} placeholder={'每行一个：map-node:harbor|15\n表示通往港口需要 15 个游戏分钟'} onChange={(event) => { setDraft({ ...draft, connections: event.target.value }) }} /></Field>
      {error !== undefined && <p className={css.nativeEditorError}>{error}</p>}
      <DialogActions cancel={close} cancelText="取消" submit="保存地点档案" busy={saving || draft.name.trim() === ''} />
    </form>
  </DialogSurface>
}

function NativePlotDialog({ draft, setDraft, saving, error, close, save }: { readonly draft: NativePlotDraft | undefined; readonly setDraft: (draft: NativePlotDraft) => void; readonly saving: boolean; readonly error: string | undefined; readonly close: () => void; readonly save: () => void }) {
  if (draft === undefined) return null
  return <DialogSurface open title={draft.path === undefined ? '新建剧情点' : `编辑 · ${draft.name}`} closeLabel="关闭剧情点编辑器" close={close}>
    <form className={css.nativeCharacterEditor} onSubmit={(event) => { event.preventDefault(); save() }}>
      <header><div><span>STORY EVENT EDITOR</span><h3>原生剧情事件编辑器</h3><p>定义目标证据、压力与后果；具体行动由每轮故事导演实时创作。</p></div><i>幕</i></header>
      <section className={css.nativeEditorGrid}><Field label="剧情点名称"><input value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} /></Field><Field label="剧情顺序"><input type="number" min="1" value={draft.order} onChange={(event) => { setDraft({ ...draft, order: Number(event.target.value) }) }} /></Field></section>
      <Field label="剧情内容"><textarea value={draft.summary} placeholder="这一幕发生什么，角色为什么会走到这里？" onChange={(event) => { setDraft({ ...draft, summary: event.target.value }) }} /></Field>
      <section className={css.nativeEditorGrid}><Field label="进入条件"><input value={draft.entryCondition} placeholder="例如：角色已经到达旧图书馆，且日记仍未被发现" onChange={(event) => { setDraft({ ...draft, entryCondition: event.target.value }) }} /></Field><Field label="完成证据"><input value={draft.completionCriteria} placeholder="例如：两人确认书签属于彼此，并共同说出约定" onChange={(event) => { setDraft({ ...draft, completionCriteria: event.target.value }) }} /></Field></section>
      <Field label="戏剧压力"><textarea value={draft.dramaticPressure} placeholder="什么会迫使人物必须面对这一幕，而不是无限拖延？" onChange={(event) => { setDraft({ ...draft, dramaticPressure: event.target.value }) }} /></Field>
      <section className={css.nativeEditorGrid}><Field label="成功后果"><textarea value={draft.successOutcome} placeholder="目标成立后，世界与人物关系会走向哪里？" onChange={(event) => { setDraft({ ...draft, successOutcome: event.target.value }) }} /></Field><Field label="失败后果"><textarea value={draft.failureOutcome} placeholder="错过或拒绝目标时，压力如何升级？" onChange={(event) => { setDraft({ ...draft, failureOutcome: event.target.value }) }} /></Field></section>
      <Field label="恢复钩子"><textarea value={draft.recoveryHook} placeholder="失败后如何以另一条真实路径重新接回主线？" onChange={(event) => { setDraft({ ...draft, recoveryHook: event.target.value }) }} /></Field>
      {error !== undefined && <p className={css.nativeEditorError}>{error}</p>}
      <DialogActions cancel={close} cancelText="取消" submit="保存剧情点" busy={saving || [draft.name, draft.entryCondition, draft.completionCriteria, draft.dramaticPressure, draft.successOutcome, draft.failureOutcome, draft.recoveryHook].some(value => value.trim() === '')} />
    </form>
  </DialogSurface>
}

function NativeDossierDialog({ draft, setDraft, saving, error, close, save }: { readonly draft: NativeDossierDraft | undefined; readonly setDraft: (draft: NativeDossierDraft) => void; readonly saving: boolean; readonly error: string | undefined; readonly close: () => void; readonly save: () => void }) {
  if (draft === undefined) return null
  const definition = nativeCanonDefinition(draft.kind)
  return <DialogSurface open title={draft.path === undefined ? `新建${definition.label}档案` : `编辑 · ${draft.name}`} closeLabel={`关闭${definition.label}编辑器`} close={close}>
    <form className={css.nativeCharacterEditor} onSubmit={(event) => { event.preventDefault(); save() }}>
      <header><div><span>OC CANON DOSSIER</span><h3>原生{definition.label}编辑器</h3><p>{definition.prompt}</p></div><i>{definition.label.slice(0, 1)}</i></header>
      <section className={css.nativeEditorGrid}>
        <Field label="档案类型"><input value={definition.label} readOnly /></Field>
        <Field label="规范存储位置"><input value={`${definition.directory}/`} readOnly /></Field>
      </section>
      <Field label="名称"><input autoFocus value={draft.name} placeholder={`例如：未命名${definition.label}`} onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} /></Field>
      <Field label="摘要"><textarea value={draft.summary} placeholder="用一段话说明它是什么、为什么重要，以及当前状态。" onChange={(event) => { setDraft({ ...draft, summary: event.target.value }) }} /></Field>
      <Field label={`${definition.sectionTitle}（支持 Markdown）`}><textarea value={draft.body} placeholder={`## ${definition.sectionTitle}\n\n${definition.prompt}`} onChange={(event) => { setDraft({ ...draft, body: event.target.value }) }} /></Field>
      <p className={css.nativeEditorHint}>保存时会写入框架规定的目录；运行快照、构建缓存与历史记录由系统管理，不混入正典档案。</p>
      {error !== undefined && <p className={css.nativeEditorError}>{error}</p>}
      <DialogActions cancel={close} cancelText="取消" submit={`保存${definition.label}档案`} busy={saving || draft.name.trim() === ''} />
    </form>
  </DialogSurface>
}

async function listMarkdownDocuments(
  projects: WorldlineStudioInjected['projects'],
  projectId: ProjectId,
  root: string,
  signal: AbortSignal,
): Promise<readonly ProjectTreeEntry[]> {
  const pending = [root]
  const visited = new Set<string>()
  const documents: ProjectTreeEntry[] = []
  while (pending.length > 0 && !signal.aborted) {
    const path = pending.shift()
    if (path === undefined || visited.has(path)) continue
    visited.add(path)
    let cursor: string | undefined
    do {
      let listing
      try {
        listing = await projects.tree({ projectId, path, limit: 500, ...(cursor === undefined ? {} : { cursor }) })
      } catch {
        break
      }
      for (const entry of listing.entries) {
        if (entry.kind === 'directory') pending.push(entry.path)
        else if (entry.kind === 'document' && entry.path.toLocaleLowerCase('en-US').endsWith('.md')) documents.push(entry)
      }
      cursor = listing.nextCursor
    } while (cursor !== undefined)
  }
  return documents
}

function Overview({ project, projects, compiler, runs, treeRevision, t, openFolder, openPath, launchConversation, navigate, authoring = false, preferredArchivePath, onArchiveSelection, archiveFilter: controlledArchiveFilter, onArchiveFilter, overviewScrollTop = 0, archiveIndexScrollTop = 0, onRememberScroll }: { readonly project: ProjectSummary; readonly projects: WorldlineStudioInjected['projects']; readonly compiler: WorldlineStudioInjected['compiler']; readonly runs: WorldlineStudioInjected['runs']; readonly treeRevision: number; readonly t: WorldlineStudioProps['t']; readonly openFolder: () => Promise<void>; readonly openPath: (path: string) => Promise<void>; readonly launchConversation: () => Promise<void>; readonly navigate: (tab: StudioTab) => void; readonly authoring?: boolean; readonly preferredArchivePath?: string | undefined; readonly onArchiveSelection?: ((path: string) => void) | undefined; readonly archiveFilter?: ArchiveGroup | undefined; readonly onArchiveFilter?: ((group: ArchiveGroup) => void) | undefined; readonly overviewScrollTop?: number | undefined; readonly archiveIndexScrollTop?: number | undefined; readonly onRememberScroll?: ((field: 'overviewScrollTop' | 'archiveIndexScrollTop', value: number) => void) | undefined }) {
  const [characters, setCharacters] = useState<readonly DocumentView[]>([])
  const [locations, setLocations] = useState<readonly DocumentView[]>([])
  const [plots, setPlots] = useState<readonly DocumentView[]>([])
  const [archiveDocuments, setArchiveDocuments] = useState<readonly DocumentView[]>([])
  const [localArchiveFilter, setLocalArchiveFilter] = useState<ArchiveGroup>('all')
  const [selectedArchivePath, setSelectedArchivePath] = useState<string | undefined>(preferredArchivePath)
  const [runtimeEntities, setRuntimeEntities] = useState<JsonObject>()
  const [runtimeFacetsByPath, setRuntimeFacetsByPath] = useState<ReadonlyMap<string, JsonObject>>(new Map())
  const [draft, setDraft] = useState<NativeCharacterDraft>()
  const [savingCharacter, setSavingCharacter] = useState(false)
  const [characterError, setCharacterError] = useState<string>()
  const [locationEditor, setLocationEditor] = useState<NativeLocationDraft>()
  const [savingLocation, setSavingLocation] = useState(false)
  const [locationError, setLocationError] = useState<string>()
  const [plotEditor, setPlotEditor] = useState<NativePlotDraft>()
  const [savingPlot, setSavingPlot] = useState(false)
  const [plotError, setPlotError] = useState<string>()
  const [dossierEditor, setDossierEditor] = useState<NativeDossierDraft>()
  const [savingDossier, setSavingDossier] = useState(false)
  const [dossierError, setDossierError] = useState<string>()
  const [authoringSection, setAuthoringSection] = useState<NativeCanonSectionId>('characters')
  const [creationKind, setCreationKind] = useState<EditableCanonKind>('character')
  const archiveFilter = controlledArchiveFilter ?? localArchiveFilter
  const setArchiveFilter = onArchiveFilter ?? setLocalArchiveFilter
  const attachOverview = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) node.scrollTop = overviewScrollTop
  }, [overviewScrollTop])
  const attachArchiveIndex = useCallback((node: HTMLElement | null): void => {
    if (node !== null) node.scrollTop = archiveIndexScrollTop
  }, [archiveIndexScrollTop])
  useEffect(() => {
    if (preferredArchivePath !== undefined) setSelectedArchivePath(preferredArchivePath)
  }, [preferredArchivePath])
  useEffect(() => {
    const controller = new AbortController()
    const stopped = (): boolean => controller.signal.aborted
    void (async () => {
      const directories = [...new Set([
        canonDirectory('charter'),
        ...NATIVE_CANON_KINDS.map(item => item.directory),
      ])]
      const listings = await Promise.all(directories.map(async path =>
        await listMarkdownDocuments(projects, project.manifest.id, path, controller.signal)))
      if (stopped()) return
      const files = [...new Map(listings.flat()
        .map(item => [item.path, item])).values()]
      const settled = await Promise.allSettled(files.map(item => projects.read({
        projectId: project.manifest.id,
        path: item.path,
      })))
      if (stopped()) return
      const documents = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
        .filter(document => !untouchedCharacterTemplate(document))
      setArchiveDocuments(documents)
      setCharacters(documents.filter(document => inferCanonObjectKind(document.path, document.objectKind).kind === 'character'))
      setLocations(documents.filter(document => inferCanonObjectKind(document.path, document.objectKind).kind === 'place'))
      setPlots(documents.filter(document => inferCanonObjectKind(document.path, document.objectKind).kind === 'scenario'))
    })()
    void (async () => {
      try {
        const preview = await compiler.compile({ projectId: project.manifest.id })
        if (controller.signal.aborted) return
        const next = new Map<string, JsonObject>()
        for (const object of preview.canon) {
          if (object.kind !== 'character') continue
          const sourcePath = object.facets['sourcePath']
          if (typeof sourcePath === 'string') next.set(sourcePath.replace(/\\/gu, '/'), object.facets)
        }
        setRuntimeFacetsByPath(next)
      } catch {
        if (!controller.signal.aborted) setRuntimeFacetsByPath(new Map())
      }
    })()
    void (async () => {
      const summaries = (await runs.list()).filter(item => item.projectId === project.manifest.id)
      const latest = summaries.find(item => item.status === 'running') ?? summaries[0]
      if (latest !== undefined) {
        const view = await runs.view({ runId: latest.runId })
        if (!controller.signal.aborted) setRuntimeEntities(snapshotEntities(view.snapshot))
      }
    })().catch(() => {})
    return () => { controller.abort() }
  }, [compiler, project.manifest.id, projects, runs, treeRevision])
  const runtimeIds = characterEntityIds(runtimeEntities)
  const runtimeNames = new Map(runtimeIds.map((id, index) => [id, entityName(runtimeEntities, id, index)]))
  const relations = runtimeIds.flatMap((id) => {
    const memory = archiveObject(archiveObject(runtimeEntities?.[id])?.['memory'])
    const items = Array.isArray(memory?.['relationships']) ? memory['relationships'] : []
    return items.flatMap((item) => { const relation = archiveObject(item); const other = typeof relation?.['otherId'] === 'string' ? relation['otherId'] as EntityId : undefined; return other !== undefined && runtimeNames.has(other) ? [{ from: id, to: other }] : [] })
  })
  const allArchiveDocuments = [...new Map([
    ...archiveDocuments,
    ...characters,
    ...locations,
    ...plots,
  ].filter(document => !untouchedCharacterTemplate(document)).map(document => [document.path, document])).values()]
    .sort((left, right) => archiveGroupOrder(left) - archiveGroupOrder(right)
      || archiveTitle(left).localeCompare(archiveTitle(right), 'zh-CN'))
  const archiveCounts = new Map<ArchiveGroup, number>()
  const coveredKinds = new Set<EditableCanonKind>()
  for (const document of allArchiveDocuments) {
    const group = archiveGroup(document)
    const kind = inferCanonObjectKind(document.path, document.objectKind).kind
    if (NATIVE_CANON_KINDS.some(item => item.kind === kind)) coveredKinds.add(kind as EditableCanonKind)
    archiveCounts.set(group, (archiveCounts.get(group) ?? 0) + 1)
  }
  const filteredArchiveDocuments = archiveFilter === 'all'
    ? allArchiveDocuments
    : allArchiveDocuments.filter(document => archiveGroup(document) === archiveFilter)
  const desiredArchivePath = selectedArchivePath ?? preferredArchivePath
  const selectedArchive = filteredArchiveDocuments.find(document => document.path === desiredArchivePath)
    ?? filteredArchiveDocuments[0]
  useEffect(() => {
    if (filteredArchiveDocuments.length === 0) {
      if (selectedArchivePath !== undefined) setSelectedArchivePath(undefined)
      return
    }
    if (!filteredArchiveDocuments.some(document => document.path === desiredArchivePath)) {
      const charter = filteredArchiveDocuments.find(document => inferCanonObjectKind(document.path, document.objectKind).kind === 'charter')
      setSelectedArchivePath((charter ?? filteredArchiveDocuments[0])?.path)
    }
  }, [desiredArchivePath, filteredArchiveDocuments, selectedArchivePath])
  const selectedArchiveKind = selectedArchive === undefined
    ? undefined
    : inferCanonObjectKind(selectedArchive.path, selectedArchive.objectKind).kind
  const selectedArchiveMedia = selectedArchive === undefined
    ? []
    : selectedArchiveKind === 'character'
      ? characterImages(selectedArchive, runtimeFacetsByPath.get(selectedArchive.path))
        .map(item => projectMediaUrl(project.manifest.id, item.src) ?? item.src)
      : selectedArchiveKind === 'place'
        ? locationImages(selectedArchive)
          .map(item => projectMediaUrl(project.manifest.id, item.src) ?? item.src)
        : []
  const authoringDefinition = NATIVE_CANON_SECTIONS.find(section => section.id === authoringSection)
    ?? NATIVE_CANON_SECTIONS[0]
  if (authoringDefinition === undefined) throw new Error('Native OC canon section registry is empty.')
  const authoringDocuments = allArchiveDocuments.filter((document) => {
    const kind = inferCanonObjectKind(document.path, document.objectKind).kind
    return authoringDefinition.kinds.some(candidate => candidate === kind)
  })
  const beginCreate = (kind: EditableCanonKind): void => {
    if (kind === 'character') { setDraft(emptyCharacterDraft()); return }
    if (kind === 'place') { setLocationEditor(emptyLocationDraft()); return }
    if (kind === 'scenario') { setPlotEditor(emptyPlotDraft()); return }
    setDossierEditor(emptyDossierDraft(kind))
  }
  const editArchive = (document: DocumentView): void => {
    const kind = inferCanonObjectKind(document.path, document.objectKind).kind
    if (kind === 'character') { setDraft(characterDraft(document, runtimeFacetsByPath.get(document.path))); return }
    if (kind === 'place') { setLocationEditor(locationDraft(document)); return }
    if (kind === 'scenario') { setPlotEditor(plotDraft(document)); return }
    if (NATIVE_CANON_KINDS.some(item => item.kind === kind)) {
      setDossierEditor(dossierDraft(document, kind as EditableCanonKind))
      return
    }
    void openPath(document.path)
  }
  const saveCharacter = async (): Promise<void> => {
    if (draft === undefined || draft.name.trim() === '') return
    setSavingCharacter(true); setCharacterError(undefined)
    try {
      const path = draft.path ?? `characters/character-${String(Date.now())}.md`
      const saved = await projects.write({ projectId: project.manifest.id, path, content: characterMarkdown(draft), ...(draft.revision === undefined ? {} : { expectedRevision: draft.revision }), ...(draft.documentId === undefined ? {} : { documentId: draft.documentId }), objectKind: 'character', tags: ['OC', '角色'], createParents: true })
      setCharacters(current => [...current.filter(item => item.id !== saved.id), saved].sort((left, right) => left.path.localeCompare(right.path)))
      setDraft(undefined)
    } catch (reason) { setCharacterError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSavingCharacter(false) }
  }
  const saveLocation = async (): Promise<void> => {
    if (locationEditor === undefined || locationEditor.name.trim() === '') return
    setSavingLocation(true); setLocationError(undefined)
    try {
      const path = locationEditor.path ?? `maps/places/place-${String(Date.now())}.md`
      const saved = await projects.write({ projectId: project.manifest.id, path, content: locationMarkdown(locationEditor), ...(locationEditor.revision === undefined ? {} : { expectedRevision: locationEditor.revision }), ...(locationEditor.documentId === undefined ? {} : { documentId: locationEditor.documentId }), objectKind: 'place', tags: ['地点', '地图节点'], createParents: true })
      setLocations(current => [...current.filter(item => item.id !== saved.id), saved].sort((left, right) => left.path.localeCompare(right.path)))
      setLocationEditor(undefined)
    } catch (reason) { setLocationError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSavingLocation(false) }
  }
  const savePlot = async (): Promise<void> => {
    if (plotEditor === undefined || [plotEditor.name, plotEditor.entryCondition,
      plotEditor.completionCriteria, plotEditor.dramaticPressure, plotEditor.successOutcome,
      plotEditor.failureOutcome, plotEditor.recoveryHook].some(value => value.trim() === '')) return
    setSavingPlot(true); setPlotError(undefined)
    try {
      const path = plotEditor.path ?? `scenarios/plot-points/plot-${String(Date.now())}.md`
      const saved = await projects.write({ projectId: project.manifest.id, path, content: plotMarkdown(plotEditor), ...(plotEditor.revision === undefined ? {} : { expectedRevision: plotEditor.revision }), ...(plotEditor.documentId === undefined ? {} : { documentId: plotEditor.documentId }), objectKind: 'scenario', tags: ['剧情点', '可游玩'], createParents: true })
      setPlots(current => [...current.filter(item => item.id !== saved.id), saved].sort((left, right) => plotDraft(left).order - plotDraft(right).order))
      setPlotEditor(undefined)
    } catch (reason) { setPlotError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSavingPlot(false) }
  }
  const saveDossier = async (): Promise<void> => {
    if (dossierEditor === undefined || dossierEditor.name.trim() === '') return
    const definition = nativeCanonDefinition(dossierEditor.kind)
    setSavingDossier(true); setDossierError(undefined)
    try {
      const saved = await projects.write({
        projectId: project.manifest.id,
        path: dossierEditor.path ?? dossierPath(dossierEditor),
        content: dossierMarkdown(dossierEditor),
        ...(dossierEditor.revision === undefined ? {} : { expectedRevision: dossierEditor.revision }),
        ...(dossierEditor.documentId === undefined ? {} : { documentId: dossierEditor.documentId }),
        objectKind: dossierEditor.kind,
        tags: [definition.label],
        createParents: true,
      })
      setArchiveDocuments(current => [...current.filter(item => item.id !== saved.id), saved])
      setDossierEditor(undefined)
    } catch (reason) { setDossierError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSavingDossier(false) }
  }
  const nativeDialog = <NativeCharacterDialog projectId={project.manifest.id} draft={draft} setDraft={setDraft} saving={savingCharacter} error={characterError} close={() => { setDraft(undefined); setCharacterError(undefined) }} save={() => { void saveCharacter() }} />
  const locationDialog = <NativeLocationDialog projectId={project.manifest.id} draft={locationEditor} setDraft={setLocationEditor} saving={savingLocation} error={locationError} close={() => { setLocationEditor(undefined); setLocationError(undefined) }} save={() => { void saveLocation() }} />
  const plotDialog = <NativePlotDialog draft={plotEditor} setDraft={setPlotEditor} saving={savingPlot} error={plotError} close={() => { setPlotEditor(undefined); setPlotError(undefined) }} save={() => { void savePlot() }} />
  const dossierDialog = <NativeDossierDialog draft={dossierEditor} setDraft={setDossierEditor} saving={savingDossier} error={dossierError} close={() => { setDossierEditor(undefined); setDossierError(undefined) }} save={() => { void saveDossier() }} />
  if (authoring) return <div className={css.nativeAuthoring}>
    <header className={css.nativeAuthoringHero}><div><span>OC CREATION STUDIO</span><h1>原生 OC 创作框架</h1><p>人物、物种、地点、组织、关系、规则、概念、事实、物品、资源、剧情与时间线使用统一档案规范；系统自动写入对应目录。</p></div><section className={css.nativeAuthoringCreate}><label><span>新建类型</span><select aria-label="新建档案类型" value={creationKind} onChange={(event) => { setCreationKind(event.target.value as EditableCanonKind) }}>{authoringDefinition.kinds.map((kind) => { const item = nativeCanonDefinition(kind); return <option key={kind} value={kind}>{item.label}</option> })}</select></label><button type="button" data-primary onClick={() => { beginCreate(creationKind) }}>＋ 新建{nativeCanonDefinition(creationKind).label}</button></section></header>
    <nav className={css.nativeAuthoringKinds} aria-label="OC 档案类别">{NATIVE_CANON_SECTIONS.map(section => <button type="button" key={section.id} data-active={authoringSection === section.id || undefined} title={section.description} onClick={() => { const firstKind = section.kinds[0]; if (firstKind === undefined) return; setAuthoringSection(section.id); setCreationKind(firstKind) }}>{section.label}</button>)}</nav>
    <section className={css.nativeFrameworkNotice}><strong>{authoringDefinition.label}</strong><span>{authoringDefinition.description}</span><small>{authoringDefinition.kinds.map(kind => `${nativeCanonDefinition(kind).label} → ${nativeCanonDefinition(kind).directory}/`).join('　')}</small></section>
    <section className={css.nativeAuthoringCards}>{authoringDocuments.length === 0 ? <button type="button" className={css.nativeEmptyCard} onClick={() => { beginCreate(creationKind) }}><strong>创建第一份{nativeCanonDefinition(creationKind).label}档案</strong><span>选择类型后由系统写入规范目录；无需手动建文件夹或决定文件位置。</span></button> : authoringDocuments.map((document, index) => { const kind = inferCanonObjectKind(document.path, document.objectKind).kind as EditableCanonKind; const name = archiveTitle(document); const media = kind === 'character' ? primaryMedia(project.manifest.id, characterImages(document, runtimeFacetsByPath.get(document.path))) : kind === 'place' ? primaryMedia(project.manifest.id, locationImages(document)) : undefined; return <article key={document.id}><CardVisual src={media} label={name} kind={kind} /><i>{String(index + 1).padStart(2, '0')}</i><div><small>OC · {nativeCanonDefinition(kind).label.toUpperCase()}</small><h2>{name}</h2><p>{archiveSummary(document)}</p><em>{document.path}</em><footer><button type="button" data-primary onClick={() => { editArchive(document) }}>原生编辑{nativeCanonDefinition(kind).label}</button><button type="button" onClick={() => { void openPath(document.path) }}>打开 Markdown 原文</button></footer></div></article> })}</section>
    {nativeDialog}
    {locationDialog}
    {plotDialog}
    {dossierDialog}
  </div>
  return <div ref={attachOverview} className={css.overview} onScroll={(event) => { if (event.target === event.currentTarget) onRememberScroll?.('overviewScrollTop', event.currentTarget.scrollTop) }}>
    <section id="world" className={css.overviewHero}><div><span>ORIGINAL CHARACTER ARCHIVE</span><h1>{project.manifest.name}</h1><p>{project.manifest.description || templateDescription(project.manifest.template)}</p><div>{project.manifest.tags.map(tag => <i key={tag}>#{tag}</i>)}</div><section><button type="button" aria-label={t('chatWithAuthor')} data-primary onClick={() => { void launchConversation() }}>✦ 与世界线助手共创</button><button type="button" onClick={() => { navigate('canon') }}>进入创作设定 →</button></section></div><div className={css.projectGlyph} style={{ '--project-accent': projectAccent(project) } as CSSProperties}><small>WORLD FILE</small><strong>{project.manifest.name.slice(0, 1).toUpperCase()}</strong><i>{worldlineLabel(project.status)}</i></div></section>
    <section className={css.archiveSummary} aria-label="世界档案馆概览"><div><small>正典对象</small><strong>{allArchiveDocuments.length}</strong><span>全部来自同一份 Markdown 真源</span></div><div><small>规范覆盖</small><strong>{coveredKinds.size}/12</strong><span>OC 世界线标准对象类型</span></div><div><small>实时世界</small><strong>{runtimeIds.length}</strong><span>{runtimeIds.length === 0 ? '尚未开始演绎' : `${relations.length} 条运行中关系`}</span></div><button type="button" onClick={() => { void openFolder() }}><small>本地真源</small><strong>打开项目目录</strong><span>{project.path}</span></button></section>
    <header id="archive" className={css.archiveSectionTitle}><div><span>OC WORLD ARCHIVE</span><h2>世界档案馆</h2><p>按统一框架原生展示人物、物种、地点、组织、关系、规则、概念、事实、物品、资源、剧情与时间线。</p></div><button type="button" onClick={() => { navigate('canon') }}>进入原生创作工作室 →</button></header>
    <nav className={css.archiveFilters} aria-label="档案类型">{ARCHIVE_GROUPS.map(group => <button type="button" key={group} data-active={archiveFilter === group || undefined} onClick={() => { setArchiveFilter(group) }}>{archiveGroupLabel(group)} <span>{group === 'all' ? allArchiveDocuments.length : archiveCounts.get(group) ?? 0}</span></button>)}</nav>
    {allArchiveDocuments.length === 0 ? <section className={css.archiveEmpty}><span>✦</span><h3>这座档案馆还在等待第一份正典</h3><p>前往原生创作工作室，从十二类标准对象中开始构筑；保存后会自动归档到对应分类。</p><button type="button" onClick={() => { navigate('canon') }}>开始构筑世界</button></section> : <section className={css.archiveVault}>
      <aside ref={attachArchiveIndex} className={css.archiveIndex} aria-label="档案目录" onScroll={(event) => { onRememberScroll?.('archiveIndexScrollTop', event.currentTarget.scrollTop) }}><header><strong>{archiveGroupLabel(archiveFilter)}</strong><small>{filteredArchiveDocuments.length} 份档案</small></header>{filteredArchiveDocuments.map((document) => { const kind = inferCanonObjectKind(document.path, document.objectKind).kind; const media = kind === 'character' ? primaryMedia(project.manifest.id, characterImages(document, runtimeFacetsByPath.get(document.path))) : kind === 'place' ? primaryMedia(project.manifest.id, locationImages(document)) : undefined; return <button type="button" key={document.id} aria-pressed={selectedArchive?.path === document.path} onClick={() => { setSelectedArchivePath(document.path); onArchiveSelection?.(document.path) }}><CardVisual src={media} label={archiveTitle(document)} kind={kind} alt={`${archiveTitle(document)}档案封面`} /><span><small>{worldlineLabel(kind)}</small><strong>{archiveTitle(document)}</strong><em>{archiveSummary(document)}</em></span></button> })}</aside>
      <section className={css.archiveReader} aria-live="polite">{selectedArchive !== undefined && <><header><div><small>NATIVE DOSSIER</small><strong>原生档案阅览</strong><span>阅读视图与 Markdown 使用同一份数据，不生成副本。</span></div><section><button type="button" data-primary={selectedArchiveKind !== 'charter' && selectedArchiveKind !== 'custom' || undefined} onClick={() => { editArchive(selectedArchive) }}>{selectedArchiveKind !== 'charter' && selectedArchiveKind !== 'custom' ? '原生编辑此档案' : '高级编辑此档案'}</button><button type="button" onClick={() => { void openPath(selectedArchive.path) }}>打开源码</button></section></header><CanonObjectView path={selectedArchive.path} content={selectedArchive.content} explicitKind={selectedArchive.objectKind} documentId={selectedArchive.id} revision={selectedArchive.revision} tags={selectedArchive.tags} mediaSources={selectedArchiveMedia} mediaAlt={`${archiveTitle(selectedArchive)}主视觉`} t={t} /></>}</section>
    </section>}
    {nativeDialog}
    {locationDialog}
    {plotDialog}
    {dossierDialog}
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
