import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CompanionActorRuntime } from '../src/actor-runtime.ts'
import type { VirtualCompanion } from '../src/contracts.ts'

const companion: VirtualCompanion = {
  id: 'test-companion', name: '测试伙伴', handle: 'TEST', avatar: '/avatar.png', portrait: '/portrait.png',
  status: '在线', description: '测试角色', persona: '只扮演测试伙伴', style: '冷静',
  speakingStyle: '简洁', behaviorLogic: '先理解再回应', builtIn: false, createdAt: 1, updatedAt: 1,
}

function toolScope(agentVaults?: unknown): { ctx: Agent['ctx']; tools: Map<string, ToolDefinition> } {
  const tools = new Map<string, ToolDefinition>()
  const raw = { tools: { register: (definition: ToolDefinition) => {
    tools.set(definition.name, definition)
    return () => { tools.delete(definition.name) }
  } }, systemPrompt: { section: () => () => undefined }, agentVaults }
  const ctx = Object.assign(raw, {
    inject: (_dependencies: string[], callback: (scope: Agent['ctx']) => void) => {
      callback(raw as never)
      return { dispose: () => undefined }
    },
  }) as unknown as Agent['ctx']
  return { tools, ctx }
}

function fixture() {
  const room: {
    sessionId: string
    participantIds: string[]
    actorSessionIds: Record<string, string>
    narratorSessionId?: string
    epoch: number
    updatedAt: number
  } = {
    sessionId: 'room', participantIds: [companion.id], actorSessionIds: {}, epoch: 1, updatedAt: 1,
  }
  type Binding =
    | { kind: 'companion'; roomSessionId: string; companionId: string; epoch: number }
    | { kind: 'narrator'; roomSessionId: string; epoch: number }
  const bindings = new Map<string, Binding>()
  const appended: Array<{ type: string; data: unknown }> = []
  const resource = { id: 'meme-1', agentId: companion.id, enabled: true, roles: ['expression'],
    title: '开心', description: '庆祝', tags: ['表情包', '庆祝'], originalTags: [], transcript: '',
    mimeType: 'image/gif', bytes: 10, usageCount: 0, builtIn: false, createdAt: 1, updatedAt: 1,
    revision: 'resource-1', uri: 'vault://resources/records/meme-1.yml' }
  const vaults = {
    bindRuntimeAgent: vi.fn(() => () => undefined),
    inspectSelf: vi.fn(async () => ({ agentId: companion.id, modules: [], compiled: companion.persona,
      revision: 'self-1' })),
    resolveRuntimeAgent: vi.fn(() => companion.id),
    searchResources: vi.fn(async ({ agentId }: { agentId: string }) => ({
      items: agentId === companion.id ? [resource] : [], nextCursor: -1,
    })),
    resource: vi.fn(async (agentId: string, id: string) => {
      if (agentId === companion.id && id === resource.id) return resource
      throw new Error('not found')
    }),
  }
  const parentScope = toolScope(vaults)
  const parentEvents = [{
    type: 'user/message', seq: 0, time: 1,
    data: { content: [{ type: 'text', text: '你好' }] },
  }] as unknown as SessionEvent[]
  const parent = {
    id: SessionId('room'), ctx: parentScope.ctx,
    session: {
      header: { agentPreset: 'virtual-companion' },
      events: parentEvents,
      append: (type: string, data: unknown) => {
        appended.push({ type, data })
        parentEvents.push({ type, seq: parentEvents.length, time: Date.now(), data } as SessionEvent)
      },
    },
  } as unknown as Agent
  interface StartSpec {
    provider: string
    childId: SessionId
    request: { persona: string; toolFilter: { allow: string[] }; prompt: Array<{ text: string }> }
  }
  const startContinuable = vi.fn(async (spec: StartSpec) => ({
    childId: spec.childId, messageId: 'message-1',
  }))
  const followup = vi.fn(async (_parent: Agent, _childId: SessionId) => 'message-2')
  const drainContinuableChildren = vi.fn(async () => undefined)
  const deleteSession = vi.fn(async () => true)
  const directory = {
    vaults,
    resourceUrl: vi.fn((_agentId: string, id: string) => id === 'video-1'
      ? '/video.mp4'
      : id === 'builtin-public-005' ? '/gudug-manbo.mp4' : '/meme.gif'),
    knowledge: {
      tree: vi.fn(() => []), search: vi.fn(() => []), read: vi.fn(), remember: vi.fn(), audit: vi.fn(() => ({})),
    },
    companion: (id: string) => id === companion.id ? companion : undefined,
    room: (id: string) => id === room.sessionId ? room : undefined,
    actorBinding: (id: string) => bindings.get(id),
    bindActor: async (_roomId: string, companionId: string, childId: string) => {
      room.actorSessionIds = { ...room.actorSessionIds, [companionId]: childId }
      bindings.set(childId, {
        kind: 'companion', roomSessionId: room.sessionId, companionId, epoch: room.epoch ?? 0,
      })
    },
    unbindActor: async (_roomId: string, companionId: string, childId: string) => {
      if (room.actorSessionIds[companionId] !== childId) return
      room.actorSessionIds = Object.fromEntries(Object.entries(room.actorSessionIds)
        .filter(([id]) => id !== companionId))
      bindings.delete(childId)
    },
    bindNarrator: async (_roomId: string, childId: string) => {
      room.narratorSessionId = childId
      bindings.set(childId, { kind: 'narrator', roomSessionId: room.sessionId, epoch: room.epoch })
    },
    unbindNarrator: async (_roomId: string, childId: string) => {
      if (room.narratorSessionId !== childId) return
      delete room.narratorSessionId
      bindings.delete(childId)
    },
    references: {
      react: vi.fn((_request: { scopes: string[]; query: string; excludeIds: string[] }) => ({
        id: 'meme-1', title: '开心', mimeType: 'image/gif',
      })),
      url: vi.fn(() => '/meme.gif'),
      markUsed: vi.fn(),
      tagCatalog: vi.fn(() => [{ tag: '表情包', count: 3 }, { tag: '庆祝', count: 1 }]),
    },
  }
  const ctx = {
    subagents: { startContinuable, followup, drainContinuableChildren },
    agents: { get: (id: SessionId) => id === parent.id ? parent : undefined },
    get: (name: string) => name === 'sessionPersistence' ? { delete: deleteSession } : undefined,
    logger: { warn: vi.fn() },
  } as unknown as Context
  return {
    room, bindings, appended, parentScope, parent, startContinuable, followup,
    drainContinuableChildren, deleteSession, directory, ctx,
  }
}

