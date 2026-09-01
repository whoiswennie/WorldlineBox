import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MapNode, WorldMap } from '@deepseek-ai/dsh-worldline-standard/types'
import type { EditorDocumentState } from './types.ts'
import css from './MapWorkbench.module.css'

const MAP_FENCE = /```worldline-map\s*\r?\n([\s\S]*?)\r?\n```/iu

export interface ParsedMapFence {
  readonly map?: WorldMap
  readonly error?: string
  readonly start?: number
  readonly end?: number
}

export function parseWorldlineMapFence(content: string): ParsedMapFence {
  const match = MAP_FENCE.exec(content)
  if (match === null) return {}
  try {
    const candidate = JSON.parse(match[1] ?? '') as unknown
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return { error: 'worldline-map must contain one JSON object', start: match.index, end: match.index + match[0].length }
    }
    const value = candidate as Record<string, unknown>
    if (value['version'] !== 1 || typeof value['id'] !== 'string' || typeof value['name'] !== 'string'
      || typeof value['rootNodeId'] !== 'string' || !Array.isArray(value['nodes'])
      || !Array.isArray(value['edges']) || !Array.isArray(value['layers'])) {
      return { error: 'worldline-map does not match the current WorldMap schema', start: match.index, end: match.index + match[0].length }
    }
    return { map: candidate as WorldMap, start: match.index, end: match.index + match[0].length }
  } catch (reason) {
    return { error: reason instanceof Error ? reason.message : String(reason), start: match.index, end: match.index + match[0].length }
  }
}

export function replaceWorldlineMapFence(content: string, map: WorldMap): string {
  const block = `\`\`\`worldline-map\n${JSON.stringify(map, null, 2)}\n\`\`\``
  return MAP_FENCE.test(content) ? content.replace(MAP_FENCE, block) : `${content.trimEnd()}\n\n${block}\n`
}

export function layoutWorldMap(map: WorldMap): WorldMap {
  const columns = Math.max(1, Math.ceil(Math.sqrt(map.nodes.length)))
  return {
    ...map,
    nodes: map.nodes.map((node, index) => ({
      ...node,
      position: { x: 110 + (index % columns) * 190, y: 95 + Math.floor(index / columns) * 145 },
    })),
  }
}

function validateMap(map: WorldMap): readonly string[] {
  const issues: string[] = []
  const ids = new Set(map.nodes.map(node => node.id))
  if (!ids.has(map.rootNodeId)) issues.push('Root node does not exist.')
  if (ids.size !== map.nodes.length) issues.push('Node IDs must be unique.')
  for (const node of map.nodes) {
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) issues.push(`${node.name}: invalid coordinates.`)
    if (node.parentId !== undefined && !ids.has(node.parentId)) issues.push(`${node.name}: parent does not exist.`)
  }
  for (const edge of map.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push(`${edge.id}: edge endpoint does not exist.`)
    if (edge.distance < 0 || edge.baseDuration < 0) issues.push(`${edge.id}: negative distance or duration.`)
  }
  return issues
}

function nextNodeId(map: WorldMap): MapNode['id'] {
  let index = map.nodes.length + 1
  while (map.nodes.some(node => node.id === `map-node:node-${String(index)}`)) index += 1
  return `map-node:node-${String(index)}` as MapNode['id']
}

interface MapWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly document?: EditorDocumentState | undefined
  readonly editDocument: (content: string) => void
  readonly saveDocument: () => Promise<void>
}

