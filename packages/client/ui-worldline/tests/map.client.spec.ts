import { describe, expect, it } from 'vitest'
import type { WorldMap } from '@deepseek-ai/dsh-worldline-standard/types'
import {
  buildMapSpatialIndex,
  clusterMapNodes,
  layoutWorldMap,
  parseWorldlineMapFence,
  replaceWorldlineMapFence,
  visibleMapNodes,
} from '../src/client/MapWorkbench.tsx'

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

describe('Worldline map document projection', () => {
  it('round-trips the one current worldline-map schema without touching prose', () => {
    const source = '# Atlas\n\nAuthor note.\n'
    const updated = replaceWorldlineMapFence(source, map)
    const parsed = parseWorldlineMapFence(updated)

    expect(updated).toContain('Author note.')
    expect(parsed.error).toBeUndefined()
    expect(parsed.map).toEqual(map)
  })

  it('rejects a non-current map shape instead of selecting compatibility logic', () => {
    const parsed = parseWorldlineMapFence('```worldline-map\n{"version":0}\n```')

    expect(parsed.map).toBeUndefined()
    expect(parsed.error).toContain('当前 WorldMap 格式')
  })

  it('rejects malformed nested objects on the one current parser path', () => {
    const malformed = { ...map, nodes: [{ id: 'map-node:broken', position: { x: 1 } }] }

    const parsed = parseWorldlineMapFence(`\`\`\`worldline-map\n${JSON.stringify(malformed)}\n\`\`\``)

    expect(parsed.map).toBeUndefined()
    expect(parsed.error).toContain('当前 WorldMap 格式')
  })

  it('lays out every node deterministically', () => {
    const first = layoutWorldMap(map)
    const second = layoutWorldMap(map)

    expect(first).toEqual(second)
    expect(new Set(first.nodes.map(node => `${String(node.position.x)}:${String(node.position.y)}`)).size)
      .toBe(first.nodes.length)
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
})
