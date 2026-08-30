import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installLibraryRuntime } from '../src/index.ts'
import { DEFAULT_COMPANION_ART_OPTIONS } from '../src/contracts.ts'

const signal = new AbortController().signal

describe('ordinary Agent public reference runtime', () => {
  it('creates a companion through the Agent-facing tool and leaves artwork optional', async () => {
    const tools = new Map<string, ToolDefinition>()
    const companion = {
      id: 'created-companion', name: '新伙伴', handle: 'GUIDE',
      avatar: '/worldline-experience/default-companion.png',
      portrait: '/worldline-experience/default-companion.png', status: '在线', description: '简介',
      persona: '身份', style: '温和', speakingStyle: '清晰', behaviorLogic: '边界', builtIn: false,
      createdAt: 1, updatedAt: 1,
    }
    const create = vi.fn(async (_draft: Record<string, string>) => ({ companions: [companion], rooms: {} }))
    const vaults = {
      bindRuntimeAgent: vi.fn(() => () => undefined),
      manifest: vi.fn(async () => ({ agent: { id: companion.id, name: companion.name } })),
    }
    const directory = {
      ready: Promise.resolve(), vaults, create,
      resourceUrl: (_agentId: string, id: string) => `/references/${id}`,
    }
    const ctx = {
      systemPrompt: { context: vi.fn(() => () => undefined) },
      tools: { register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      } },
    }
    const dispose = installLibraryRuntime(directory as never, {
      id: 'ordinary-agent', ctx,
    } as unknown as Agent)
    try {
      const tool = tools.get('create_virtual_companion')
      expect(tool).toBeDefined()
      if (tool === undefined) throw new Error('companion creation tool not registered')
      await expect(tool.execute({
        name: companion.name, handle: companion.handle, status: companion.status,
        description: companion.description, persona: companion.persona, style: companion.style,
        speaking_style: companion.speakingStyle, behavior_logic: companion.behaviorLogic,
      }, {} as never)).resolves.toEqual({
        companion_id: companion.id, name: companion.name, avatar: companion.avatar, vault_ready: true,
        knowledge_roots: ['self', 'memory', 'procedures', 'resources', 'skills'],
      })
      const createdDraft = create.mock.calls[0]?.[0]
      expect(DEFAULT_COMPANION_ART_OPTIONS).toContain(createdDraft?.avatar)
      expect(createdDraft?.portrait).toBe(createdDraft?.avatar)
      expect(createdDraft?.handle).toBe('GUIDE · 在线')
      expect(vaults.manifest).toHaveBeenCalledWith(companion.id)
    } finally {
      dispose()
    }
  })

  it('selects Huan\'s bundled dark form when the Agent creation request asks for it', async () => {
    const tools = new Map<string, ToolDefinition>()
    const companion = {
      id: 'dark-companion', name: '黑色形态伙伴', handle: 'DARK GUIDE',
      avatar: '/worldline-experience/default-companion-dark.png',
      portrait: '/worldline-experience/default-companion-dark.png', status: '在线', description: '简介',
      persona: '身份', style: '沉稳', speakingStyle: '清晰', behaviorLogic: '边界', builtIn: false,
      createdAt: 1, updatedAt: 1,
    }
    const create = vi.fn(async () => ({ companions: [companion], rooms: {} }))
    const directory = {
      ready: Promise.resolve(), create,
      vaults: { bindRuntimeAgent: vi.fn(() => () => undefined), manifest: vi.fn(async () => ({})) },
      resourceUrl: (_agentId: string, id: string) => `/references/${id}`,
    }
    const ctx = {
      systemPrompt: { context: vi.fn(() => () => undefined) },
      tools: { register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      } },
    }
    const dispose = installLibraryRuntime(directory as never,
      { id: 'ordinary-agent', ctx } as unknown as Agent)
    try {
      const tool = tools.get('create_virtual_companion')
      if (tool === undefined) throw new Error('companion creation tool not registered')
      await tool.execute({
        name: companion.name, handle: companion.handle, status: companion.status,
        description: companion.description, persona: companion.persona, style: companion.style,
        speaking_style: companion.speakingStyle, behavior_logic: companion.behaviorLogic,
        appearance_variant: 'dark',
      }, {} as never)
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        avatar: companion.avatar, portrait: companion.portrait,
      }))
    } finally {
      dispose()
    }
  })

  it('finds and sends a named public video despite mixed keywords and guessed tags', async () => {
    const tools = new Map<string, ToolDefinition>()
    const resource = {
      id: 'builtin-public-005', agentId: 'public', enabled: true, roles: ['expression'],
      title: '孤高曼波', description: '一本正经整活', tags: ['曼波', '视频'], originalTags: [],
      transcript: '', mimeType: 'video/mp4', bytes: 100, usageCount: 0, builtIn: true,
      createdAt: 1, updatedAt: 1, revision: 'rev',
      uri: 'vault://resources/records/builtin-public-005.yml',
    }
    const vaults = {
      bindRuntimeAgent: vi.fn(() => () => undefined),
      searchResources: vi.fn(async (input: { query: string }) => ({
        items: input.query === '' ? [resource] : [], nextCursor: -1,
      })),
      resource: vi.fn(async (_agentId: string, id: string) => {
        if (id === resource.id) return resource
        throw new Error('missing')
      }),
    }
    const ctx = {
      systemPrompt: { context: vi.fn(() => () => undefined) },
      tools: { register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      } },
    }
    const directory = {
      vaults,
      resourceUrl: (_agentId: string, id: string) => `/references/${id}`,
    }
    const dispose = installLibraryRuntime(directory as never, {
      id: 'ordinary-agent', ctx,
    } as unknown as Agent)
    try {
      const search = tools.get('expression_search')
      const express = tools.get('express')
      expect(search).toBeDefined()
      expect(express).toBeDefined()
      if (search === undefined || express === undefined) throw new Error('reference tools not registered')

      await expect(search.execute({
        keywords: ['meme', '表情包'], named_title: '孤高曼波',
      }, {} as never)).resolves.toMatchObject({
        candidates: [{ asset_id: resource.id, title: resource.title }],
      })
      await expect(express.execute({
        act: 'meme', query: '孤高曼波 表情包', tags: ['manbo', 'meme'],
      }, {} as never)).resolves.toMatchObject({
        found: true, asset_id: resource.id, title: resource.title,
        url: `/references/${resource.id}`, mime_type: 'video/mp4',
      })
    } finally {
      dispose()
    }
  })

  it('persists resolved media metadata for the Client tool renderer', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const resource = {
      id: 'builtin-public-005', agentId: 'public', enabled: true, roles: ['expression'],
      title: '孤高曼波', description: '一本正经整活', tags: ['曼波', '视频'], originalTags: [],
      transcript: '', mimeType: 'video/mp4', bytes: 100, usageCount: 0, builtIn: true,
      createdAt: 1, updatedAt: 1, revision: 'rev',
      uri: 'vault://resources/records/builtin-public-005.yml',
    }
    const vaults = {
      bindRuntimeAgent: vi.fn(() => () => undefined),
      searchResources: vi.fn(async () => ({ items: [resource], nextCursor: -1 })),
      resource: vi.fn(async (_agentId: string, id: string) => {
        if (id === resource.id) return resource
        throw new Error('missing')
      }),
    }
    const directory = {
      vaults,
      resourceUrl: (_agentId: string, id: string) => `/references/${id}`,
    }
    const session = Session.create(SessionId('ordinary-reference-presentation'))
    const agent = { id: session.id, ctx, session, options: {} } as unknown as Agent
    const dispose = installLibraryRuntime(directory as never, agent)
    try {
      const result = await ctx.tools.execute({
        signal, agent, callId: CallId('express-public-video'), name: 'express',
        arguments: { asset_id: resource.id, act: 'play' },
      })
      expect(result).toMatchObject({
        isError: false,
        meta: {
          found: true, asset_id: resource.id, title: resource.title,
          url: `/references/${resource.id}`, mime_type: 'video/mp4',
        },
      })
    } finally {
      dispose()
      await ctx.fiber.dispose()
    }
  })
})
