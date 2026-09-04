import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CharacterMemory, WorldEvent } from '@deepseek-ai/dsh-worldline-standard'
import {
  acceptanceScenarios,
  charterDocument,
  characterDocument,
  mapDocument,
  mechanismDocument,
  openingScenarioDocument,
  runtimeSemanticDocument,
  timelineDocument,
} from '../../../../fixtures/worldline/scenarios.ts'
import WorldlineCompiler from '../../compiler/src/index.ts'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import { simulateAutonomousCycles } from '../../tool-worldline/src/index.ts'
import WorkerWorldlineRuns from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

describe('星露谷小镇长期自治验收', () => {
  it('让全部居民在无模型帮助下连续运行一千个游戏日', async () => {
    const behaviorCycles = Number(process.env['WORLDLINE_LONG_CYCLES'] ?? 200)
    const daysPerCycle = 1_000 / behaviorCycles
    if (!Number.isInteger(daysPerCycle) || behaviorCycles < 1) {
      throw new Error('WORLDLINE_LONG_CYCLES 必须是 1000 的正整数因数')
    }
    const scenario = acceptanceScenarios.find(item => item.slug === 'stardew-valley-town')
    if (scenario === undefined) throw new Error('缺少星露谷长期验收场景')
    const root = await mkdtemp(join(tmpdir(), 'worldline-stardew-1000-days-'))
    roots.push(root)
    const context = new Context()
    const projects = context.plugin(LocalWorldlineProjects, {
      root,
      maxEntries: 5000,
      maxSearchFiles: 50_000,
    })
    await projects.await()
    const compiler = context.plugin(WorldlineCompiler)
    await compiler.await()
    const runs = context.plugin(WorkerWorldlineRuns, {
      maxOldGenerationSizeMb: 256,
      requestTimeoutMs: 120_000,
    })
    await runs.await()

    try {
      const project = await context.worldlineProjects.create({ name: scenario.name, template: 'blank' })
      const documents = [
        ['canon/charter.md', charterDocument(scenario), 'charter'],
        ['timelines/canon.md', timelineDocument(scenario), 'timeline-event'],
        ['scenarios/plot-points/opening.md', openingScenarioDocument(scenario), 'scenario'],
        ['mechanisms/runtime.md', mechanismDocument(scenario), 'rule'],
        ['maps/places/world.md', mapDocument(scenario), 'place'],
      ] as const
      for (const [path, content, objectKind] of documents) {
        await context.worldlineProjects.write({
          projectId: project.manifest.id,
          path,
          content,
          createParents: true,
          objectKind,
        })
      }
      await context.worldlineProjects.writeControl({
        projectId: project.manifest.id,
        namespace: 'compiler',
        path: 'runtime-model.json',
        content: JSON.stringify({
          documents: { 'mechanisms/runtime.md': runtimeSemanticDocument(scenario) },
        }),
      })
      for (const [index, character] of scenario.characters.entries()) {
        await context.worldlineProjects.write({
          projectId: project.manifest.id,
          path: `characters/${String(index + 1).padStart(2, '0')}.md`,
          content: characterDocument(scenario, character),
          createParents: true,
          objectKind: 'character',
        })
      }

      const preview = await context.worldlineCompiler.compile({
        projectId: project.manifest.id,
        purpose: scenario.purpose,
      })
      expect(preview.canFreeze, preview.diagnostics.map(item => item.message).join('\n')).toBe(true)
      expect(preview.questions).toHaveLength(0)
      const frozen = await context.worldlineCompiler.freeze({
        projectId: project.manifest.id,
        purpose: scenario.purpose,
        expectedSourceDigest: preview.sourceDigest,
      })
      const actors = frozen.blueprint.entities.filter(entity => entity.type === 'character')
      expect(actors).toHaveLength(35)
      expect(frozen.blueprint.maps[0]?.nodes).toHaveLength(20)
      expect(frozen.blueprint.maps[0]?.edges).toHaveLength(17)

      const created = await context.worldlineRuns.create({
        projectId: project.manifest.id,
        seed: 'stardew-long-horizon-seed',
        startPaused: false,
      })
      const simulated = await simulateAutonomousCycles(
        context,
        created.summary.runId,
        behaviorCycles,
        daysPerCycle * 86_400,
      )
      const final = simulated.view
      expect(final.summary.status).toBe('running')
      expect(final.snapshot.logicalTime).toBe(1_000 * 86_400)
      expect(final.snapshot.aiUsage.calls).toBe(0)
      expect(simulated.actionsPerformed).toBe(35 * behaviorCycles)
      expect(Object.values(simulated.actorActionCounts).every(count => count === behaviorCycles)).toBe(true)
      expect(Object.keys(simulated.actionCounts)).toEqual(expect.arrayContaining([
        'town.work', 'town.socialize', 'town.rest', 'town.community', 'town.travel',
      ]))

      const world = record(final.snapshot.state['world'])
      expect(record(world['calendar'])).toMatchObject({
        absoluteDay: 1000,
        year: 9,
        season: '冬',
        dayOfSeason: 21,
        timeOfDaySeconds: 21_600,
      })
      expect(record(world['environment'])).toMatchObject({ daysElapsed: 1000, seasonTransitions: 35 })
      expect(record(world['farm'])).toMatchObject({ cropGrowth: 1000, soilCycles: 1000 })
      expect(record(world['community'])['weeklyGatherings']).toBe(142)

      const entityState = record(final.snapshot.state['entities'])
      const mapNodeIds = new Set<string>(
        frozen.blueprint.maps.flatMap(map => map.nodes.map(node => node.id)),
      )
      for (const actor of actors) {
        const entity = record(entityState[actor.id])
        const state = record(entity['state'])
        const memory = entity['memory'] as CharacterMemory
        expect(state['energy']).toEqual(expect.any(Number))
        expect(Number(state['energy'])).toBeGreaterThanOrEqual(0)
        expect(Number(state['energy'])).toBeLessThanOrEqual(10)
        expect(Number(state['workDays'])).toBeGreaterThan(behaviorCycles / 10)
        expect(Number(state['socialInteractions'])).toBeGreaterThan(0)
        expect(Number(state['communityContributions'])).toBeGreaterThan(behaviorCycles / 10)
        expect(mapNodeIds.has(String(state['locationId']))).toBe(true)
        expect(memory.beliefs).not.toHaveLength(0)
        expect(memory.goals).not.toHaveLength(0)
        expect(memory.skills).not.toHaveLength(0)
        expect(memory.experience).not.toHaveLength(0)
        expect(memory.relationships).not.toHaveLength(0)
        expect(new Set(memory.episodic.flatMap(item => item.placeId === undefined ? [] : [item.placeId])).size)
          .toBeGreaterThan(1)
      }

      expect(final.health).toMatchObject({
        activeProcesses: 0,
        waitingProcesses: 0,
        reservations: 0,
        noProgressSteps: 0,
        deadlocksResolved: 0,
        livelocksResolved: 0,
      })
      expect(final.snapshot.processes.length).toBeLessThanOrEqual(64)

      let afterSequence = -1
      let afterOrdinal = -1
      let failedActions = 0
      let completedMoves = 0
      let completedSocial = 0
      let worldEvents = 0
      while (true) {
        const page = await context.worldlineRuns.records({
          runId: created.summary.runId,
          stream: 'world-event',
          afterSequence,
          afterOrdinal,
          limit: 5_000,
        })
        for (const item of page.records) {
          const event = item.payload as unknown as WorldEvent
          worldEvents += 1
          if (event.type === 'action.failed') failedActions += 1
          if (event.type === 'action.completed' && event.ruleId === 'town.travel') completedMoves += 1
          if (event.type === 'action.completed' && event.ruleId === 'town.socialize') completedSocial += 1
        }
        if (!page.hasMore) break
        afterSequence = page.nextSequence
        afterOrdinal = page.nextOrdinal
      }
      expect(worldEvents).toBeGreaterThan(behaviorCycles * 100)
      expect(failedActions).toBe(0)
      expect(completedMoves).toBeGreaterThan(behaviorCycles * 5)
      expect(completedSocial).toBeGreaterThan(behaviorCycles)
    } finally {
      await runs.dispose()
      await compiler.dispose()
      await projects.dispose()
    }
  }, 600_000)
})
