import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  InputTriggerServiceContract,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { VirtualCompanionNavItem, type VirtualCompanionNavInjected } from './VirtualCompanionNavItem.tsx'
import { VirtualCompanionPage, type VirtualCompanionPageInjected } from './VirtualCompanionPage.tsx'
import { KnowledgeVaultNavItem, type KnowledgeVaultNavInjected } from './KnowledgeVaultNavItem.tsx'
import {
  KnowledgeVaultPage,
  type KnowledgeVaultOpenRequest,
  type KnowledgeVaultPageInjected,
} from './KnowledgeVaultPage.tsx'
import {
  CompanionAssistantContent,
  bindCompanionAccountIdentity,
  ReferenceToolView,
  CompanionRoomHeader,
  CompanionUserContent,
} from './CompanionChat.tsx'
import {
  CompanionMemePicker,
  type CompanionMemePickerInjected,
} from './CompanionMemePicker.tsx'
import {
  encodeReference,
  REFERENCE_SOURCE,
  referenceSource,
} from './reference-source.ts'
import { companionStore } from './store.ts'
import { en, zh } from './locales.ts'
import {
  companionMembershipDefinition,
  companionReferenceDefinition,
  companionStreamDefinition,
  CompanionMembershipNodeView,
  CompanionReferenceNodeView,
  CompanionStreamNodeView,
} from './RoomEvents.tsx'
import {
  CompanionProcessToggle,
  CompanionWaitingStatus,
  type CompanionWaitingStatusInjected,
} from './CompanionExperience.tsx'
import { createCompanionExperienceStore } from './store.ts'

export type { VirtualCompanionLocaleKey } from './locales.ts'
export {
  ReferenceContent,
  ReferenceRendererRegistry,
  referenceRenderers,
} from './reference-renderer.tsx'
export type {
  ReferenceRenderable,
  ReferenceRendererDefinition,
  ReferenceRendererProps,
} from './reference-renderer.tsx'
export type { VirtualCompanionNavInjected, VirtualCompanionNavProps } from './VirtualCompanionNavItem.tsx'
export type { VirtualCompanionPageInjected, VirtualCompanionPageProps } from './VirtualCompanionPage.tsx'

const NS = 'virtualCompanion'
const PAGE_ID = 'virtual-companions'
const KNOWLEDGE_PAGE_ID = 'knowledge-vault'
const PRESET_ID = 'virtual-companion'

export const inject = [
  'slots', 'layout', 'locale', 'connection', 'sessions', 'workspaces', 'inputTriggers',
  'conversation', 'conversationEvents', 'accountIdentity',
]

