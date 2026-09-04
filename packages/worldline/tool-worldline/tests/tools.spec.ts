import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import {
  apply,
  applyUniqueReplacement,
  hasLoadedWorldlineAuthoringSkill,
  hasLoadedWorldlineSkill,
  requireConfirmation,
  WORLDLINE_TOOL_NAMES,
} from '../src/index.ts'

function loadedSkillEvents(...skillNames: readonly string[]) {
  return skillNames.flatMap((skillName, index) => {
    const callId = `call:${skillName}`
    return [{
      type: 'tool/call', seq: index * 2 + 1, time: index * 2 + 1,
      data: {
        turn: 1, step: index + 1, callId, name: 'skill',
        arguments: JSON.stringify({ name: skillName }),
      },
    }, {
      type: 'tool/result', seq: index * 2 + 2, time: index * 2 + 2,
      data: {
        turn: 1, step: index + 1,
        message: {
          id: `message:${skillName}`, role: 'user',
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId,
            content: [{ type: 'text', text: 'loaded' }],
          }],
        },
      },
    }]
  }) as never
}

function loadedAuthoringEvents() {
  return loadedSkillEvents('worldline-authoring')
}

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

  it('requires a successful root authoring skill load before agent mutations', () => {
    expect(hasLoadedWorldlineAuthoringSkill({ events: [] })).toBe(false)
    expect(hasLoadedWorldlineAuthoringSkill({ events: loadedAuthoringEvents() })).toBe(true)
    expect(hasLoadedWorldlineSkill({ events: loadedAuthoringEvents() }, 'worldline-map-design'))
      .toBe(false)
    expect(hasLoadedWorldlineSkill({
      events: loadedSkillEvents('worldline-authoring', 'worldline-map-design'),
    }, 'worldline-map-design')).toBe(true)
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
    const setRoot = vi.fn(async () => ({
      destination: '/fresh-author-workspace', projects: [], conflicts: [], requiredBytes: 0, dryRun: false,
    }))
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
        root: vi.fn(async () => ({ configured: true, path: '/previous-library', writable: true, projectCount: 2 })),
        setRoot,
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
    const editTool = registered.find(tool => tool.name === 'worldline_edit')
    const buildTool = registered.find(tool => tool.name === 'worldline_build')
    if (projectTool === undefined) throw new Error('worldline_project tool is absent')
    if (queryTool === undefined) throw new Error('worldline_query tool is absent')
    if (editTool === undefined) throw new Error('worldline_edit tool is absent')
    if (buildTool === undefined) throw new Error('worldline_build tool is absent')
    const exec = { agent: { session: {
      id: SessionId('session:scope-a'),
      events: loadedAuthoringEvents(),
      header: {
        version: 0,
        id: SessionId('session:scope-a'),
        createdAt: 0,
        cwd: '/fresh-author-workspace',
      },
    } } }
    const unskilledExec = { agent: { session: {
      id: SessionId('session:scope-a'),
      events: [],
      header: exec.agent.session.header,
    } } }

    await expect(projectTool.execute({
      operation: 'create', name: '不应创建', template: 'blank',
    }, unskilledExec)).rejects.toThrow('worldline-authoring')
    expect(setRoot).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()

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
    expect(setRoot).toHaveBeenCalledWith({
      path: '/fresh-author-workspace',
      create: true,
      relocateExisting: false,
    })
    expect(create).toHaveBeenCalled()
    expect(bind).toHaveBeenLastCalledWith({ sessionId: SessionId('session:scope-a'), projectId: projectC })

    await expect(editTool.execute({
      operation: 'create', path: 'characters/reader.md', content: '# Reader', dry_run: false,
    }, exec)).rejects.toThrow('worldline-character-design')
    await expect(buildTool.execute({
      operation: 'freeze', expected_source_digest: 'digest:test', confirm: true,
    }, exec)).rejects.toThrow('worldline-build-audit')
  })

  it('imports a workspace-local binary without exposing its bytes and rejects workspace escape', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'worldline-tool-assets-'))
    const outside = await mkdtemp(join(tmpdir(), 'worldline-tool-outside-'))
    try {
      await writeFile(join(workspace, 'portrait.png'), new Uint8Array([1, 2, 3, 4]))
      await writeFile(join(outside, 'secret.png'), new Uint8Array([9]))
      const id = worldlineId<'project'>('project:asset-import')
      const registered: Array<{
        readonly name: string
        readonly execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
      }> = []
      const importEntry = vi.fn(async (_request: unknown, source: AsyncIterable<Uint8Array>) => {
        const chunks: Uint8Array[] = []
        for await (const chunk of source) chunks.push(chunk)
        return { projectId: id, path: 'assets/portrait.png', chunks }
      })
      const ctx = {
        systemPrompt: { section() {} },
        tools: { register(tool: typeof registered[number]) { registered.push(tool) } },
        worldlineConversationContexts: {
          binding: () => ({
            sessionId: SessionId('session:asset-import'), projectId: id,
            worldlineId: worldlineId<'worldline'>('worldline:asset-import'),
            sourceRevision: 'revision:asset-import', boundAt: '2026-09-03T00:00:00.000Z',
          }),
        },
        worldlineProjects: { importEntry },
      } as unknown as Context
      apply(ctx)
      const editTool = registered.find(tool => tool.name === 'worldline_edit')
      if (editTool === undefined) throw new Error('worldline_edit tool is absent')
      const exec = { agent: { session: {
        id: SessionId('session:asset-import'), events: loadedAuthoringEvents(),
        header: { version: 0, id: SessionId('session:asset-import'), createdAt: 0, cwd: workspace },
      } } }

      const preview = JSON.parse(await editTool.execute({
        operation: 'import-local', source: 'portrait.png', destination: 'assets/portrait.png',
      }, exec)) as { readonly dryRun: boolean; readonly sizeBytes: number }
      expect(preview).toMatchObject({ dryRun: true, sizeBytes: 4 })
      expect(importEntry).not.toHaveBeenCalled()

      await editTool.execute({
        operation: 'import-local', source: 'portrait.png', destination: 'assets/portrait.png', dry_run: false,
      }, exec)
      expect(importEntry).toHaveBeenCalledWith({
        projectId: id, path: 'assets/portrait.png', expectedBytes: 4,
      }, expect.anything())

      const escaped = await realpath(join(outside, 'secret.png'))
      await expect(editTool.execute({
        operation: 'import-local', source: escaped, destination: 'assets/secret.png', dry_run: false,
      }, exec)).rejects.toThrow('source must stay inside the current Agent workspace')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