export function MapWorkbench(props: MapWorkbenchProps) {
  const parsed = useMemo(() => parseWorldlineMapFence(props.document?.content ?? ''), [props.document?.content])
  const [draft, setDraft] = useState<WorldMap>()
  const [selectedId, setSelectedId] = useState<MapNode['id']>()
  const [issues, setIssues] = useState<readonly string[]>([])
  const undo = useRef<WorldMap[]>([])
  const redo = useRef<WorldMap[]>([])

  useEffect(() => {
    setDraft(parsed.map)
    setSelectedId(parsed.map?.rootNodeId)
    setIssues(parsed.map === undefined ? [] : validateMap(parsed.map))
    undo.current = []
    redo.current = []
  }, [parsed.map, props.document?.document.revision])

  const commit = (next: WorldMap): void => {
    if (draft !== undefined) undo.current.push(draft)
    redo.current = []
    setDraft(next)
    setIssues(validateMap(next))
    if (props.document !== undefined) props.editDocument(replaceWorldlineMapFence(props.document.content, next))
  }
  const travel = (from: { current: WorldMap[] }, to: { current: WorldMap[] }): void => {
    const next = from.current.pop()
    if (next === undefined || draft === undefined) return
    to.current.push(draft)
    setDraft(next)
    setIssues(validateMap(next))
    if (props.document !== undefined) props.editDocument(replaceWorldlineMapFence(props.document.content, next))
  }

  if (props.document === undefined) return <div className={css.empty}><span>◎</span><h2>{props.t('map')}</h2><p>{props.t('mapHint')}</p></div>
  if (draft === undefined) return <div className={css.empty}><span>⌁</span><h2>{props.t('mapEmpty')}</h2><p>{parsed.error ?? props.t('mapHint')}</p></div>
  const selected = draft.nodes.find(node => node.id === selectedId)
  const width = Math.max(780, ...draft.nodes.map(node => node.position.x + 140))
  const height = Math.max(520, ...draft.nodes.map(node => node.position.y + 100))

  const updateSelected = (patch: Partial<MapNode>): void => {
    if (selected === undefined) return
    commit({ ...draft, nodes: draft.nodes.map(node => node.id === selected.id ? { ...node, ...patch } : node) })
  }

  return <div className={css.workbench}>
    <header className={css.toolbar}>
      <div><strong>{draft.name}</strong><small>{props.document.document.path}</small></div>
      <div>
        <button type="button" disabled={undo.current.length === 0} onClick={() => { travel(undo, redo) }}>{props.t('undo')}</button>
        <button type="button" disabled={redo.current.length === 0} onClick={() => { travel(redo, undo) }}>{props.t('redo')}</button>
        <button type="button" onClick={() => { commit(layoutWorldMap(draft)) }}>{props.t('autoLayout')}</button>
        <button type="button" onClick={() => { setIssues(validateMap(draft)) }}>{props.t('validate')}</button>
        <button type="button" onClick={() => {
          const id = nextNodeId(draft)
          commit({ ...draft, nodes: [...draft.nodes, {
            id, layerId: draft.layers[0]?.id ?? 'default', kind: 'region', name: `Node ${String(draft.nodes.length + 1)}`,
            position: { x: 120, y: 120 }, permissions: [], hazards: [], entryNodeIds: [],
          }] })
          setSelectedId(id)
        }}>{props.t('addNode')}</button>
        <button type="button" onClick={() => { void props.saveDocument() }}>{props.t('save')}</button>
      </div>
    </header>
    <div className={css.canvasScroller}>
      <svg className={css.canvas} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={draft.name}>
        <defs><pattern id="worldline-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" /></pattern></defs>
        <rect width="100%" height="100%" fill="url(#worldline-grid)" />
        {draft.edges.map((edge) => {
          const from = draft.nodes.find(node => node.id === edge.from)
          const to = draft.nodes.find(node => node.id === edge.to)
          if (from === undefined || to === undefined) return null
          return <g key={edge.id} className={css.edge}>
            <line x1={from.position.x} y1={from.position.y} x2={to.position.x} y2={to.position.y} />
            <text x={(from.position.x + to.position.x) / 2} y={(from.position.y + to.position.y) / 2 - 6}>{edge.baseDuration}</text>
          </g>
        })}
        {draft.nodes.map(node => <g
          key={node.id}
          className={css.node}
          data-selected={node.id === selectedId || undefined}
          transform={`translate(${String(node.position.x - 58)} ${String(node.position.y - 28)})`}
          role="button"
          tabIndex={0}
          onClick={() => { setSelectedId(node.id) }}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedId(node.id) }}
        >
          <rect width="116" height="56" rx="14" />
          <text x="58" y="24" textAnchor="middle">{node.name}</text>
          <text x="58" y="42" textAnchor="middle">{node.kind}</text>
        </g>)}
      </svg>
    </div>
    <aside className={css.inspector}>
      <h3>{selected?.name ?? props.t('map')}</h3>
      {selected !== undefined && <>
        <label>ID<input value={selected.id} readOnly /></label>
        <label>Name<input value={selected.name} onChange={(event) => { updateSelected({ name: event.target.value }) }} /></label>
        <label>Kind<select value={selected.kind} onChange={(event) => { updateSelected({ kind: event.target.value as MapNode['kind'] }) }}>
          {['world', 'plane', 'region', 'city', 'building', 'room', 'slot'].map(kind => <option key={kind}>{kind}</option>)}
        </select></label>
        <div className={css.coordinates}>
          <label>X<input type="number" value={selected.position.x} onChange={(event) => { updateSelected({ position: { ...selected.position, x: Number(event.target.value) } }) }} /></label>
          <label>Y<input type="number" value={selected.position.y} onChange={(event) => { updateSelected({ position: { ...selected.position, y: Number(event.target.value) } }) }} /></label>
        </div>
        <label>Capacity<input type="number" min="0" value={selected.capacity ?? ''} onChange={(event) => {
          const value = event.target.value
          if (value !== '') { updateSelected({ capacity: Number(value) }); return }
          const { capacity: _capacity, ...withoutCapacity } = selected
          commit({ ...draft, nodes: draft.nodes.map(node => node.id === selected.id ? withoutCapacity : node) })
        }} /></label>
      </>}
      <section className={css.validation} data-valid={issues.length === 0 || undefined}>
        <strong>{props.t('validate')} · {issues.length === 0 ? 'PASS' : String(issues.length)}</strong>
        {issues.map(issue => <p key={issue}>{issue}</p>)}
      </section>
    </aside>
  </div>
}
