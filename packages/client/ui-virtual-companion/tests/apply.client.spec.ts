import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ConversationEventRegistry, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import type { VirtualCompanionPageInjected } from '../src/client/VirtualCompanionPage.tsx'

describe('ui-virtual-companion apply', () => {
  it('launches the built-in preset through a blank workspace session', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      value: { companions: [], rooms: { 'companion-session': { sessionId: 'companion-session', participantIds: ['yachiyo-runami'], updatedAt: 1 } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    new ConversationEventRegistry(ctx)
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    const activatePage = vi.fn()
    ctx.provide('layout', {
      activePage: () => 'virtual-companions',
      subscribePage: () => () => {},
      activatePage,
    } as never)
    const sessionId = 'companion-session' as never
    const workspaceId = 'workspace' as never
    const connectWorkspace = vi.fn(() => Promise.resolve(sessionId))
    ctx.provide('workspaces', {
      list: { getSnapshot: () => ({
        items: [{ workspaceId, path: '/workspace', sessionIds: [] }],
        recentWorkspaceId: workspaceId,
      }) },
      connectWorkspace,
    } as never)
    const noteAgentPreset = vi.fn()
    const open = vi.fn()
    ctx.provide('sessions', {
      list: { getSnapshot: () => ({ current: undefined, byId: {} }) },
      noteAgentPreset,
      open,
    } as never)
    const select = vi.fn(() => Promise.resolve({
      rpcId: 'select',
      result: { ok: true as const, value: { agentPreset: 'virtual-companion' } },
    }))
    ctx.provide('connection', { api: { agentPresets: { select } } } as never)
    ctx.provide('inputTriggers', { registerSource: () => () => {} } as never)
    ctx.provide('conversation', { selectView: vi.fn() } as never)
    ctx.provide('accountIdentity', {
      getSnapshot: () => ({ loading: false, user: null, savedAccounts: [], error: '' }),
      subscribe: () => () => {},
    } as never)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'worldline.rail.primary': { kind: 'list', scope: 'root' },
        'worldline.main.page': { kind: 'chain', scope: 'root' },
        'conversation.input.left': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
        'conversation.chat.assistant-content': { kind: 'single', scope: 'session' },
        'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)

    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('worldline.rail.primary')).toHaveLength(2)
    expect(slots.entries('worldline.main.page')).toHaveLength(2)
    expect(slots.entries('conversation.input.left').map(entry => entry.options.id)).toEqual([
      'virtual-companion-memes',
      'virtual-companion-process',
    ])
    expect(slots.entries('conversation.input.dock').map(entry => entry.options.id))
      .toEqual(['virtual-companion-presence'])
    expect(slots.entries('conversation.chat.assistant-content')).toHaveLength(1)
    expect(slots.entries('tool.call.toolview').map(entry => entry.options.key)).toEqual(['express'])
    const injected = slots.entries('worldline.main.page')
      .map(page => (page.inject as unknown as () => Partial<VirtualCompanionPageInjected>)())
      .find(value => typeof value.launch === 'function') as VirtualCompanionPageInjected

    await injected.launch('yachiyo-runami')

    expect(connectWorkspace).toHaveBeenCalledWith(workspaceId)
    expect(select).toHaveBeenCalledWith({ sessionId, agentPreset: 'virtual-companion' })
    expect(noteAgentPreset).toHaveBeenCalledWith(sessionId, 'virtual-companion')
    expect(open).toHaveBeenCalledWith(sessionId)
    expect(fetchMock).toHaveBeenCalledWith('/api/virtual-companions/room', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId, participantIds: ['yachiyo-runami'] }),
    }))
    expect(activatePage).toHaveBeenLastCalledWith('conversation')
  })
})
