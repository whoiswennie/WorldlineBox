import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { WorldlineNavItem, type WorldlineNavInjected } from './WorldlineNavItem.tsx'
import { WorldlineStudio } from './WorldlineStudio.tsx'
import type { WorldlineStudioInjected } from './types.ts'
import { en, zh } from './locales.ts'

export type { WorldlineStudioInjected } from './types.ts'
export type { WorldlineLocaleKey } from './locales.ts'

export const NS = 'worldlineStudio'
export const inject = [
  'slots', 'layout', 'locale', 'remote', 'remote.worldlineProjects',
  'remote.worldlineCompiler', 'remote.worldlineRuns', 'remote.worldlineAi',
  'remote.worldlineNarrative', 'workspaces',
  'connection', 'sessions',
]
const PAGE_ID = 'worldline-studio'
const AUTHOR_PRESET = 'worldline-author'

interface RemoteEnvelope<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

async function invoke<T>(call: Promise<RemoteEnvelope<T>>): Promise<T> {
  const result = await call
  if (!result.ok) {
    throw new Error(`${result.error?.code ?? 'REMOTE_ERROR'}: ${result.error?.message ?? 'unknown error'}`)
  }
  return result.value as T
}

async function narrateStream(
  request: import('@deepseek-ai/dsh-worldline-narrative/types').NarrateRequest,
  onChunk: (chunk: import('@deepseek-ai/dsh-worldline-narrative/types').NarrativeStreamChunk) => void,
): Promise<import('@deepseek-ai/dsh-worldline-standard/types').NarrativeBeat> {
  const response = await fetch('/api/worldline/narrative/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(request),
  })
  if (!response.ok || response.body === null) throw new Error(`NARRATIVE_STREAM: HTTP ${String(response.status)}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let beat: import('@deepseek-ai/dsh-worldline-standard/types').NarrativeBeat | undefined
  while (true) {
    const item = await reader.read()
    pending += decoder.decode(item.value, { stream: !item.done })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      const chunk = JSON.parse(line) as import('@deepseek-ai/dsh-worldline-narrative/types').NarrativeStreamChunk
      onChunk(chunk)
      if (chunk.type === 'beat') beat = chunk.beat
    }
    if (item.done) break
  }
  if (pending.trim() !== '') {
    const chunk = JSON.parse(pending) as import('@deepseek-ai/dsh-worldline-narrative/types').NarrativeStreamChunk
    onChunk(chunk)
    if (chunk.type === 'beat') beat = chunk.beat
  }
  if (beat === undefined) throw new Error('NARRATIVE_STREAM: stream ended without a retained beat')
  return beat
}

export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-worldline: dictionaries')
  const studioInjected = (): WorldlineStudioInjected => ({
    projects: {
      root: async () => await invoke(ctx.remote.worldlineProjects.root()),
      setRoot: async request => await invoke(ctx.remote.worldlineProjects.setRoot(request)),
      library: async query => await invoke(ctx.remote.worldlineProjects.library(query)),
      rescan: async () => await invoke(ctx.remote.worldlineProjects.rescan()),
      create: async request => await invoke(ctx.remote.worldlineProjects.create(request)),
      copyProject: async request => await invoke(ctx.remote.worldlineProjects.copyProject(request)),
      trashProject: async request => await invoke(ctx.remote.worldlineProjects.trashProject(request)),
      listTrashedProjects: async () => await invoke(ctx.remote.worldlineProjects.listTrashedProjects()),
      restoreProject: async request => await invoke(ctx.remote.worldlineProjects.restoreProject(request)),
      tree: async request => await invoke(ctx.remote.worldlineProjects.tree(request)),
      read: async request => await invoke(ctx.remote.worldlineProjects.read(request)),
      write: async request => await invoke(ctx.remote.worldlineProjects.write(request)),
      createDirectory: async request => await invoke(ctx.remote.worldlineProjects.createDirectory(request)),
      move: async request => await invoke(ctx.remote.worldlineProjects.move(request)),
      copyEntry: async request => await invoke(ctx.remote.worldlineProjects.copyEntry(request)),
      trashEntry: async request => await invoke(ctx.remote.worldlineProjects.trashEntry(request)),
      listTrashedEntries: async projectId => await invoke(ctx.remote.worldlineProjects.listTrashedEntries(projectId)),
      restoreEntry: async request => await invoke(ctx.remote.worldlineProjects.restoreEntry(request)),
      history: async request => await invoke(ctx.remote.worldlineProjects.history(request)),
      restoreRevision: async request => await invoke(ctx.remote.worldlineProjects.restoreRevision(request)),
      search: async request => await invoke(ctx.remote.worldlineProjects.search(request)),
      backlinks: async request => await invoke(ctx.remote.worldlineProjects.backlinks(request)),
      exportProject: async request => await invoke(ctx.remote.worldlineProjects.exportProject(request)),
      importProject: async request => await invoke(ctx.remote.worldlineProjects.importProject(request)),
      exportBlueprint: async request => await invoke(ctx.remote.worldlineProjects.exportBlueprint(request)),
      importBlueprint: async request => await invoke(ctx.remote.worldlineProjects.importBlueprint(request)),
      exportRun: async request => await invoke(ctx.remote.worldlineProjects.exportRun(request)),
      importRun: async request => await invoke(ctx.remote.worldlineProjects.importRun(request)),
      transfer: async id => await invoke(ctx.remote.worldlineProjects.transfer(id)),
      cancelTransfer: async id => await invoke(ctx.remote.worldlineProjects.cancelTransfer(id)),
    },
    compiler: {
      state: async projectId => await invoke(ctx.remote.worldlineCompiler.state(projectId)),
      compile: async request => await invoke(ctx.remote.worldlineCompiler.compile(request)),
      answerQuestion: async request => await invoke(ctx.remote.worldlineCompiler.answerQuestion(request)),
      submitProposal: async request => await invoke(ctx.remote.worldlineCompiler.submitProposal(request)),
      reviewProposal: async request => await invoke(ctx.remote.worldlineCompiler.reviewProposal(request)),
      freeze: async request => await invoke(ctx.remote.worldlineCompiler.freeze(request)),
      explain: async request => await invoke(ctx.remote.worldlineCompiler.explain(request)),
    },
    runs: {
      create: async request => await invoke(ctx.remote.worldlineRuns.create(request)),
      list: async () => await invoke(ctx.remote.worldlineRuns.list()),
      view: async request => await invoke(ctx.remote.worldlineRuns.view(request)),
      spatial: async request => await invoke(ctx.remote.worldlineRuns.spatial(request)),
      choices: async request => await invoke(ctx.remote.worldlineRuns.choices(request)),
      advance: async request => await invoke(ctx.remote.worldlineRuns.advance(request)),
      submitAction: async request => await invoke(ctx.remote.worldlineRuns.submitAction(request)),
      pause: async request => await invoke(ctx.remote.worldlineRuns.pause(request)),
      resume: async request => await invoke(ctx.remote.worldlineRuns.resume(request)),
      stop: async request => await invoke(ctx.remote.worldlineRuns.stop(request)),
      records: async request => await invoke(ctx.remote.worldlineRuns.records(request)),
      checkpoint: async request => await invoke(ctx.remote.worldlineRuns.checkpoint(request)),
      checkpoints: async request => await invoke(ctx.remote.worldlineRuns.checkpoints(request)),
      branch: async request => await invoke(ctx.remote.worldlineRuns.branch(request)),
      setControl: async request => await invoke(ctx.remote.worldlineRuns.setControl(request)),
      setAiEnabled: async request => await invoke(ctx.remote.worldlineRuns.setAiEnabled(request)),
      switchModel: async request => await invoke(ctx.remote.worldlineRuns.switchModel(request)),
      explain: async request => await invoke(ctx.remote.worldlineRuns.explain(request)),
    },
    ai: {
      catalog: async () => await invoke(ctx.remote.worldlineAi.catalog()),
      contextPack: async request => await invoke(ctx.remote.worldlineAi.contextPack(request)),
      budget: async request => await invoke(ctx.remote.worldlineAi.budget(request)),
      decide: async request => await invoke(ctx.remote.worldlineAi.decide(request)),
    },
    narrative: {
      open: async request => await invoke(ctx.remote.worldlineNarrative.open(request)),
      scene: async request => await invoke(ctx.remote.worldlineNarrative.scene(request)),
      narrate: async request => await invoke(ctx.remote.worldlineNarrative.narrate(request)),
      narrateStream,
      choose: async request => await invoke(ctx.remote.worldlineNarrative.choose(request)),
      freeInput: async request => await invoke(ctx.remote.worldlineNarrative.freeInput(request)),
      rephrase: async request => await invoke(ctx.remote.worldlineNarrative.rephrase(request)),
      save: async request => await invoke(ctx.remote.worldlineNarrative.save(request)),
      branch: async request => await invoke(ctx.remote.worldlineNarrative.branch(request)),
      retry: async request => await invoke(ctx.remote.worldlineNarrative.retry(request)),
      storyStage: async () => await invoke(ctx.remote.worldlineNarrative.storyStage()),
    },
    pickDirectory: () => ctx.workspaces.pickDirectory(),
    openPath: path => ctx.workspaces.openPath(path),
    launchConversation: async (project, runId) => {
      const sessionId = await ctx.sessions.create({ cwd: project.path })
      try {
        const selected = await api.agentPresets.select({ sessionId, agentPreset: AUTHOR_PRESET })
        if (!selected.result.ok) throw new Error(selected.result.error.message)
        ctx.sessions.noteAgentPreset(sessionId, selected.result.value.agentPreset)
        const response = await fetch('/api/worldline/conversation/bind', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, projectId: project.manifest.id, ...(runId === undefined ? {} : { runId }) }),
        })
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { error?: string }
          throw new Error(result.error ?? `conversation binding failed: HTTP ${String(response.status)}`)
        }
      } catch (error) {
        await ctx.sessions.delete(sessionId).catch(() => undefined)
        throw error
      }
      ctx.sessions.open(sessionId)
      ctx.layout.activatePage('conversation')
    },
  })
  const navInjected = (): WorldlineNavInjected => ({
    pageId: PAGE_ID,
    open: () => { ctx.layout.activatePage(PAGE_ID) },
    activePage: () => ctx.layout.activePage(),
    subscribePage: listener => ctx.layout.subscribePage(listener),
  })
  ctx.slots.inject('worldline.rail.primary', () => ctx.slots.register({
    name: 'worldline.rail.primary', id: PAGE_ID, order: 21, locale: NS, inject: navInjected,
  }, WorldlineNavItem))
  ctx.slots.inject('worldline.main.page', () => ctx.slots.register({
    name: 'worldline.main.page', priority: 21,
    select: owner => owner.activePage === PAGE_ID ? {} : null,
    locale: NS,
    inject: studioInjected,
  }, WorldlineStudio))
  ctx.effect(() => () => {
    if (ctx.layout.activePage() === PAGE_ID) ctx.layout.activatePage('conversation')
  }, 'ui-worldline: close selected page on teardown')
}
