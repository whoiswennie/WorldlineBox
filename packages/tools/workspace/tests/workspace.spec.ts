import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WorkspaceTools from '../src/index.ts'

async function setup(cwd: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(WorkspaceTools, { cwd }).await()
  return ctx
}

async function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: CallId(`${name}-${Date.now()}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('workspace tool plugin', () => {
  it('contributes tools through Cordis and owns their lifecycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'worldline-tools-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    const plugin = ctx.plugin(WorkspaceTools, { cwd })
    await plugin
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['edit', 'glob', 'grep', 'pwsh', 'read', 'write'])
    await plugin.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  })

  it('reads, atomically writes, edits, and searches within the workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'worldline-tools-'))
    const ctx = await setup(cwd)
    await execute(ctx, 'write', { path: 'src/example.txt', content: 'alpha\nbeta\n' })
    await execute(ctx, 'edit', { path: 'src/example.txt', old_string: 'beta', new_string: 'gamma' })
    expect(await readFile(join(cwd, 'src/example.txt'), 'utf8')).toBe('alpha\ngamma\n')
    expect((await execute(ctx, 'read', { path: 'src/example.txt' })).isError).toBe(false)
    expect((await execute(ctx, 'glob', { pattern: '**/*.txt' })).value).toMatchObject({ matches: ['src/example.txt'] })
    expect((await execute(ctx, 'grep', { pattern: 'gamma' })).value).toMatchObject({
      matches: [{ path: 'src/example.txt', line: 2, text: 'gamma' }],
    })
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  })

  it('rejects workspace escapes and executes PowerShell in the configured cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'worldline-tools-'))
    await writeFile(join(cwd, 'marker.txt'), 'ok', 'utf8')
    const ctx = await setup(cwd)
    const escaped = await execute(ctx, 'read', { path: '..\\outside.txt' })
    expect(escaped.isError).toBe(true)
    const shell = await execute(ctx, 'pwsh', { command: '(Get-Content marker.txt).Trim()' })
    expect(shell.isError).toBe(false)
    expect(shell.value).toHaveProperty('exitCode', 0)
    expect(JSON.stringify(shell.value)).toContain('ok')
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  })
})