export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  const experienceStore = createCompanionExperienceStore()
  const waitingStatusInjected = (): CompanionWaitingStatusInjected => ({
    loadDirectory: () => { void companionStore.load() },
    hooks: { companionDirectory: companionStore },
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-virtual-companion: dictionaries')
  const activePage: HostObservable<string> = {
    getSnapshot: () => ctx.layout.activePage(),
    subscribe: listener => ctx.layout.subscribePage(listener),
  }
  let knowledgeOpenRequest: KnowledgeVaultOpenRequest | undefined
  const knowledgeOpenListeners = new Set<() => void>()
  const publishKnowledgeOpenRequest = (scope: string, path: string): void => {
    knowledgeOpenRequest = {
      scope,
      path,
      revision: (knowledgeOpenRequest?.revision ?? 0) + 1,
    }
    for (const listener of knowledgeOpenListeners) listener()
  }
  const isCompanionSession = (sessionId: SessionId): boolean =>
    ctx.sessions.list.getSnapshot().byId[sessionId]?.agentPreset === PRESET_ID
  const connectAvailableWorkspace = async (): Promise<SessionId> => {
    const workspaceState = ctx.workspaces.list.getSnapshot()
    const sessionState = ctx.sessions.list.getSnapshot()
    const currentSession = sessionState.current
    const currentWorkspace = currentSession === undefined
      ? undefined
      : workspaceState.items.find(workspace => workspace.sessionIds.includes(currentSession))
    const workspaceId = currentWorkspace?.workspaceId
      ?? workspaceState.recentWorkspaceId
      ?? workspaceState.items[0]?.workspaceId
    if (workspaceId === undefined) throw new Error(t('noWorkspace'))
    return await ctx.workspaces.connectWorkspace(workspaceId)
  }
  ctx.effect(() => bindCompanionAccountIdentity(ctx.accountIdentity), 'ui-virtual-companion: account identity')
  ctx.conversationEvents.register(companionReferenceDefinition)
  ctx.conversationEvents.register(companionMembershipDefinition)
  ctx.conversationEvents.register(companionStreamDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'companion-reference', locale: 'conversation',
  }, CompanionReferenceNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'companion-membership', locale: 'conversation',
  }, CompanionMembershipNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'companion-stream', locale: 'conversation',
  }, CompanionStreamNodeView))

  const mentionSource: InputTriggerSource = {
    trigger: '@',
    name: 'companion',
    order: -100,
    showGroupTitle: false,
    async candidates(session, { query, signal }) {
      if (!isCompanionSession(session.sessionId)) return []
      await companionStore.load()
      if (signal.aborted) return []
      const key = query.trim().toLocaleLowerCase('zh-CN')
      const companions = companionStore.getSnapshot().companions
      const everyone = key === '' || '所有伙伴'.includes(key)
        ? [{
          name: '所有伙伴',
          description: '邀请通讯录中的全部虚拟伙伴',
          icon: 'companion' as const,
          section: '虚拟伙伴',
          value: JSON.stringify({
            sessionId: session.sessionId,
            ids: companions.map(companion => companion.id),
            names: companions.map(companion => companion.name),
          }),
        }]
        : []
      return [...everyone, ...companions.filter(companion => (
        key === ''
        || companion.name.toLocaleLowerCase('zh-CN').includes(key)
        || companion.handle.toLocaleLowerCase('zh-CN').includes(key)
      )).map(companion => ({
        name: companion.name,
        description: `${companion.handle} · ${companion.description}`,
        icon: 'companion' as const,
        section: '虚拟伙伴',
        value: JSON.stringify({ sessionId: session.sessionId, ids: [companion.id], names: [companion.name] }),
      }))]
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      const value = JSON.parse(candidate.value) as { sessionId: string; ids: string[]; names: string[] }
      return {
        insert: {
          source: 'companion',
          ref: JSON.stringify(value),
          label: value.names.join('、'),
          clipboardText: value.names.map(name => `@${name}`).join(' '),
        },
      }
    },
    warm({ sessionId }) {
      if (isCompanionSession(sessionId)) void companionStore.load()
    },
    lexicon({ sessionId }) {
      if (!isCompanionSession(sessionId) || companionStore.getSnapshot().phase === 'idle') return undefined
      return ['所有伙伴', ...companionStore.getSnapshot().companions.map(companion => companion.name)]
    },
    subscribeLexicon(_session, listener) {
      return companionStore.subscribe(listener)
    },
    codec: {
      clipboardText(ref) {
        const value = JSON.parse(ref) as { names: string[] }
        return value.names.map(name => `@${name}`).join(' ')
      },
      serialize(ref, signal) {
        const value = JSON.parse(ref) as { sessionId: string; ids: string[]; names: string[] }
        signal.throwIfAborted()
        return Promise.resolve(value.names.map(name => `@${name}`).join(' '))
      },
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(mentionSource), 'ui-virtual-companion: @ source')
  ctx.effect(
    () => inputTriggers.registerSource(referenceSource),
    'ui-virtual-companion: reference draft serializer',
  )

  const navInjected = (): VirtualCompanionNavInjected => ({
    open: () => { ctx.layout.activatePage(PAGE_ID) },
    hooks: { activePage },
  })
  const knowledgeNavInjected = (): KnowledgeVaultNavInjected => ({
    open: () => { ctx.layout.activatePage(KNOWLEDGE_PAGE_ID) },
    hooks: { activePage },
  })
  const knowledgePageInjected = (): KnowledgeVaultPageInjected => ({
    getOpenRequest: () => knowledgeOpenRequest,
    subscribeOpenRequest: (listener) => {
      knowledgeOpenListeners.add(listener)
      return () => { knowledgeOpenListeners.delete(listener) }
    },
  })
  const pageInjected = (): VirtualCompanionPageInjected => ({
    openKnowledgeDocument: (companionId, path) => {
      publishKnowledgeOpenRequest(companionId, path)
      ctx.layout.activatePage(KNOWLEDGE_PAGE_ID)
    },
    launch: async (companionId) => {
      const sessionId = await connectAvailableWorkspace()
      const connected = ctx.sessions.list.getSnapshot().byId[sessionId]
      if (connected === undefined || connected.agentPreset !== PRESET_ID) {
        const response = await api.agentPresets.select({ sessionId, agentPreset: PRESET_ID })
        if (!response.result.ok) throw new Error(response.result.error.message)
        ctx.sessions.noteAgentPreset(sessionId, response.result.value.agentPreset)
      }
      await companionStore.setRoom(sessionId, [companionId])
      ctx.sessions.open(sessionId)
      ctx.layout.activatePage('conversation')
    },
  })

  ctx.slots.inject('worldline.rail.primary', () => ctx.slots.register({
    name: 'worldline.rail.primary', id: PAGE_ID, order: 20, locale: NS, inject: navInjected,
  }, VirtualCompanionNavItem))
  ctx.slots.inject('worldline.main.page', () => ctx.slots.register({
    name: 'worldline.main.page', priority: 20,
    select: owner => owner.activePage === PAGE_ID ? {} : null,
    locale: NS,
    inject: pageInjected,
  }, VirtualCompanionPage))
  ctx.slots.inject('worldline.rail.primary', () => ctx.slots.register({
    name: 'worldline.rail.primary', id: KNOWLEDGE_PAGE_ID, order: 19, inject: knowledgeNavInjected,
  }, KnowledgeVaultNavItem))
  ctx.slots.inject('worldline.main.page', () => ctx.slots.register({
    name: 'worldline.main.page', priority: 19,
    select: owner => owner.activePage === KNOWLEDGE_PAGE_ID ? {} : null,
    inject: knowledgePageInjected,
  }, KnowledgeVaultPage))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'virtual-companion-room',
    order: -40,
  }, CompanionRoomHeader))
  ctx.slots.inject('conversation.chat.assistant-content', () => ctx.slots.register({
    name: 'conversation.chat.assistant-content',
    store: experienceStore,
  }, CompanionAssistantContent))
  ctx.slots.inject('conversation.chat.user-content', () => ctx.slots.register({
    name: 'conversation.chat.user-content',
  }, CompanionUserContent))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'express',
  }, ReferenceToolView))
  const memePickerInjected = (sessionId: SessionId): CompanionMemePickerInjected => ({
    stageMeme: (meme) => {
      const actx = ctx.sessions.scope(sessionId)
      if (actx === undefined) return false
      const sessionInput = ctx.conversation.input.for(actx)
      let state = sessionInput.state.getSnapshot()
      if (state.phase !== 'plain') return false
      if (state.draft !== '' && !/\s$/u.test(state.draft)) {
        sessionInput.setDraft(`${state.draft} `)
        state = sessionInput.state.getSnapshot()
      }
      return sessionInput.insertReference({
        source: REFERENCE_SOURCE,
        ref: encodeReference(meme),
        label: `表情·${meme.title}`,
        clipboardText: `[表情：${meme.title}]`,
      }, {
        start: state.draft.length,
        end: state.draft.length,
        draftRev: state.draftRev,
      })
    },
  })
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'virtual-companion-memes',
    order: 30,
    inject: memePickerInjected,
  }, CompanionMemePicker))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'virtual-companion-process',
    order: 40,
    locale: NS,
    store: experienceStore,
  }, CompanionProcessToggle))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'virtual-companion-presence',
    order: -30,
    locale: NS,
    store: experienceStore,
    inject: waitingStatusInjected,
  }, CompanionWaitingStatus))
  ctx.effect(() => () => {
    if (ctx.layout.activePage() === PAGE_ID) ctx.layout.activatePage('conversation')
    if (ctx.layout.activePage() === KNOWLEDGE_PAGE_ID) ctx.layout.activatePage('conversation')
  }, 'ui-virtual-companion: close selected page on teardown')
}
