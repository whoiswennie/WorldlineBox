import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
import WorkerWorldlineRuns from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Worldline product acceptance scenarios', () => {
  it.each(acceptanceScenarios)('$slug compiles, freezes, runs, acts, and advances', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), `worldline-${scenario.slug}-`))
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
      maxOldGenerationSizeMb: 128,
      requestTimeoutMs: 15_000,
    })
    await runs.await()

    try {
      const project = await context.worldlineProjects.create({
        name: scenario.name,
        template: scenario.slug === 'warrior-and-dragon' ? 'playable-scenario' : 'blank',
      })
      await context.worldlineProjects.write({
        projectId: project.manifest.id,
        path: 'canon/charter.md',
        content: charterDocument(scenario),
        createParents: true,
        objectKind: 'charter',
      })
      await context.worldlineProjects.write({
        projectId: project.manifest.id,
        path: 'timelines/canon.md',
        content: timelineDocument(scenario),
        createParents: true,
        objectKind: 'timeline-event',
      })
      await context.worldlineProjects.write({
        projectId: project.manifest.id,
        path: 'scenarios/plot-points/opening.md',
        content: openingScenarioDocument(scenario),
        createParents: true,
        objectKind: 'scenario',
      })
      for (const [index, character] of scenario.characters.entries()) {
        const characterPath = scenario.slug === 'warrior-and-dragon'
          ? index === 0 ? 'characters/protagonist.md' : 'characters/dragon.md'
          : `characters/${String(index + 1).padStart(2, '0')}-${character.name.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-')}.md`
        await context.worldlineProjects.write({
          projectId: project.manifest.id,
          path: characterPath,
          content: characterDocument(scenario, character),
          createParents: true,
          objectKind: 'character',
        })
      }
      await context.worldlineProjects.write({
        projectId: project.manifest.id,
        path: 'mechanisms/runtime.md',
        content: mechanismDocument(scenario),
        createParents: true,
        objectKind: 'rule',
      })
      await context.worldlineProjects.writeControl({
        projectId: project.manifest.id,
        namespace: 'compiler',
        path: 'runtime-model.json',
        content: JSON.stringify({
          documents: { 'mechanisms/runtime.md': runtimeSemanticDocument(scenario) },
        }),
      })
      await context.worldlineProjects.write({
        projectId: project.manifest.id,
        path: 'maps/places/world.md',
        content: mapDocument(scenario),
        createParents: true,
        objectKind: 'place',
      })

      const preview = await context.worldlineCompiler.compile({
        projectId: project.manifest.id,
        purpose: scenario.purpose,
      })
      expect(preview).toMatchObject({
        canFreeze: true,
        executableCounts: {
          maps: 1,
          actions: scenario.expectedExecutables?.actions
            ?? (scenario.slug === 'warrior-and-dragon' ? 2 : 1),
          systems: scenario.expectedExecutables?.systems ?? 1,
          invariants: scenario.expectedExecutables?.invariants
            ?? (scenario.slug === 'warrior-and-dragon' ? 2 : 1),
        },
      })
      const frozen = await context.worldlineCompiler.freeze({
        projectId: project.manifest.id,
        purpose: scenario.purpose,
        expectedSourceDigest: preview.sourceDigest,
      })
      expect(frozen.blueprint.entities.filter(entity => entity.type === 'character')).toHaveLength(
        scenario.characters.length,
      )

      const created = await context.worldlineRuns.create({
        projectId: project.manifest.id,
        seed: `${scenario.slug}-seed`,
        startPaused: false,
      })
      const actor = frozen.blueprint.entities.find(entity => entity.type === 'character'
        && (scenario.slug !== 'warrior-and-dragon' || entity.id === frozen.blueprint.canon
          .find(object => object.title === '勇士艾琳')?.id))
      if (actor === undefined) throw new Error('acceptance scenario compiled without a character')
      const choices = await context.worldlineRuns.choices({
        runId: created.summary.runId,
        actorId: actor.id,
      })
      const choice = scenario.acceptanceAction === undefined
        ? choices.choices[0]
        : choices.choices.find(item => item.actionType === scenario.acceptanceAction)
      if (choice === undefined) throw new Error('acceptance scenario projected no legal action')
      await context.worldlineRuns.submitAction({
        runId: created.summary.runId,
        actorId: actor.id,
        type: choice.actionType,
        parameters: choice.parameters,
        expectedSequence: choices.sequence,
        controller: 'system',
      })
      const advanceDuration = scenario.slug === 'twenty-five-person-town'
        ? scenario.purpose.duration
        : 120
      const advanced = await context.worldlineRuns.advance({
        runId: created.summary.runId,
        duration: advanceDuration,
        maxEvents: 10_000,
      })
      expect(advanced.snapshot.logicalTime).toBe(advanceDuration)
      expect(advanced.summary.status).not.toBe('failed')
      const records = await context.worldlineRuns.records({ runId: created.summary.runId, limit: 100 })
      expect(records.records.some(record => record.stream === 'world-event')).toBe(true)
      const telemetry = await context.worldlineRuns.records({
        runId: created.summary.runId,
        stream: 'telemetry',
        limit: 10,
      })
      expect(telemetry.records).toHaveLength(1)

      const definition = await context.worldlineRuns.definition({ runId: created.summary.runId })
      expect(definition.purpose.summary).toBe(scenario.purpose.summary)
      if (scenario.slug === 'warrior-and-dragon') {
        expect(frozen.blueprint.entities.filter(entity => entity.type === 'character')).toHaveLength(2)
        expect(frozen.blueprint.actions.map(action => action.id)).toEqual(expect.arrayContaining([
          'battle.strike', 'battle.guard',
        ]))
        const conflict = advanced.snapshot.state['conflict']
        expect(conflict).toMatchObject({ dragonWounds: 1, heroWounds: 4 })
        const actorState = (advanced.snapshot.state['entities'] as Record<string, {
          state?: Record<string, unknown>
        }>)[actor.id]?.state
        expect(actorState).toMatchObject({ stamina: 4, locationId: 'map-node:dragon-lair' })
        const actorMemory = (advanced.snapshot.state['entities'] as Record<string, {
          memory?: {
            beliefs?: readonly unknown[]
            episodic?: readonly unknown[]
            goals?: readonly unknown[]
            skills?: readonly unknown[]
          }
        }>)[actor.id]?.memory
        expect(actorMemory?.episodic).not.toHaveLength(0)
        expect(actorMemory?.beliefs).not.toHaveLength(0)
        expect(actorMemory?.goals).not.toHaveLength(0)
        expect(actorMemory?.skills).not.toHaveLength(0)
        expect(records.records.some(record => (
          record.stream === 'world-event'
          && record.payload['type'] === 'action.completed'
          && record.payload['ruleId'] === 'battle.strike'
        ))).toBe(true)
      }
      if (scenario.slug === 'nested-map') {
        const spatial = await context.worldlineRuns.spatial({ runId: created.summary.runId, maxNodes: 100 })
        expect(spatial.map?.nodes).toHaveLength(6)
        expect(spatial.map?.nodes.find(node => node.id === 'map-node:nested-room')?.parentId)
          .toBe('map-node:nested-building')
      }
    } finally {
      await runs.dispose()
      await compiler.dispose()
      await projects.dispose()
    }
  }, 30_000)
})
