import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installLibraryRuntime } from '../src/index.ts'

const signal = new AbortController().signal

describe('ordinary Agent public reference runtime', () => {
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
