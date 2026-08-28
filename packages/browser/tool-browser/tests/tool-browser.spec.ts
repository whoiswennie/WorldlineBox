import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BrowserCommand, BrowserController, BrowserExecutionOptions } from '@deepseek-ai/dsh-browser'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBrowser from '../src/index.ts'

const signal = new AbortController().signal

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('tool-browser composition', () => {
  it('stays absent when the desktop browser provider is unavailable', async () => {
    const ctx = await baseContext()
    await ctx.plugin(ToolBrowser)

    expect(ctx.tools.get('browser_control')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('tool:browser-control')
  })

  it('registers the complete schema and forwards trusted Agent identity and cancellation', async () => {
    const ctx = await baseContext()
    const calls: Array<{
      sessionId: string
      command: BrowserCommand
      options?: BrowserExecutionOptions
    }> = []
    const controller: BrowserController = {
      execute: vi.fn(async (
        sessionId: string,
        command: BrowserCommand,
        options?: BrowserExecutionOptions,
      ) => {
        calls.push({ sessionId, command, ...(options === undefined ? {} : { options }) })
        return { action: command.action, tabs: [] }
      }),
    }
    await ctx.plugin((inner: Context) => { inner.provide('browserController', controller) })
    await ctx.plugin(ToolBrowser)

    const schema = ctx.tools.schemas().find(tool => tool.name === 'browser_control')
    const properties = schema?.parameters.properties as Record<string, unknown> | undefined
    const actionSchema = properties?.action as { enum?: readonly string[] } | undefined
    expect(actionSchema?.enum).toHaveLength(27)
    expect(properties).not.toHaveProperty('session_id')
    expect((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:browser-control')?.text)
      .toContain('Prefer snapshot')

    const session = Session.create(SessionId('browser-caller'))
    const agent = { id: session.id, session, options: {} } as Agent
    const result = await ctx.tools.execute({
      callId: CallId('browser-call'),
      name: 'browser_control',
      arguments: { action: 'navigate', tab_id: 'tab-1', url: 'example.com', timeout_ms: 1234 },
      agent,
      signal,
    })

    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'browser-caller',
      command: { action: 'navigate', tabId: 'tab-1', url: 'example.com', timeoutMs: 1234 },
    })
    expect(calls[0]?.options?.signal).toBe(signal)
  })
})
