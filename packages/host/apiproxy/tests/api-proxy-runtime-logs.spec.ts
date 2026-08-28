import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`runtime-log-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

describe('runtime log API', () => {
  it('streams structured records by cursor and reports an explicit default-off recorder', async () => {
    const recordingDirectory = await mkdtemp(join(tmpdir(), 'worldline-runtime-logs-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
      runtimeLogDirectory: recordingDirectory,
    })
    const logger = ctx.logger('runtime-log-test')

    logger.info('first %s', 'record')
    const first = expectOk(await api.host.readRuntimeLogs(request({ limit: 10 })))
    expect(first.recording).toEqual({ active: false })
    expect(first.entries).toContainEqual(expect.objectContaining({
      level: 'info', source: 'runtime-log-test', message: 'first record',
    }))

    logger.debug('second record')
    const second = expectOk(await api.host.readRuntimeLogs(request({
      cursor: first.nextCursor,
      limit: 10,
    })))
    expect(second.entries).toEqual([expect.objectContaining({
      level: 'debug', source: 'runtime-log-test', message: 'second record',
    })])

    const started = expectOk(await api.host.startRuntimeLogRecording(request({})))
    expect(started.active).toBe(true)
    logger.warn('recorded message')
    const stopped = expectOk(await api.host.stopRuntimeLogRecording(request({})))
    expect(stopped).toEqual({ active: false, path: started.path })
    const file = await readFile(started.path, 'utf8')
    expect(file).toContain('"source":"runtime-log-test"')
    expect(file).toContain('"message":"recorded message"')
    await rm(recordingDirectory, { recursive: true })
  })
})
