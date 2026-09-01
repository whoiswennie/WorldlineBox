import { describe, expect, it } from 'vitest'
import type { WorldMap } from '@deepseek-ai/dsh-worldline-standard/types'
import {
  layoutWorldMap,
  parseWorldlineMapFence,
  replaceWorldlineMapFence,
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
    expect(parsed.error).toContain('current WorldMap schema')
  })

  it('lays out every node deterministically', () => {
    const first = layoutWorldMap(map)
    const second = layoutWorldMap(map)

    expect(first).toEqual(second)
    expect(new Set(first.nodes.map(node => `${String(node.position.x)}:${String(node.position.y)}`)).size)
      .toBe(first.nodes.length)
  })
})