function execution(agent: Agent) {
  return { agent, signal: new AbortController().signal } as never
}

function isCandidateResult(value: unknown): value is { candidates: unknown[] } {
  return typeof value === 'object' && value !== null && 'candidates' in value
    && Array.isArray(value.candidates)
}

function settle(runtime: CompanionActorRuntime, actorSessionId: string): void {
  runtime.handleSettled({
    runId: 'run', provider: 'fork', id: SessionId(actorSessionId), local: true,
    stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '完成' }],
  } as never)
}

describe('CompanionActorRuntime', () => {
  it('creates one stable continuable child per companion and follows up in the same context', async () => {
    const value = fixture()
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(value.parent)
    const dispatch = value.parentScope.tools.get('dispatch_companion')
    expect(dispatch).toBeDefined()
    expect([...value.parentScope.tools.keys()]).toEqual(['dispatch_companion', 'dispatch_narrator'])
    if (dispatch === undefined) throw new Error('dispatch_companion not registered')

    const firstPending = dispatch.execute({
      companion_id: companion.id, instruction: '先回应问候', evidence: '当前时间是上午',
    }, execution(value.parent)) as Promise<{ actor_session_id: string }>
    await vi.waitFor(() => { expect(value.startContinuable).toHaveBeenCalledTimes(1) })
    expect(value.startContinuable).toHaveBeenCalledTimes(1)
    const firstSpec = value.startContinuable.mock.calls[0]?.[0]
    if (firstSpec === undefined) throw new Error('continuable child not started')
    settle(runtime, firstSpec.childId)
    const first = await firstPending
    expect(firstSpec.provider).toBe('fork')
    expect(firstSpec.request.prompt[0]?.text).toContain('只扮演测试伙伴')
    expect(firstSpec.request.persona).not.toContain('月见八千代')
    expect(firstSpec.request.persona).toContain('expression_search')
    expect(firstSpec.request.persona).not.toContain('我想听歌')
    // Child-local companion tools are registered after creation and survive this restriction;
    // inherited coordinator/business tools are completely hidden.
    expect(firstSpec.request.toolFilter).toEqual({ allow: [] })
    expect(firstSpec.request.prompt[0]?.text).toContain('房主：你好')
    expect(firstSpec.request.prompt[0]?.text).toContain('<reference-channel mode="idle"')
    expect(firstSpec.request.prompt[0]?.text).toContain('不会预先注入完整目录')
    expect(value.room.actorSessionIds?.[companion.id]).toBe(first.actor_session_id)

    const secondPending = dispatch.execute({
      companion_id: companion.id, instruction: '承接上一句话', evidence: '',
    }, execution(value.parent)) as Promise<{ actor_session_id: string }>
    await vi.waitFor(() => { expect(value.followup).toHaveBeenCalledTimes(1) })
    settle(runtime, first.actor_session_id)
    const second = await secondPending
    expect(second.actor_session_id).toBe(first.actor_session_id)
    expect(value.startContinuable).toHaveBeenCalledTimes(1)
    expect(value.followup).toHaveBeenCalledTimes(1)
    expect(value.followup.mock.calls[0]?.[1]).toBe(first.actor_session_id)

  })

  it('serializes concurrent coordinator dispatches until each actor turn settles', async () => {
    const value = fixture()
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(value.parent)
    const dispatch = value.parentScope.tools.get('dispatch_companion')
    if (dispatch === undefined) throw new Error('dispatch_companion not registered')

    const first = dispatch.execute({
      companion_id: companion.id, instruction: '第一句', evidence: '',
    }, execution(value.parent)) as Promise<{ actor_session_id: string }>
    const second = dispatch.execute({
      companion_id: companion.id, instruction: '第二句', evidence: '',
    }, execution(value.parent)) as Promise<{ actor_session_id: string }>
    await vi.waitFor(() => { expect(value.startContinuable).toHaveBeenCalledTimes(1) })
    expect(value.followup).not.toHaveBeenCalled()
    const actorSessionId = value.startContinuable.mock.calls[0]?.[0].childId
    if (actorSessionId === undefined) throw new Error('continuable child not started')

    settle(runtime, actorSessionId)
    await first
    await vi.waitFor(() => { expect(value.followup).toHaveBeenCalledTimes(1) })
    settle(runtime, actorSessionId)
    await second
  })

  it('streams actor text token-by-token and preserves its exact order around references', async () => {
    const value = fixture()
    const actorId = SessionId('actor-session')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(actor)

    const express = actorScope.tools.get('express')
    const resourceFind = actorScope.tools.get('resource_find')
    const inspectRoomMember = actorScope.tools.get('inspect_room_member')
    expect(express).toBeDefined()
    expect(resourceFind).toBeDefined()
    expect(inspectRoomMember).toBeDefined()
    expect(actorScope.tools.has('companion_say')).toBe(false)
    expect(actorScope.tools.has('reference')).toBe(false)
    if (express === undefined) throw new Error('actor express tool not registered')
    if (resourceFind === undefined) throw new Error('actor resource_find tool not registered')
    if (inspectRoomMember === undefined) throw new Error('room member inspection tool not registered')
    const inspected = await inspectRoomMember.execute({ companion_id: companion.id }, execution(actor))
    expect(inspected).toMatchObject({ found: true, name: companion.name })
    if (inspected === null || typeof inspected !== 'object') throw new Error('room member result is invalid')
    const appearance: unknown = Reflect.get(inspected, 'appearance')
    expect(appearance).toContain('/portrait.png')
    await expect(resourceFind.execute({
      query: '庆祝', tags: ['表情包'], roles: ['expression'],
    }, execution(actor))).resolves.toContain('meme-1')
    const observe = (event: SessionEvent): void => {
      runtime.handleActorEvent({ id: actorId } as Session, event)
    }
    observe({ type: 'assistant/chunk', seq: 1, time: 1, data: {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '先让我' },
    } })
    observe({ type: 'assistant/chunk', seq: 2, time: 2, data: {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '看看。' },
    } })
    observe({ type: 'assistant/message', seq: 3, time: 3, data: {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '先让我看看。' }] },
    } } as SessionEvent<'assistant/message'>)
    await express.execute({ act: 'celebrate', query: '发现有趣东西' }, execution(actor))
    expect(value.directory.vaults.searchResources).toHaveBeenCalledWith(expect.objectContaining({
      agentId: companion.id, roles: ['expression'],
    }))
    observe({ type: 'assistant/chunk', seq: 4, time: 4, data: {
      turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: '找到了，就是这个。' },
    } })
    observe({ type: 'assistant/message', seq: 5, time: 5, data: {
      turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '找到了，就是这个。' }] },
    } } as SessionEvent)

    expect(value.appended.map(event => event.type)).toEqual([
      'companion/stream-start', 'companion/stream-delta', 'companion/stream-delta',
      'companion/stream-end', 'companion/expression-intent', 'companion/reference', 'companion/stream-start',
      'companion/stream-delta', 'companion/stream-end',
    ])
    expect(value.appended.map(event => event.data)).toMatchObject([
      { speaker: { type: 'companion', companionId: companion.id } },
      { text: '先让我' },
      { text: '看看。' },
      {},
      { companionId: companion.id, act: 'celebrate', assetId: 'meme-1' },
      { companionId: companion.id, assetId: 'meme-1', title: '开心' },
      { speaker: { type: 'companion', companionId: companion.id } },
      { text: '找到了，就是这个。' },
      {},
    ])

    value.room.participantIds = []
    await expect(express.execute({ act: 'reject', query: '不应送达' }, execution(actor))).rejects.toThrow(/离开房间/u)
  })

  it('emits a late-bound video as a native room event at the actor call position', async () => {
    const value = fixture()
    value.directory.vaults.searchResources.mockImplementation(async ({ agentId }: { agentId: string }) => ({
      items: agentId === companion.id ? [{ id: 'video-1', agentId: companion.id, enabled: true,
        roles: ['expression'], title: '孤高曼波', description: '庆祝视频', tags: ['视频', '庆祝'],
        originalTags: [], transcript: '', mimeType: 'video/mp4', bytes: 20, usageCount: 0,
        builtIn: false, createdAt: 1, updatedAt: 1, revision: 'video-1',
        uri: 'vault://resources/records/video-1.yml' }] : [], nextCursor: -1,
    }))
    const actorId = SessionId('video-actor-session')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(actor)
    const express = actorScope.tools.get('express')
    if (express === undefined) throw new Error('actor express tool not registered')

    await express.execute({
      act: '庆祝', query: '一起庆祝成功', tags: ['视频', '庆祝'],
    }, execution(actor))

    expect(value.directory.vaults.searchResources).toHaveBeenCalledWith(expect.objectContaining({
      agentId: companion.id, tags: ['视频', '庆祝'], roles: ['expression'],
    }))
    expect(value.appended.map(event => event.type)).toEqual([
      'companion/expression-intent', 'companion/reference',
    ])
    expect(value.appended[1]?.data).toMatchObject({
      assetId: 'video-1', title: '孤高曼波',
      mimeType: 'video/mp4', url: '/video.mp4',
    })
  })

  it('returns a named public resource in the shortlist and sends the Agent-selected id', async () => {
    const value = fixture()
    const publicHeart = {
      id: 'builtin-public-004', agentId: 'public', enabled: true, roles: ['expression'],
      title: '小南娘比心', description: '小南娘用双手比心表达喜欢', tags: ['表情包', '比心', '喜欢'],
      originalTags: [], transcript: '', mimeType: 'image/gif', bytes: 10, usageCount: 0,
      builtIn: true, createdAt: 1, updatedAt: 1, revision: 'public-heart',
      uri: 'vault://resources/records/builtin-public-004.yml',
    }
    value.directory.vaults.searchResources.mockImplementation(async ({ agentId }: { agentId: string }) => ({
      items: agentId === 'public' ? [publicHeart] : [{
        id: 'own-self', agentId: companion.id, enabled: true, roles: ['expression'], title: '是我哦',
        description: '指向自己', tags: ['表情包'], originalTags: [], transcript: '',
        mimeType: 'image/gif', bytes: 10, usageCount: 0, builtIn: true, createdAt: 1,
        updatedAt: 1, revision: 'own-self', uri: 'vault://resources/records/own-self.yml',
      }], nextCursor: -1,
    }))
    value.directory.vaults.resource.mockImplementation(async (agentId: string, id: string) => {
      if (agentId === 'public' && id === publicHeart.id) return publicHeart
      throw new Error('not found')
    })
    const actorId = SessionId('named-resource-actor')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    new CompanionActorRuntime(value.ctx, value.directory as never).install(actor)
    const search = actorScope.tools.get('expression_search')
    const express = actorScope.tools.get('express')
    if (search === undefined || express === undefined) throw new Error('expression tools not registered')

    const result = await search.execute({
      keywords: ['小南娘', '比心', '喜欢'], named_title: '小南娘比心',
    }, execution(actor))
    if (!isCandidateResult(result)) throw new Error('candidate result is invalid')
    expect(result.candidates[0]).toMatchObject({
      asset_id: publicHeart.id, title: publicHeart.title,
    })
    await expect(express.execute({ act: '比心表达喜欢', asset_ids: [publicHeart.id] }, execution(actor)))
      .resolves.toMatchObject({ sent: true, asset_id: publicHeart.id, title: publicHeart.title })
    expect(value.appended.at(-1)?.data).toMatchObject({
      assetId: publicHeart.id, title: publicHeart.title,
    })
  })

  it('discovers and delivers the bundled public video through the same resource pipeline', async () => {
    const value = fixture()
    const video = {
      id: 'builtin-public-005', agentId: 'public', enabled: true, roles: ['expression'],
      title: '孤高曼波', description: '荒诞、魔性又有气势的曼波压轴视频',
      tags: ['视频', '赛马娘', '曼波', '荒诞', '庆祝'], originalTags: [], transcript: '',
      mimeType: 'video/mp4', bytes: 5_629_565, durationMs: 23_000, usageCount: 0,
      builtIn: true, createdAt: 1, updatedAt: 1, revision: 'public-video',
      uri: 'vault://resources/records/builtin-public-005.yml',
    }
    value.directory.vaults.searchResources.mockImplementation(async ({ agentId }: { agentId: string }) => ({
      items: agentId === 'public' ? [video] : [], nextCursor: -1,
    }))
    value.directory.vaults.resource.mockImplementation(async (agentId: string, id: string) => {
      if (agentId === 'public' && id === video.id) return video
      throw new Error('not found')
    })
    const actorId = SessionId('public-video-actor')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    new CompanionActorRuntime(value.ctx, value.directory as never).install(actor)
    const search = actorScope.tools.get('expression_search')
    const express = actorScope.tools.get('express')
    if (search === undefined || express === undefined) throw new Error('expression tools not registered')

    const result = await search.execute({
      keywords: ['荒诞', '赛马娘', '曼波', '压轴'], named_title: '孤高曼波',
    }, execution(actor))
    if (!isCandidateResult(result)) throw new Error('candidate result is invalid')
    expect(result.candidates[0]).toMatchObject({
      asset_id: video.id, title: video.title, mime_type: 'video/mp4', scope: 'public',
    })

    await expect(express.execute({
      act: '用荒诞又有气势的曼波视频压轴', asset_ids: [video.id],
    }, execution(actor))).resolves.toMatchObject({ sent: true, asset_id: video.id, title: video.title })
    expect(value.appended.at(-1)?.data).toMatchObject({
      assetId: video.id, title: video.title, mimeType: 'video/mp4', url: '/gudug-manbo.mp4',
    })
  })

  it('honors a user-named video when the Agent omits named_title and selects a sticker', async () => {
    const value = fixture()
    const sticker = {
      id: 'meme-1', agentId: companion.id, enabled: true, roles: ['expression'], title: '嫌弃',
      description: '略显嫌弃的表情', tags: ['表情包', '嫌弃'], originalTags: [], transcript: '',
      mimeType: 'image/gif', bytes: 10, usageCount: 0, builtIn: true, createdAt: 1,
      updatedAt: 1, revision: 'sticker', uri: 'vault://resources/records/meme-1.yml',
    }
    const video = {
      id: 'builtin-public-005', agentId: 'public', enabled: true, roles: ['expression'],
      title: '孤高曼波', description: '赛马娘诗歌剧孤高登山曼波压轴视频',
      tags: ['视频', '赛马娘', '曼波', '荒诞', '登山', '压轴'], originalTags: [],
      transcript: '一本正经整活与孤高登山反差', mimeType: 'video/mp4', bytes: 5_629_565,
      durationMs: 23_000, usageCount: 0, builtIn: true, createdAt: 1, updatedAt: 1,
      revision: 'public-video', uri: 'vault://resources/records/builtin-public-005.yml',
    }
    value.directory.vaults.searchResources.mockImplementation(async ({ agentId }: { agentId: string }) => ({
      items: agentId === 'public' ? [video] : [sticker], nextCursor: -1,
    }))
    value.directory.vaults.resource.mockImplementation(async (agentId: string, id: string) => {
      if (agentId === 'public' && id === video.id) return video
      if (agentId === companion.id && id === sticker.id) return sticker
      throw new Error('not found')
    })
    ;(value.parent.session.events as SessionEvent[]).push({
      type: 'user/message', seq: 99, time: 99,
      data: { content: [{ type: 'text', text: '你发一下孤高曼波' }] },
    } as SessionEvent)
    const actorId = SessionId('runtime-named-video-actor')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    new CompanionActorRuntime(value.ctx, value.directory as never).install(actor)
    const search = actorScope.tools.get('expression_search')
    const express = actorScope.tools.get('express')
    if (search === undefined || express === undefined) throw new Error('reference tools not registered')

    const result = await search.execute({
      keywords: ['孤高', '帅气', '独自', '神秘'],
    }, execution(actor))
    if (!isCandidateResult(result)) throw new Error('candidate result is invalid')
    expect(result.candidates[0]).toMatchObject({
      asset_id: video.id, title: video.title, mime_type: 'video/mp4', exact_match: true,
    })
    await expect(express.execute({
      act: '独自跳出孤高帅气的曼波', asset_ids: [sticker.id],
    }, execution(actor))).resolves.toMatchObject({
      sent: true, asset_id: video.id, title: video.title,
    })
    expect(value.appended.at(-1)?.data).toMatchObject({
      assetId: video.id, title: video.title, mimeType: 'video/mp4', url: '/gudug-manbo.mp4',
    })
  })

  it('delivers mixed MIME reference resources through one natural-expression tool', async () => {
    const value = fixture()
    const resources = [
      { id: 'image-1', title: '图片', mimeType: 'image/webp' },
      { id: 'audio-1', title: '音乐', mimeType: 'audio/mpeg' },
      { id: 'video-1', title: '视频', mimeType: 'video/mp4' },
      { id: 'text-1', title: '台词', mimeType: 'text/markdown' },
      { id: 'link-1', title: '外链', mimeType: '' },
    ].map((resource, index) => ({
      ...resource, agentId: 'public', enabled: true, roles: ['expression'], description: '',
      tags: ['引用资源'], originalTags: [], transcript: '', bytes: 10, usageCount: 0,
      builtIn: false, createdAt: 1, updatedAt: 1, revision: `mixed-${index}`,
      uri: `vault://resources/records/${resource.id}.yml`,
    }))
    value.directory.vaults.resource.mockImplementation(async (agentId: string, id: string) => {
      const resource = resources.find(item => agentId === 'public' && item.id === id)
      if (resource !== undefined) return resource
      throw new Error('not found')
    })
    const actorId = SessionId('mixed-reference-actor')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    new CompanionActorRuntime(value.ctx, value.directory as never).install(actor)
    const express = actorScope.tools.get('express')
    if (express === undefined) throw new Error('reference send tool not registered')

    await expect(express.execute({
      act: '用不同媒体自然表达', asset_ids: resources.map(resource => resource.id),
    }, execution(actor))).resolves.toMatchObject({ sent: true })
    expect(value.appended.filter(event => event.type === 'companion/reference')
      .map(event => event.data))
      .toEqual(resources.map<unknown>(resource => expect.objectContaining({
        assetId: resource.id, title: resource.title, mimeType: resource.mimeType,
        url: resource.id === 'video-1' ? '/video.mp4' : '/meme.gif',
      })))
  })

  it('allows the Agent to send multiple selected assets and deliberately repeat them', async () => {
    const value = fixture()
    const second = {
      id: 'meme-2', agentId: companion.id, enabled: true, roles: ['expression'], title: '再来一张',
      description: '连续表达', tags: ['表情包'], originalTags: [], transcript: '', mimeType: 'image/gif',
      bytes: 10, usageCount: 0, builtIn: false, createdAt: 1, updatedAt: 1,
      revision: 'meme-2', uri: 'vault://resources/records/meme-2.yml',
    }
    value.directory.vaults.resource.mockImplementation(async (agentId: string, id: string) => {
      const first = (await value.directory.vaults.searchResources({ agentId: companion.id })).items[0]
      if (agentId === companion.id && id === 'meme-1' && first !== undefined) return first
      if (agentId === companion.id && id === second.id) return second
      throw new Error('not found')
    })
    const actorId = SessionId('multi-expression-actor')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    new CompanionActorRuntime(value.ctx, value.directory as never).install(actor)
    const express = actorScope.tools.get('express')
    if (express === undefined) throw new Error('express tool not registered')

    for (let index = 0; index < 2; index += 1) {
      await expect(express.execute({
        act: '连续斗图', asset_ids: ['meme-1', second.id],
      }, execution(actor))).resolves.toMatchObject({ sent: true, title: '开心、再来一张' })
    }
    expect(value.appended.filter(event => event.type === 'companion/reference')
      .map(event => String(Reflect.get(event.data as object, 'assetId'))))
      .toEqual(['meme-1', 'meme-2', 'meme-1', 'meme-2'])
  })

  it('changes only when the current user explicitly asks for a different resource', async () => {
    const value = fixture()
    const alternative = {
      id: 'meme-2', agentId: companion.id, enabled: true, roles: ['expression'], title: '俏皮眨眼',
      description: '俏皮地眨眼', tags: ['表情包', '俏皮', '眨眼'], originalTags: [], transcript: '',
      mimeType: 'image/gif', bytes: 10, usageCount: 0, builtIn: false, createdAt: 1,
      updatedAt: 1, revision: 'meme-2', uri: 'vault://resources/records/meme-2.yml',
    }
    const first = (await value.directory.vaults.searchResources({ agentId: companion.id })).items[0]
    value.directory.vaults.searchResources.mockResolvedValue({
      items: first === undefined ? [alternative] : [first, alternative], nextCursor: -1,
    })
    const actorId = SessionId('different-expression-actor')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    new CompanionActorRuntime(value.ctx, value.directory as never).install(actor)
    const express = actorScope.tools.get('express')
    const search = actorScope.tools.get('expression_search')
    if (express === undefined || search === undefined) throw new Error('expression tools not registered')

    await express.execute({ act: '比心', asset_ids: ['meme-1'] }, execution(actor))
    ;(value.parent.session.events as SessionEvent[]).push({
      type: 'user/message', seq: 99, time: 99,
      data: { content: [{ type: 'text', text: '你换个表情，不要刚才那张' }] },
    } as SessionEvent)
    const shortlist = await search.execute({ keywords: ['俏皮', '眨眼'] }, execution(actor))
    if (!isCandidateResult(shortlist)) throw new Error('candidate result is invalid')
    expect(shortlist.candidates).toEqual([expect.objectContaining({ asset_id: alternative.id })])
    await expect(express.execute({ act: '俏皮地眨眼' }, execution(actor)))
      .resolves.toMatchObject({ sent: true, asset_id: alternative.id, title: alternative.title })
    expect(value.appended.filter(event => event.type === 'companion/reference')
      .map(event => String(Reflect.get(event.data as object, 'assetId'))))
      .toEqual(['meme-1', 'meme-2'])
  })

  it('uses a bounded expression-only fallback when an emotional query has no lexical collision', async () => {
    const value = fixture()
    value.directory.vaults.searchResources.mockImplementation(async request => ({
      items: request.agentId === companion.id && Reflect.get(request, 'query') === ''
        ? [{ id: 'meme-fallback', agentId: companion.id, enabled: true,
          roles: ['expression'], title: '喝奶茶', description: '可爱表情', tags: ['表情包'],
          originalTags: [], transcript: '', mimeType: 'image/gif', bytes: 10, usageCount: 0,
          builtIn: false, createdAt: 1, updatedAt: 1, revision: 'fallback-1',
          uri: 'vault://resources/records/meme-fallback.yml' }]
        : [],
      nextCursor: -1,
    }))
    const actorId = SessionId('fallback-actor-session')
    await value.directory.bindActor(value.room.sessionId, companion.id, actorId)
    const actorScope = toolScope(value.directory.vaults)
    const actor = { id: actorId, ctx: actorScope.ctx, session: { events: [] } } as unknown as Agent
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(actor)
    const express = actorScope.tools.get('express')
    if (express === undefined) throw new Error('actor express tool not registered')

    await expect(express.execute({ act: '撒娇', query: '可爱一点' }, execution(actor)))
      .resolves.toMatchObject({ sent: true, asset_id: 'meme-fallback' })
    expect(value.directory.vaults.searchResources).toHaveBeenCalledWith(expect.objectContaining({
      agentId: companion.id, query: '', roles: ['expression'], limit: 64,
    }))
  })

  it('rolls back a reserved actor id when child creation fails', async () => {
    const value = fixture()
    value.startContinuable.mockRejectedValueOnce(new Error('provider unavailable'))
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(value.parent)
    const dispatch = value.parentScope.tools.get('dispatch_companion')
    if (dispatch === undefined) throw new Error('dispatch_companion not registered')

    await expect(dispatch.execute({
      companion_id: companion.id, instruction: '回应', evidence: '',
    }, execution(value.parent))).resolves.toMatchObject({ accepted: false })
    expect(value.room.actorSessionIds[companion.id]).toBeUndefined()
    expect(value.bindings.size).toBe(0)
    expect(value.appended.map(event => event.type)).toEqual([
      'companion/stream-start', 'companion/stream-delta', 'companion/stream-end',
    ])
    expect(value.appended[0]?.data).toMatchObject({ speaker: { type: 'narrator' } })
  })

  it('replaces a stale actor once while retaining its durable transcript', async () => {
    const value = fixture()
    const staleId = SessionId('stale-actor-session')
    await value.directory.bindActor(value.room.sessionId, companion.id, staleId)
    const unavailable = Object.assign(new Error(`subagent "${staleId}" is unavailable`), {
      code: 'NOT_RESUMABLE',
    })
    value.followup.mockRejectedValueOnce(unavailable)
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(value.parent)
    const dispatch = value.parentScope.tools.get('dispatch_companion')
    if (dispatch === undefined) throw new Error('dispatch_companion not registered')

    const pending = dispatch.execute({
      companion_id: companion.id, instruction: '继续回应用户', evidence: '',
    }, execution(value.parent)) as Promise<{ accepted: boolean; actor_session_id: string }>
    await vi.waitFor(() => { expect(value.startContinuable).toHaveBeenCalledTimes(1) })
    const replacementId = value.startContinuable.mock.calls[0]?.[0].childId
    if (replacementId === undefined) throw new Error('replacement actor not started')
    expect(replacementId).not.toBe(staleId)
    expect(value.room.actorSessionIds[companion.id]).toBe(replacementId)
    settle(runtime, replacementId)

    await expect(pending).resolves.toMatchObject({
      accepted: true,
      actor_session_id: replacementId,
    })
    expect(value.followup).toHaveBeenCalledWith(
      value.parent,
      staleId,
      expect.any(Array),
      expect.any(Object),
    )
    expect(value.drainContinuableChildren).toHaveBeenCalledWith(value.parent, [staleId])
    expect(value.deleteSession).not.toHaveBeenCalled()
    expect(value.bindings.has(staleId)).toBe(false)
  })

  it('dispatches one independent persistent narrator and streams its prose into the room', async () => {
    const value = fixture()
    const runtime = new CompanionActorRuntime(value.ctx, value.directory as never)
    runtime.install(value.parent)
    const narrator = value.parentScope.tools.get('dispatch_narrator')
    if (narrator === undefined) throw new Error('dispatch_narrator not registered')
    const pending = narrator.execute({
      instruction: '描写镜头越过安静的月台', evidence: '',
    }, execution(value.parent)) as Promise<{ accepted: boolean; actor_session_id: string }>
    await vi.waitFor(() => { expect(value.startContinuable).toHaveBeenCalledTimes(1) })
    const spec = value.startContinuable.mock.calls[0]?.[0]
    if (spec === undefined) throw new Error('narrator child not started')
    expect(spec.request.persona).toContain('公开名称只能叫“旁白”')
    expect(spec.request.persona).toContain('神态、动作、语气和状态')
    expect(value.room.narratorSessionId).toBe(spec.childId)
    runtime.handleActorEvent({ id: spec.childId } as Session, {
      type: 'assistant/chunk', seq: 1, time: 1, data: {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '镜头越过安静的月台。' },
      },
    })
    runtime.handleActorEvent({ id: spec.childId } as Session, {
      type: 'assistant/message', seq: 2, time: 2, data: {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '镜头越过安静的月台。' }] },
      },
    } as SessionEvent)
    settle(runtime, spec.childId)
    await expect(pending).resolves.toMatchObject({ accepted: true, actor_session_id: spec.childId })
    expect(value.appended.map(event => event.type)).toEqual([
      'companion/stream-start', 'companion/stream-delta', 'companion/stream-end',
    ])
    expect(value.appended[0]?.data).toMatchObject({ speaker: { type: 'narrator' } })

    await expect(narrator.execute({
      instruction: '再把同一段说明复述一遍', evidence: '措辞不同但房间位置没有变化',
    }, execution(value.parent))).resolves.toMatchObject({
      accepted: true,
      actor_session_id: spec.childId,
    })
    expect(value.startContinuable).toHaveBeenCalledTimes(1)
    expect(value.followup).not.toHaveBeenCalled()
    expect(value.appended).toHaveLength(3)
  })
})
