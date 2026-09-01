import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { apply, applyUniqueReplacement, requireConfirmation, WORLDLINE_TOOL_NAMES } from '../src/index.ts'

describe('Worldline tools', () => {
  it('registers the complete bounded business surface', () => {
    const names: string[] = []
    const ctx = {
      systemPrompt: { section() {} },
      tools: { register(tool: { name: string }) { names.push(tool.name) } },
    } as unknown as Context
    apply(ctx)
    expect(names).toEqual(WORLDLINE_TOOL_NAMES)
  })

  it('requires explicit confirmation and an unambiguous text patch', () => {
    expect(() => { requireConfirmation(false, 'freeze build') }).toThrow('confirm=true')
    expect(applyUniqueReplacement('one two', 'two', 'three')).toBe('one three')
    expect(() => applyUniqueReplacement('one one', 'one', 'two')).toThrow('not unique')
  })

  it('never lists or restores another project through a bound author Session', async () => {
    const projectA = worldlineId<'project'>('project:scope-a')
    const projectB = worldlineId<'project'>('project:scope-b')
    const registered: Array<{
      readonly name: string
      readonly execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
    }> = []
    const restoreProject = vi.fn(async () => ({}))
    const ctx = {
      systemPrompt: { section() {} },
      tools: { register(tool: typeof registered[number]) { registered.push(tool) } },
      worldlineConversationContexts: {
        binding: () => ({
          sessionId: SessionId('session:scope-a'),
          projectId: projectA,
          worldlineId: worldlineId<'worldline'>('worldline:scope-a'),
          sourceRevision: 'revision:scope-a',
          boundAt: '2026-09-01T00:00:00.000Z',
        }),
      },
      worldlineProjects: {
        listTrashedProjects: vi.fn(async () => [
          { trashId: 'trash-a', manifest: { id: projectA } },
          { trashId: 'trash-b', manifest: { id: projectB } },
        ]),
        restoreProject,
      },
    } as unknown as Context
    apply(ctx)
    const projectTool = registered.find(tool => tool.name === 'worldline_project')
    if (projectTool === undefined) throw new Error('worldline_project tool is absent')
    const exec = { agent: { session: { events: [] } } }

    const listed = JSON.parse(await projectTool.execute({ operation: 'trashed' }, exec)) as unknown[]
    expect(listed).toEqual([{ trashId: 'trash-a', manifest: { id: projectA } }])
    await expect(projectTool.execute({
      operation: 'restore', trash_id: 'trash-b', confirm: true,
    }, exec)).rejects.toThrow('outside the Session binding')
    expect(restoreProject).not.toHaveBeenCalled()
    await expect(projectTool.execute({
      operation: 'restore', trash_id: 'trash-a', confirm: true,
    }, exec)).resolves.toBe('{}')
    expect(restoreProject).toHaveBeenCalledWith({ trashId: 'trash-a' })
  })
})
