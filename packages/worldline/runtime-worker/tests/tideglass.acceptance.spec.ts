import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  TIDEGLASS_WORLD_NAME,
  tideglassAssetDestinations,
  tideglassDocuments,
  tideglassRuntime,
} from '../../../../fixtures/worldline/tideglass.ts'
import WorldlineCompiler from '../../compiler/src/index.ts'
import LocalWorldlineProjects from '../../project-local/src/index.ts'
import WorkerWorldlineRuns from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function mediaBytes(path: string): Uint8Array {
  if (path.endsWith('.wav')) {
    const bytes = new Uint8Array(46)
    const view = new DataView(bytes.buffer)
    const label = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
    }
    label(0, 'RIFF')
    view.setUint32(4, 38, true)
    label(8, 'WAVEfmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 8_000, true)
    view.setUint32(28, 8_000, true)
    view.setUint16(32, 1, true)
    view.setUint16(34, 8, true)
    label(36, 'data')
    view.setUint32(40, 2, true)
    bytes[44] = 128
    bytes[45] = 128
    return bytes
  }
  return new TextEncoder().encode([
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
    '<rect width="320" height="180" fill="#183647"/>',
    '<path d="M0 128 Q80 90 160 128 T320 128 V180 H0Z" fill="#54a8b5"/>',
    `<text x="16" y="30" fill="white" font-size="14">${path}</text>`,
    '</svg>',
  ].join(''))
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

describe('Tideglass representative OC world', () => {
  it('compiles authored context, owns its media, and runs a spatial timed crisis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worldline-tideglass-'))
    roots.push(root)
    const context = new Context()
    const projects = context.plugin(LocalWorldlineProjects, {
      root,
      maxEntries: 5_000,
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
        name: TIDEGLASS_WORLD_NAME,
        description: '多角色信息差、空间移动、定时危机与证据主线的综合验收世界。',
        template: 'blank',
      })
      for (const document of tideglassDocuments) {
        await context.worldlineProjects.write({
          projectId: project.manifest.id,
          path: document.path,
          documentId: document.documentId as never,
          content: document.content,
          createParents: true,
        })
      }
      for (const path of tideglassAssetDestinations) {
        const bytes = mediaBytes(path)
        await context.worldlineProjects.importEntry({
          projectId: project.manifest.id,
          path,
          expectedBytes: bytes.byteLength,
        }, oneChunk(bytes))
      }
      await context.worldlineProjects.writeControl({
        projectId: project.manifest.id,
        namespace: 'compiler',
        path: 'runtime-model.json',
        content: JSON.stringify({
          documents: { 'mechanisms/core.md': tideglassRuntime },
        }),
      })

      const purpose = {
        summary: '在失声汛夜中验证伪广播、承担资源代价并留下可核验公共记忆。',
        scope: ['OC 互动小说', '证据主线', '允许偏航'],
        duration: 3_600,
        resolution: 60,
        detail: 'L2' as const,
        hardExpectations: ['角色只知道亲历或获知的事实', '时间与地点来自世界状态'],
        statisticalExpectations: [],
        antiPatterns: ['默认教学楼', '默认午夜', '静态故事选项', '无依据泄露秘密'],
      }
      const preview = await context.worldlineCompiler.compile({
        projectId: project.manifest.id,
        purpose,
      })
      expect(preview.diagnostics.filter(item => item.severity === 'blocking')).toEqual([])
      expect(preview).toMatchObject({
        canFreeze: true,
        executableCounts: { maps: 1, actions: 5, systems: 2, invariants: 3 },
      })

      const frozen = await context.worldlineCompiler.freeze({
        projectId: project.manifest.id,
        purpose,
        expectedSourceDigest: preview.sourceDigest,
      })
      expect(frozen.blueprint.plotPoints?.map(point => point.order)).toEqual([1, 2, 3])
      expect(frozen.blueprint.maps[0]?.nodes).toHaveLength(6)
      expect(frozen.blueprint.entities.filter(entity => entity.type === 'character')).toHaveLength(4)
      expect(frozen.blueprint.canon.find(object => object.title === '谢澜')?.facets).toMatchObject({
        initialState: {
          locationId: 'map-node:archive-sorting',
          routeSense: 4,
          inventory: ['封存潮玻璃', '铜制路牌', '防水笔'],
        },
      })
      expect(frozen.blueprint.canon.find(object => object.title === '闻栖')?.facets)
        .toMatchObject({ memory: { beliefs: { splice: '疏散指令至少被拼接了两次' } } })
      expect(JSON.stringify(frozen.blueprint.canon.find(object => object.title === '谢澜')?.facets))
        .not.toContain('疏散指令至少被拼接了两次')

      for (const path of tideglassAssetDestinations) {
        const asset = await context.worldlineProjects.assetFile({
          projectId: project.manifest.id,
          path,
        })
        expect(asset.sizeBytes).toBeGreaterThan(0)
      }

      const created = await context.worldlineRuns.create({
        projectId: project.manifest.id,
        seed: 'tideglass-representative-seed',
        startPaused: false,
      })
      const xielan = frozen.blueprint.entities.find(entity => entity.facets.displayName === '谢澜')
      const wenqi = frozen.blueprint.entities.find(entity => entity.facets.displayName === '闻栖')
      if (xielan === undefined || wenqi === undefined) throw new Error('Tideglass characters did not compile')

      expect(created.snapshot.state).toMatchObject({
        world: {
          calendar: { startDayIndex: 35, startClockMinute: 1_040 },
          storm: { pressure: 3 },
          bridge: { integrity: 54, allocation: '未决定' },
        },
      })
      const openingChoices = await context.worldlineRuns.choices({
        runId: created.summary.runId,
        actorId: xielan.id,
      })
      expect(openingChoices.choices.map(choice => choice.actionType)).toEqual(expect.arrayContaining([
        'archive.investigate',
        'archive.confer',
        'archive.travel',
        'archive.wait',
      ]))
      expect(openingChoices.choices.map(choice => choice.actionType)).not.toContain('archive.reinforce')
      const confer = openingChoices.choices.find(choice => (
        choice.actionType === 'archive.confer' && choice.parameters.targetId === wenqi.id
      ))
      if (confer === undefined) throw new Error('same-location confer choice was not projected')
      await context.worldlineRuns.setControl({
        runId: created.summary.runId,
        actorId: xielan.id,
        mode: 'player',
      })
      await context.worldlineRuns.submitAction({
        runId: created.summary.runId,
        actorId: xielan.id,
        type: confer.actionType,
        parameters: confer.parameters,
        expectedSequence: openingChoices.sequence,
        controller: 'player',
      })
      const afterStorm = await context.worldlineRuns.advance({
        runId: created.summary.runId,
        duration: 600,
        maxEvents: 10_000,
      })
      expect(afterStorm.snapshot.logicalTime).toBe(600)
      expect(afterStorm.snapshot.state).toMatchObject({
        world: { storm: { pressure: 4 }, bridge: { integrity: 52 } },
      })
      const entityState = afterStorm.snapshot.state.entities as Record<string, { state: Record<string, unknown> }>
      expect(entityState[xielan.id]?.state).toMatchObject({ trust: 3, locationId: 'map-node:archive-sorting' })
      expect(entityState[wenqi.id]?.state).toMatchObject({ trust: 2, locationId: 'map-node:archive-sorting' })

      const spatial = await context.worldlineRuns.spatial({
        runId: created.summary.runId,
        maxNodes: 20,
      })
      expect(spatial.map?.name).toBe('汐镜港与潮痕档案馆')
      expect(spatial.actors).toContainEqual({
        actorId: xielan.id,
        nodeId: 'map-node:archive-sorting',
      })
      expect(spatial.map?.edges.some(edge => (
        edge.from === 'map-node:archive-sorting' && edge.to === 'map-node:tide-bridge'
      ))).toBe(true)
    } finally {
      await runs.dispose()
      await compiler.dispose()
      await projects.dispose()
    }
  }, 30_000)
})
