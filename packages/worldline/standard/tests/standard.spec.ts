import { describe, expect, it } from 'vitest'
import {
  certificateIsAutonomous,
  contentFingerprint,
  isValidWorldEvent,
  stableStringify,
  validateContextPack,
  validateWorldMap,
  worldlineId,
} from '../src/index.ts'
import type { ClosureCertificate, ContextPack, WorldEvent, WorldMap } from '../src/index.ts'

describe('WWS portable contracts', () => {
  it('keeps deterministic fingerprints independent of object insertion order', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }))
    expect(contentFingerprint({ b: 2, a: 1 })).toBe(contentFingerprint({ a: 1, b: 2 }))
    expect(() => worldlineId('not namespaced')).toThrow(/Invalid Worldline/u)
  })

  it('rejects diagnostic-only records from the authoritative WorldEvent ledger', () => {
    const base = {
      id: worldlineId<'event'>('event:000001'), sequence: 1, logicalTime: 0,
      type: 'action.rejected', participantIds: [], causedBy: [], deltas: [],
      persistentFacts: [], cognitionChanges: [], visibleTo: [], provenance: [], data: {},
    } satisfies WorldEvent
    expect(isValidWorldEvent(base)).toBe(false)
    expect(isValidWorldEvent({ ...base, processMilestone: 'failed' })).toBe(true)
    expect(isValidWorldEvent({ ...base, deltas: [{ path: 'x', before: 1, after: 2 }] })).toBe(true)
  })

  it('requires every closure category and deterministic no-AI operation', () => {
    const categories = [
      'state', 'time', 'space', 'actions', 'cognition', 'causality', 'safety', 'liveness',
      'fairness', 'event-validity', 'behavioral-validity', 'replay', 'provenance',
    ] as const
    const certificate: ClosureCertificate = {
      blueprintDigest: 'a'.repeat(64), createdAt: new Date(0).toISOString(), sourceCoverage: {
        author: 1, 'approved-supplement': 0, 'mechanism-pack': 0, import: 0,
        'agent-proposal': 0, 'runtime-proposal': 0,
      }, results: categories.map(category => ({ category, status: 'pass', summary: 'ok', evidence: ['test'] })),
      deterministicWithoutAi: true, knownLimits: [], performance: {},
    }
    expect(certificateIsAutonomous(certificate)).toBe(true)
    expect(certificateIsAutonomous({ ...certificate, deterministicWithoutAi: false })).toBe(false)
  })

  it('enforces bounded Context Packs before provider dispatch', () => {
    const pack = {
      actorId: worldlineId<'entity'>('entity:actor01'), model: { provider: 'test', model: 'test' },
      contextWindow: 1000, inputLimit: 700, reservedOutputTokens: 200, reservedToolTokens: 100,
      sections: [{ kind: 'identity', text: 'identity', tokens: 700, sourceIds: [], priority: 10 }],
      totalTokens: 700, droppedSourceIds: [],
    } satisfies ContextPack
    expect(() => { validateContextPack(pack) }).not.toThrow()
    expect(() => { validateContextPack({ ...pack, totalTokens: 701 }) }).toThrow(/token total/u)
    expect(() => { validateContextPack({ ...pack, inputLimit: 900 }) }).toThrow(/80%/u)
  })

  it('detects map hierarchy and edge errors', () => {
    const root = worldlineId<'map-node'>('map-node:root01')
    const child = worldlineId<'map-node'>('map-node:child1')
    const map = {
      id: worldlineId<'map'>('map:sample1'), version: 1, name: 'Sample', rootNodeId: root,
      layers: [{ id: 'base', name: 'Base', visible: true, locked: false, order: 0 }],
      nodes: [
        { id: root, layerId: 'base', kind: 'world', name: 'Root', position: { x: 0, y: 0 }, permissions: [], hazards: [], entryNodeIds: [] },
        { id: child, parentId: root, layerId: 'base', kind: 'city', name: 'Child', position: { x: 1, y: 1 }, permissions: [], hazards: [], entryNodeIds: [] },
      ], edges: [], provenance: [],
    } satisfies WorldMap
    expect(validateWorldMap(map)).toEqual([])
    const [rootNode, childNode] = map.nodes
    if (rootNode === undefined || childNode === undefined) throw new Error('map fixture is incomplete')
    expect(validateWorldMap({ ...map, nodes: [{ ...rootNode, parentId: root }, childNode] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'hierarchy-cycle' })]),
    )
  })
})
