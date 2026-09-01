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

  it('automatically selects created and explicitly addressed projects without manual binding', async () => {
    const projectA = worldlineId<'project'>('project:scope-a')
    const projectB = worldlineId<'project'>('project:scope-b')
    const projectC = worldlineId<'project'>('project:scope-c')
    const registered: Array<{
      readonly name: string
      readonly execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
    }> = []
    let activeProjectId = projectA
    const bind = vi.fn(async (request: { readonly sessionId: ReturnType<typeof SessionId>; readonly projectId: typeof projectA }) => {
      activeProjectId = request.projectId
      return {
        sessionId: request.sessionId,
        projectId: request.projectId,
        worldlineId: worldlineId<'worldline'>(`worldline:${request.projectId.slice('project:'.length)}`),
        sourceRevision: `revision:${request.projectId}`,
        boundAt: '2026-09-01T00:00:00.000Z',
      }
    })
    const tree = vi.fn(async () => ({ entries: [] }))
    const create = vi.fn(async () => ({ manifest: { id: projectC, name: '新世界' } }))
    const ctx = {
      systemPrompt: { section() {} },
      tools: { register(tool: typeof registered[number]) { registered.push(tool) } },
      worldlineConversationContexts: {
        binding: () => ({
          sessionId: SessionId('session:scope-a'),
          projectId: activeProjectId,
          worldlineId: worldlineId<'worldline'>(`worldline:${activeProjectId.slice('project:'.length)}`),
          sourceRevision: 'revision:scope-a',
          boundAt: '2026-09-01T00:00:00.000Z',
        }),
        bind,
      },
      worldlineProjects: {
        library: vi.fn(async () => ({
          projects: [{ manifest: { id: projectA } }, { manifest: { id: projectB } }],
          total: 2,
        })),
        tree,
        create,
      },
    } as unknown as Context
    apply(ctx)
    const projectTool = registered.find(tool => tool.name === 'worldline_project')
    const queryTool = registered.find(tool => tool.name === 'worldline_query')
    if (projectTool === undefined) throw new Error('worldline_project tool is absent')
    if (queryTool === undefined) throw new Error('worldline_query tool is absent')
    const exec = { agent: { session: { id: SessionId('session:scope-a'), events: [] } } }

    const listed = JSON.parse(await projectTool.execute({ operation: 'list' }, exec)) as {
      readonly projects: unknown[]
      readonly activeProjectId: string
    }
    expect(listed.projects).toHaveLength(2)
    expect(listed.activeProjectId).toBe(projectA)

    await queryTool.execute({ operation: 'tree', project_id: projectB }, exec)
    expect(bind).toHaveBeenLastCalledWith({ sessionId: SessionId('session:scope-a'), projectId: projectB })
    expect(tree).toHaveBeenCalledWith({ projectId: projectB })

    await projectTool.execute({ operation: 'create', name: '新世界', template: 'blank' }, exec)
    expect(create).toHaveBeenCalled()
    expect(bind).toHaveBeenLastCalledWith({ sessionId: SessionId('session:scope-a'), projectId: projectC })
  })
})
