// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { WorldMap } from '@deepseek-ai/dsh-worldline-standard/types'
import {
  buildMapSpatialIndex,
  clusterMapNodes,
  layoutWorldMap,
  MapWorkbench,
  mapCanvasFrame,
  visibleMapNodes,
} from '../src/client/MapWorkbench.tsx'
import type { ProjectClient, RunsClient } from '../src/client/types.ts'

afterEach(cleanup)

const map = {
  id: 'map:test',
  version: 1,
  name: 'Test map',
  rootNodeId: 'map-node:root',
  layers: [{ id: 'main', name: 'Main', visible: true, locked: false, order: 0 }],
  nodes: [
    {
      id: 'map-node:root', layerId: 'main', kind: 'world', name: 'Root',
      position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [],
    },
    {
      id: 'map-node:city', layerId: 'main', kind: 'city', name: 'City',
      position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [],
    },
  ],
  edges: [],
  provenance: [],
} as unknown as WorldMap

describe('Worldline current map projection', () => {
  it('lays out every node deterministically', () => {
    const first = layoutWorldMap(map)
    const second = layoutWorldMap(map)

    expect(first).toEqual(second)
    expect(new Set(first.nodes.map(node => `${String(node.position.x)}:${String(node.position.y)}`)).size)
      .toBe(first.nodes.length)
  })

  it('pads authored edge coordinates without changing the map', () => {
    const frame = mapCanvasFrame(map)

    expect(frame.offsetX).toBeGreaterThan(58)
    expect(frame.offsetY).toBeGreaterThan(28)
    expect(frame.width).toBeGreaterThanOrEqual(1_400)
    expect(frame.height).toBeGreaterThanOrEqual(860)
    expect(map.nodes.every(node => node.position.x === 0 && node.position.y === 0)).toBe(true)
  })

  it('uses a spatial index to clip a ten-thousand-node map by viewport and layer', () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => ({
      id: `map-node:item-${String(index)}`,
      layerId: index % 2 === 0 ? 'main' : 'hidden',
      kind: 'region' as const,
      name: `Node ${String(index)}`,
      position: { x: index % 100 * 200, y: Math.floor(index / 100) * 200 },
      permissions: [], hazards: [], entryNodeIds: [],
    }))
    const large = { ...map, rootNodeId: nodes[0]?.id, nodes, layers: [
      { id: 'main', name: 'Main', visible: true, locked: false, order: 0 },
      { id: 'hidden', name: 'Hidden', visible: false, locked: false, order: 1 },
    ] } as unknown as WorldMap

    const visible = visibleMapNodes(
      buildMapSpatialIndex(large),
      { left: 0, top: 0, right: 1_000, bottom: 1_000 },
      new Set(['main']),
      0,
    )

    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(40)
    expect(visible.every(node => node.layerId === 'main')).toBe(true)
  })

  it('clusters a dense low-zoom projection while keeping a selected node interactive', () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => ({
      ...map.nodes[0],
      id: `map-node:cluster-${String(index)}`,
      position: { x: index % 50 * 12, y: Math.floor(index / 50) * 12 },
    })) as unknown as WorldMap['nodes']
    const pinned = nodes[17]
    if (pinned === undefined) throw new Error('cluster fixture has no pinned node')

    const projection = clusterMapNodes(nodes, 0.3, new Set([pinned.id]))

    expect(projection.clusters.length).toBeGreaterThan(0)
    expect(projection.nodes).toContain(pinned)
    expect(projection.nodes.length + projection.clusters.length).toBeLessThan(30)
    expect(projection.clusters.reduce((sum, item) => sum + item.count, 0)
      + projection.nodes.length).toBe(nodes.length)
  })

  it('opens on the generated world overview and exposes the full place description', async () => {
    const project = {
      manifest: { id: 'project:atlas', name: '潮港图志' },
    } as unknown as ProjectSummary
    const run = { runId: 'run:atlas', projectId: project.manifest.id, status: 'running' }
    const generated = {
      ...map,
      name: '潮港运行地图',
      nodes: map.nodes.map((node, index) => ({
        ...node,
        description: index === 0
          ? '潮港总控层悬在旧防波堤上，空气带有盐、机油与湿冷金属的气味；这里负责调度疏散，也是风暴警报最先抵达的地点。'
          : '狭长的内港城区沿轨道展开，商铺灯箱映在积水中，承担居民中转和线索交换。',
      })),
      totalNodes: 2,
      totalEdges: 0,
      truncated: false,
    }
    const spatial = vi.fn(async () => ({
      runId: run.runId, sequence: 1, logicalTime: 90,
      availableMaps: [{ id: generated.id, name: generated.name, nodeCount: 2 }],
      map: generated, actors: [], movements: [],
    }))
    const runs = {
      list: vi.fn(async () => [run]),
      view: vi.fn(async () => ({
        summary: run,
        snapshot: { logicalTime: 90, state: { entities: {} } },
      })),
      spatial,
    } as unknown as RunsClient

    render(createElement(MapWorkbench, {
      t: (key: string) => key,
      project,
      projects: {} as ProjectClient,
      runs,
    }))

    const overview = screen.getByRole('button', { name: '地图总览' })
    expect(overview.getAttribute('data-active')).toBe('true')
    expect(await screen.findByRole('heading', { name: '潮港运行地图' })).toBeTruthy()
    expect(screen.getByText('地点描述')).toBeTruthy()
    expect(screen.getByText(/潮港总控层悬在旧防波堤上/u)).toBeTruthy()
    expect(screen.queryByText('先定义地点，再组装世界')).toBeNull()
    await waitFor(() => { expect(spatial).toHaveBeenCalledOnce() })
  })
})
