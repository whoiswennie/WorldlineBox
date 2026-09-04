import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import {
  acceptanceScenarios,
  charterDocument,
  characterDocument,
  mechanismDocument,
  openingScenarioDocument,
  runtimeSemanticDocument,
  timelineDocument,
} from '../../../../fixtures/worldline/scenarios.ts'
import WorldlineCompiler from '../../compiler/src/index.ts'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorkerWorldlineRuns from '../../runtime-worker/src/index.ts'
import { apply } from '../src/index.ts'

const roots: string[] = []

function loadedWorldlineSkillEvents() {
  const skills = [
    'worldline-authoring',
    'worldline-character-design',
    'worldline-map-design',
    'worldline-mechanism-design',
    'worldline-scenario-design',
    'worldline-build-audit',
  ]
  return skills.flatMap((skillName, index) => {
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
          id: `message:${skillName}`, role: 'user', source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result', toolCallId: callId,
            content: [{ type: 'text', text: 'loaded' }],
          }],
        },
      },
    }]
  }) as never
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Worldline OC author tool closure', () => {
  it('authors a structured map and proves a warrior-versus-dragon autonomous loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-tool-closure-'))
    roots.push(root)
    const services = new Context()
    const projects = services.plugin(LocalWorldlineProjects, {
      root,
      maxEntries: 5_000,
      maxSearchFiles: 50_000,
    })
    await projects.await()
    const compiler = services.plugin(WorldlineCompiler)
    await compiler.await()
    const runs = services.plugin(WorkerWorldlineRuns, {
      maxOldGenerationSizeMb: 128,
      requestTimeoutMs: 15_000,
    })
    await runs.await()

    const registered: Array<{
      readonly name: string
      readonly execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
    }> = []
    let activeProjectId: string | undefined
    const context = {
      systemPrompt: { section() {} },
      tools: { register(tool: typeof registered[number]) { registered.push(tool) } },
      worldlineProjects: services.worldlineProjects,
      worldlineCompiler: services.worldlineCompiler,
      worldlineRuns: services.worldlineRuns,
      worldlineConversationContexts: {
        binding: () => activeProjectId === undefined ? undefined : ({
          sessionId: SessionId('session:closed-loop'),
          projectId: worldlineId<'project'>(activeProjectId),
          worldlineId: worldlineId<'worldline'>('worldline:closed-loop'),
          sourceRevision: 'revision:closed-loop',
          boundAt: '2026-09-01T00:00:00.000Z',
        }),
        bind: vi.fn(async (request: { readonly projectId: string; readonly runId?: string }) => {
          activeProjectId = request.projectId
          return {
            sessionId: SessionId('session:closed-loop'),
            projectId: worldlineId<'project'>(request.projectId),
            worldlineId: worldlineId<'worldline'>('worldline:closed-loop'),
            sourceRevision: 'revision:closed-loop',
            boundAt: '2026-09-01T00:00:00.000Z',
            ...(request.runId === undefined ? {} : { runId: worldlineId<'run'>(request.runId) }),
          }
        }),
      },
    } as unknown as Context
    apply(context)
    const tool = (name: string) => {
      const found = registered.find(candidate => candidate.name === name)
      if (found === undefined) throw new Error(`missing tool: ${name}`)
      return found
    }
    const exec = { agent: { session: {
      id: SessionId('session:closed-loop'), events: loadedWorldlineSkillEvents(),
    } } }

    try {
      const scenario = acceptanceScenarios.find(item => item.slug === 'warrior-and-dragon')
      if (scenario === undefined) throw new Error('warrior-and-dragon fixture is absent')
      const created = JSON.parse(await tool('worldline_project').execute({
        operation: 'create',
        name: scenario.name,
        template: 'playable-scenario',
      }, exec)) as { readonly manifest: { readonly id: string } }
      const projectId = created.manifest.id

      const replace = async (path: string, content: string) => {
        const current = await services.worldlineProjects.read({
          projectId: worldlineId<'project'>(projectId),
          path,
        })
        await tool('worldline_edit').execute({
          operation: 'replace',
          path,
          expected_revision: current.revision,
          content,
          dry_run: false,
        }, exec)
      }
      const create = async (path: string, documentId: string, content: string) => {
        await tool('worldline_edit').execute({
          operation: 'create',
          path,
          document_id: documentId,
          content,
          dry_run: false,
        }, exec)
      }

      await replace('canon/charter.md', charterDocument(scenario))
      await replace('timelines/canon.md', timelineDocument(scenario))
      await replace('characters/protagonist.md', characterDocument(scenario, scenario.characters[0]!))
      await tool('worldline_edit').execute({
        operation: 'create',
        path: 'characters/dragon.md',
        content: characterDocument(scenario, scenario.characters[1]!),
        dry_run: false,
      }, exec)
      const runtimePreview = JSON.parse(await tool('worldline_edit').execute({
        operation: 'set-runtime',
        document_id: 'character:dragon',
        runtime: { facets: { resources: { portrait: 'assets/files/characters/dragon/portrait.png' } } },
      }, exec)) as { readonly dryRun: boolean; readonly runtime: Record<string, unknown> }
      expect(runtimePreview).toMatchObject({
        dryRun: true,
        path: 'characters/dragon.md',
        runtime: { facets: { resources: { portrait: 'assets/files/characters/dragon/portrait.png' } } },
      })
      await tool('worldline_edit').execute({
        operation: 'set-runtime',
        path: 'characters/dragon.md',
        runtime: { facets: { resources: { portrait: 'assets/files/characters/dragon/portrait.png' } } },
        dry_run: false,
      }, exec)
      const storedRuntime = JSON.parse(await tool('worldline_query').execute({
        operation: 'runtime',
        path: 'characters/dragon.md',
      }, exec)) as { readonly path: string; readonly runtime: Record<string, unknown> }
      expect(storedRuntime).toMatchObject({
        path: 'characters/dragon.md',
        runtime: { facets: { resources: { portrait: 'assets/files/characters/dragon/portrait.png' } } },
      })
      await replace('scenarios/plot-points/opening.md', openingScenarioDocument(scenario))
      await create('mechanisms/runtime.md', 'document:runtime-mechanisms', mechanismDocument(scenario))
      const { maps: _maps, ...runtimeRules } = runtimeSemanticDocument(scenario)
      await tool('worldline_edit').execute({
        operation: 'set-runtime',
        path: 'mechanisms/runtime.md',
        runtime: runtimeRules,
        dry_run: false,
      }, exec)

      await expect(tool('worldline_map').execute({
        operation: 'validate',
        map_json: JSON.stringify({
          ...scenario.map,
          nodes: scenario.map.nodes.map((node, index) => {
            if (index !== 1) return node
            const { position: _position, ...withoutPosition } = node
            return withoutPosition
          }),
        }),
      }, exec)).rejects.toThrow('map_json.nodes[1] 缺少或无效字段：position')

      await expect(tool('worldline_map').execute({
        operation: 'validate',
        map_json: JSON.stringify({
          ...scenario.map,
          nodes: scenario.map.nodes.map((node, index) => index === 1
            ? { ...node, id: 'map-node:gate' }
            : node),
        }),
      }, exec)).rejects.toThrow('例如 map-node:school-gate；冒号后至少 6 个字符')

      await expect(tool('worldline_map').execute({
        operation: 'validate',
        map_json: JSON.stringify({
          ...scenario.map,
          nodes: scenario.map.nodes.map((node, index) => index === 1
            ? { ...node, position: scenario.map.nodes[0]?.position }
            : node),
        }),
      }, exec)).rejects.toThrow('同一图层重叠')

      const mapResult = JSON.parse(await tool('worldline_map').execute({
        operation: 'write',
        path: 'maps/places/world.md',
        map_json: JSON.stringify(scenario.map),
        dry_run: false,
      }, exec)) as { readonly map: { readonly nodes: unknown[]; readonly edges: unknown[] } }
      expect(mapResult.map.nodes).toHaveLength(4)
      expect(mapResult.map.edges).toHaveLength(2)
      const mapDocument = await services.worldlineProjects.read({
        projectId: worldlineId<'project'>(projectId),
        path: 'maps/places/world.md',
      })
      expect(mapDocument.content).toContain('# 世界地图')
      expect(mapDocument.content).not.toContain('```worldline-map')

      await expect(tool('worldline_build').execute({
        operation: 'prove',
        advance_duration: 0,
        confirm: true,
      }, exec)).rejects.toThrow('advance_duration must be positive')

      const proof = JSON.parse(await tool('worldline_build').execute({
        operation: 'prove',
        seed: 'warrior-dragon-proof',
        action_type: 'battle.strike',
        advance_duration: 60,
        confirm: true,
      }, exec)) as {
        readonly complete: boolean
        readonly runId: string
        readonly actions: readonly unknown[]
        readonly logicalTime: number
        readonly worldEventCount: number
        readonly checkpointId: string
        readonly map: { readonly nodes: number; readonly edges: number }
      }
      expect(proof).toMatchObject({
        complete: true,
        logicalTime: 60,
        map: { nodes: 4, edges: 2 },
      })
      expect(proof.actions.length).toBeGreaterThan(0)
      expect(proof.worldEventCount).toBeGreaterThan(0)
      expect(proof.checkpointId).toMatch(/^checkpoint:/u)

      const autonomous = JSON.parse(await tool('worldline_run').execute({
        operation: 'simulate',
        run_id: proof.runId,
        cycles: 2,
        step_duration: 60,
        confirm: true,
      }, exec)) as {
        readonly autonomous: boolean
        readonly actions: readonly unknown[]
        readonly view: { readonly snapshot: { readonly logicalTime: number } }
      }
      expect(autonomous.autonomous).toBe(true)
      expect(autonomous.actions.length).toBeGreaterThan(0)
      expect(autonomous.view.snapshot.logicalTime).toBe(180)
    } finally {
      await runs.dispose()
      await compiler.dispose()
      await projects.dispose()
    }
  }, 30_000)
})
