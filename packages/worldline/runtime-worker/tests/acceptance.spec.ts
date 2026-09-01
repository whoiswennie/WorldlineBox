import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  acceptanceScenarios,
  characterDocument,
  mechanismDocument,
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
      const project = await context.worldlineProjects.create({ name: scenario.name, template: 'blank' })
      for (const [index, character] of scenario.characters.entries()) {
        await context.worldlineProjects.write({
          projectId: project.manifest.id,
          path: `characters/${String(index + 1).padStart(2, '0')}-${character.name.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-')}.md`,
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

      const preview = await context.worldlineCompiler.compile({
        projectId: project.manifest.id,
        purpose: scenario.purpose,
      })
      expect(preview).toMatchObject({
        canFreeze: true,
        executableCounts: { maps: 1, actions: 1, systems: 1, invariants: 1 },
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
      const actor = frozen.blueprint.entities.find(entity => entity.type === 'character')
      if (actor === undefined) throw new Error('acceptance scenario compiled without a character')
      const choices = await context.worldlineRuns.choices({
        runId: created.summary.runId,
        actorId: actor.id,
      })
      const choice = choices.choices[0]
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
