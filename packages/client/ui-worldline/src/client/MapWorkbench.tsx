/* oxlint-disable @stylistic/max-len -- Compact controls keep map editing relationships visible. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, UIEvent } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MapEdge, MapLayer, MapNode, MapPoint, WorldMap } from '@deepseek-ai/dsh-worldline-standard/types'
import { worldlineLabel } from './presentation.ts'
import type { EditorDocumentState } from './types.ts'
import css from './MapWorkbench.module.css'

const MAP_FENCE = /```worldline-map\s*\r?\n([\s\S]*?)\r?\n```/iu
const MAP_NODE_KINDS = ['world', 'plane', 'region', 'city', 'building', 'room', 'slot'] as const
const SPATIAL_CELL = 320
const CANVAS_MIN_WIDTH = 1400
const CANVAS_MIN_HEIGHT = 860
const CANVAS_NODE_PADDING_X = 86
const CANVAS_NODE_PADDING_Y = 58

export interface ParsedMapFence {
  readonly map?: WorldMap
  readonly error?: string
  readonly start?: number
  readonly end?: number
}

export interface MapViewport {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface MapSpatialIndex {
  readonly cells: ReadonlyMap<string, readonly MapNode[]>
}

export interface MapNodeCluster {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly count: number
  readonly nodeIds: readonly MapNode['id'][]
}

export interface MapClusterProjection {
  readonly nodes: readonly MapNode[]
  readonly clusters: readonly MapNodeCluster[]
}

export interface MapCanvasFrame {
  readonly offsetX: number
  readonly offsetY: number
  readonly width: number
  readonly height: number
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function point(value: unknown): value is MapPoint {
  return object(value) && typeof value['x'] === 'number' && typeof value['y'] === 'number'
}

function layer(value: unknown): value is MapLayer {
  return object(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string'
    && typeof value['visible'] === 'boolean' && typeof value['locked'] === 'boolean'
    && typeof value['order'] === 'number'
}

function node(value: unknown): value is MapNode {
  return object(value) && typeof value['id'] === 'string' && typeof value['layerId'] === 'string'
    && typeof value['name'] === 'string' && MAP_NODE_KINDS.includes(value['kind'] as typeof MAP_NODE_KINDS[number])
    && point(value['position']) && strings(value['permissions']) && strings(value['hazards'])
    && strings(value['entryNodeIds']) && (value['polygon'] === undefined
      || Array.isArray(value['polygon']) && value['polygon'].every(point))
}

function edge(value: unknown): value is MapEdge {
  return object(value) && typeof value['id'] === 'string' && typeof value['from'] === 'string'
    && typeof value['to'] === 'string' && typeof value['bidirectional'] === 'boolean'
    && typeof value['distance'] === 'number' && typeof value['baseDuration'] === 'number'
    && strings(value['modes']) && strings(value['permissions']) && strings(value['hazards'])
}

function currentWorldMap(value: unknown): value is WorldMap {
  if (!object(value) || value['version'] !== 1 || typeof value['id'] !== 'string'
    || typeof value['name'] !== 'string' || typeof value['rootNodeId'] !== 'string'
    || !Array.isArray(value['nodes']) || !value['nodes'].every(node)
    || !Array.isArray(value['edges']) || !value['edges'].every(edge)
    || !Array.isArray(value['layers']) || !value['layers'].every(layer)
    || !Array.isArray(value['provenance'])) return false
  return value['backgroundAssetId'] === undefined || typeof value['backgroundAssetId'] === 'string'
}

export function parseWorldlineMapFence(content: string): ParsedMapFence {
  const match = MAP_FENCE.exec(content)
  if (match === null) return {}
  try {
    const candidate: unknown = JSON.parse(match[1] ?? '')
    if (!currentWorldMap(candidate)) {
      return { error: '地图数据不符合当前 WorldMap 格式', start: match.index, end: match.index + match[0].length }
    }
    return { map: candidate, start: match.index, end: match.index + match[0].length }
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
    nodes: map.nodes.map((item, index) => ({
      ...item,
      position: { x: 110 + (index % columns) * 190, y: 95 + Math.floor(index / columns) * 145 },
    })),
  }
}

/** Keep authored coordinates intact while ensuring edge nodes remain fully visible. */
export function mapCanvasFrame(map: WorldMap | undefined): MapCanvasFrame {
  if (map === undefined || map.nodes.length === 0) {
    return { offsetX: 0, offsetY: 0, width: CANVAS_MIN_WIDTH, height: CANVAS_MIN_HEIGHT }
  }
  const minX = Math.min(...map.nodes.map(item => item.position.x))
  const minY = Math.min(...map.nodes.map(item => item.position.y))
  const maxX = Math.max(...map.nodes.map(item => item.position.x))
  const maxY = Math.max(...map.nodes.map(item => item.position.y))
  const contentWidth = maxX - minX
  const contentHeight = maxY - minY
  const width = Math.max(CANVAS_MIN_WIDTH, contentWidth + CANVAS_NODE_PADDING_X * 2)
  const height = Math.max(CANVAS_MIN_HEIGHT, contentHeight + CANVAS_NODE_PADDING_Y * 2)
  const offsetX = (width - contentWidth) / 2 - minX
  const offsetY = (height - contentHeight) / 2 - minY
  return {
    offsetX,
    offsetY,
    width,
    height,
  }
}

export function buildMapSpatialIndex(map: WorldMap): MapSpatialIndex {
  const mutable = new Map<string, MapNode[]>()
  for (const item of map.nodes) {
    const key = `${String(Math.floor(item.position.x / SPATIAL_CELL))}:${String(Math.floor(item.position.y / SPATIAL_CELL))}`
    const bucket = mutable.get(key) ?? []
    bucket.push(item)
    mutable.set(key, bucket)
  }
  return { cells: mutable }
}

export function visibleMapNodes(
  index: MapSpatialIndex,
  viewport: MapViewport,
  visibleLayers: ReadonlySet<string>,
  overscan = 180,
): readonly MapNode[] {
  const left = viewport.left - overscan
  const top = viewport.top - overscan
  const right = viewport.right + overscan
  const bottom = viewport.bottom + overscan
  const result = new Map<MapNode['id'], MapNode>()
  for (let x = Math.floor(left / SPATIAL_CELL); x <= Math.floor(right / SPATIAL_CELL); x += 1) {
    for (let y = Math.floor(top / SPATIAL_CELL); y <= Math.floor(bottom / SPATIAL_CELL); y += 1) {
      for (const item of index.cells.get(`${String(x)}:${String(y)}`) ?? []) {
        if (visibleLayers.has(item.layerId) && item.position.x >= left && item.position.x <= right
          && item.position.y >= top && item.position.y <= bottom) result.set(item.id, item)
      }
    }
  }
  return [...result.values()]
}

/** Collapse dense low-zoom nodes into deterministic grid clusters without changing map data. */
export function clusterMapNodes(
  nodes: readonly MapNode[],
  zoom: number,
  pinnedIds: ReadonlySet<MapNode['id']> = new Set(),
): MapClusterProjection {
  if (zoom >= 0.8 && nodes.length <= 600) return { nodes, clusters: [] }
  const cellSize = Math.max(180, 260 / Math.max(0.25, zoom))
  const buckets = new Map<string, MapNode[]>()
  const individuals: MapNode[] = []
  for (const item of nodes) {
    if (pinnedIds.has(item.id)) { individuals.push(item); continue }
    const key = `${item.layerId}:${String(Math.floor(item.position.x / cellSize))}:${String(Math.floor(item.position.y / cellSize))}`
    const bucket = buckets.get(key) ?? []
    bucket.push(item)
    buckets.set(key, bucket)
  }
  const clusters: MapNodeCluster[] = []
  for (const [id, bucket] of buckets) {
    if (bucket.length === 1) {
      const item = bucket[0]
      if (item !== undefined) individuals.push(item)
      continue
    }
    clusters.push({
      id,
      x: bucket.reduce((sum, item) => sum + item.position.x, 0) / bucket.length,
      y: bucket.reduce((sum, item) => sum + item.position.y, 0) / bucket.length,
      count: bucket.length,
      nodeIds: bucket.map(item => item.id),
    })
  }
  return { nodes: individuals, clusters }
}

function mapIssues(map: WorldMap): readonly string[] {
  const issues: string[] = []
  const nodeIds = new Set(map.nodes.map(item => item.id))
  const edgeIds = new Set(map.edges.map(item => item.id))
  const layerIds = new Set(map.layers.map(item => item.id))
  if (nodeIds.size !== map.nodes.length) issues.push('节点 ID 不能重复。')
  if (edgeIds.size !== map.edges.length) issues.push('路径 ID 不能重复。')
  if (layerIds.size !== map.layers.length) issues.push('图层 ID 不能重复。')
  if (!nodeIds.has(map.rootNodeId)) issues.push('地图根节点不存在。')
  for (const item of map.nodes) {
    if (!layerIds.has(item.layerId)) issues.push(`${item.id}：图层不存在。`)
    if (item.parentId !== undefined && !nodeIds.has(item.parentId)) issues.push(`${item.id}：上级区域不存在。`)
    if (!Number.isFinite(item.position.x) || !Number.isFinite(item.position.y)) issues.push(`${item.id}：坐标必须是有限数值。`)
    if (item.capacity !== undefined && (!Number.isFinite(item.capacity) || item.capacity < 0)) issues.push(`${item.id}：容纳数量必须是非负有限数值。`)
    const seen = new Set<string>()
    let cursor: MapNode['id'] | undefined = item.id
    while (cursor !== undefined) {
      if (seen.has(cursor)) { issues.push(`${item.id}：层级关系存在循环。`); break }
      seen.add(cursor)
      cursor = map.nodes.find(candidate => candidate.id === cursor)?.parentId
    }
  }
  for (const item of map.edges) {
    if (!nodeIds.has(item.from) || !nodeIds.has(item.to)) issues.push(`${item.id}：路径端点不存在。`)
    if (!Number.isFinite(item.distance) || item.distance < 0 || !Number.isFinite(item.baseDuration) || item.baseDuration < 0) {
      issues.push(`${item.id}：距离和耗时必须是非负有限数值。`)
    }
  }
  return issues
}

function nextId(prefix: 'map-node' | 'map-edge', used: ReadonlySet<string>): string {
  let index = used.size + 1
  while (used.has(`${prefix}:item-${String(index)}`)) index += 1
  return `${prefix}:item-${String(index)}`
}

function list(value: string): readonly string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

interface MapWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly document?: EditorDocumentState | undefined
  readonly editDocument: (content: string) => void
  readonly saveDocument: () => Promise<void>
}

export function MapWorkbench(props: MapWorkbenchProps) {
  const parsed = useMemo(() => parseWorldlineMapFence(props.document?.content ?? ''), [props.document?.content])
  const [draft, setDraft] = useState<WorldMap>()
  const [selectedNodeId, setSelectedNodeId] = useState<MapNode['id']>()
  const [selectedEdgeId, setSelectedEdgeId] = useState<MapEdge['id']>()
  const [issues, setIssues] = useState<readonly string[]>([])
  const [zoom, setZoom] = useState(1)
  const [panning, setPanning] = useState(false)
  const [viewport, setViewport] = useState<MapViewport>({ left: 0, top: 0, right: 1600, bottom: 1000 })
  const undo = useRef<WorldMap[]>([])
  const redo = useRef<WorldMap[]>([])
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<SVGSVGElement>(null)
  const pan = useRef<{
    pointerId: number
    x: number
    y: number
    left: number
    top: number
  }>()
  const nodeDrag = useRef<{
    pointerId: number
    nodeId: MapNode['id']
    x: number
    y: number
    position: MapPoint
    base: WorldMap
    moved: boolean
  }>()
  const suppressNodeClick = useRef<MapNode['id']>()
  const frame = useMemo(() => mapCanvasFrame(draft), [draft])

  useEffect(() => {
    setDraft(parsed.map)
    setSelectedNodeId(parsed.map?.rootNodeId)
    setSelectedEdgeId(undefined)
    setIssues(parsed.map === undefined ? [] : mapIssues(parsed.map))
    undo.current = []
    redo.current = []
    if (parsed.map !== undefined) {
      const nextMap = parsed.map
      window.requestAnimationFrame(() => {
        const target = scroller.current
        if (target === null || nextMap.nodes.length === 0) return
        const nextFrame = mapCanvasFrame(nextMap)
        const centerX = (Math.min(...nextMap.nodes.map(item => item.position.x))
          + Math.max(...nextMap.nodes.map(item => item.position.x))) / 2 + nextFrame.offsetX
        const centerY = (Math.min(...nextMap.nodes.map(item => item.position.y))
          + Math.max(...nextMap.nodes.map(item => item.position.y))) / 2 + nextFrame.offsetY
        target.scrollTo({
          left: centerX * zoom - target.clientWidth / 2,
          top: centerY * zoom - target.clientHeight / 2,
        })
      })
    }
  }, [parsed.map, props.document?.document.revision])

  const commit = (next: WorldMap): void => {
    if (draft !== undefined) undo.current.push(draft)
    redo.current = []
    setDraft(next)
    setIssues(mapIssues(next))
    if (props.document !== undefined) props.editDocument(replaceWorldlineMapFence(props.document.content, next))
  }

  const travel = (from: { current: WorldMap[] }, to: { current: WorldMap[] }): void => {
    const next = from.current.pop()
    if (next === undefined || draft === undefined) return
    to.current.push(draft)
    setDraft(next)
    setIssues(mapIssues(next))
    if (props.document !== undefined) props.editDocument(replaceWorldlineMapFence(props.document.content, next))
  }

  const updateViewport = (event?: UIEvent<HTMLDivElement>): void => {
    const target = event?.currentTarget ?? scroller.current
    if (target === null) return
    setViewport({
      left: target.scrollLeft / zoom - frame.offsetX,
      top: target.scrollTop / zoom - frame.offsetY,
      right: (target.scrollLeft + target.clientWidth) / zoom - frame.offsetX,
      bottom: (target.scrollTop + target.clientHeight) / zoom - frame.offsetY,
    })
  }

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest('[data-map-interactive]') !== null) return
    pan.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPanning(true)
    event.preventDefault()
  }

  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = pan.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    event.currentTarget.scrollLeft = active.left - (event.clientX - active.x)
    event.currentTarget.scrollTop = active.top - (event.clientY - active.y)
    updateViewport()
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pan.current?.pointerId !== event.pointerId) return
    pan.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setPanning(false)
  }

  const beginNodeDrag = (event: ReactPointerEvent<SVGGElement>, item: MapNode): void => {
    if (event.button !== 0 || draft === undefined
      || draft.layers.find(layerItem => layerItem.id === item.layerId)?.locked === true) return
    nodeDrag.current = {
      pointerId: event.pointerId,
      nodeId: item.id,
      x: event.clientX,
      y: event.clientY,
      position: item.position,
      base: draft,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectedNodeId(item.id)
    setSelectedEdgeId(undefined)
    event.stopPropagation()
  }

  const moveNodeDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    const active = nodeDrag.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    const deltaX = (event.clientX - active.x) / zoom
    const deltaY = (event.clientY - active.y) / zoom
    if (!active.moved && Math.hypot(deltaX, deltaY) < 3) return
    active.moved = true
    const position = { x: Math.round(active.position.x + deltaX), y: Math.round(active.position.y + deltaY) }
    setDraft({
      ...active.base,
      nodes: active.base.nodes.map(nodeItem => nodeItem.id === active.nodeId ? { ...nodeItem, position } : nodeItem),
    })
    event.stopPropagation()
  }

  const endNodeDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    const active = nodeDrag.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    nodeDrag.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!active.moved) return
    const position = {
      x: Math.round(active.position.x + (event.clientX - active.x) / zoom),
      y: Math.round(active.position.y + (event.clientY - active.y) / zoom),
    }
    suppressNodeClick.current = active.nodeId
    commit({
      ...active.base,
      nodes: active.base.nodes.map(nodeItem => nodeItem.id === active.nodeId ? { ...nodeItem, position } : nodeItem),
    })
    event.stopPropagation()
  }

  const cancelNodeDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    const active = nodeDrag.current
    if (active === undefined || active.pointerId !== event.pointerId) return
    nodeDrag.current = undefined
    setDraft(active.base)
  }

  const index = useMemo(() => draft === undefined ? undefined : buildMapSpatialIndex(draft), [draft])
  const visibleLayers = useMemo(() => new Set(draft?.layers.filter(item => item.visible).map(item => item.id) ?? []), [draft])
  const renderedNodes = useMemo(() => index === undefined ? [] : visibleMapNodes(index, viewport, visibleLayers), [index, viewport, visibleLayers])
  const renderedNodeIds = useMemo(() => new Set(renderedNodes.map(item => item.id)), [renderedNodes])
  const clustered = useMemo(() => clusterMapNodes(
    renderedNodes,
    zoom,
    selectedNodeId === undefined ? new Set() : new Set([selectedNodeId]),
  ), [renderedNodes, selectedNodeId, zoom])

  if (props.document === undefined) return <div className={css.empty}><span>◎</span><h2>{props.t('map')}</h2><p>{props.t('mapHint')}</p></div>
  if (draft === undefined) return <div className={css.empty}><span>⌁</span><h2>{props.t('mapEmpty')}</h2><p>{parsed.error ?? props.t('mapHint')}</p></div>

  const selectedNode = draft.nodes.find(item => item.id === selectedNodeId)
  const selectedEdge = draft.edges.find(item => item.id === selectedEdgeId)
  const selectedLayer = draft.layers.find(item => item.id === selectedNode?.layerId)
  const { width, height } = frame
  const renderedEdges = draft.edges.flatMap((item) => {
    const from = draft.nodes.find(nodeItem => nodeItem.id === item.from)
    const to = draft.nodes.find(nodeItem => nodeItem.id === item.to)
    return from === undefined || to === undefined || !visibleLayers.has(from.layerId) || !visibleLayers.has(to.layerId)
      || !renderedNodeIds.has(from.id) && !renderedNodeIds.has(to.id)
      ? [] : [{ item, from, to }]
  })
  const batchEdges = clustered.clusters.length > 0 || renderedEdges.length > 800
  const edgeBatchPath = batchEdges ? renderedEdges
    .filter(({ item }) => item.id !== selectedEdgeId)
    .map(({ from, to }) => `M${String(from.position.x)} ${String(from.position.y)}L${String(to.position.x)} ${String(to.position.y)}`)
    .join('') : ''

  const updateSelectedNode = (patch: Partial<MapNode>): void => {
    if (selectedNode === undefined || selectedLayer?.locked === true) return
    commit({ ...draft, nodes: draft.nodes.map(item => item.id === selectedNode.id ? { ...item, ...patch } : item) })
  }

  const updateSelectedEdge = (patch: Partial<MapEdge>): void => {
    if (selectedEdge === undefined) return
    commit({ ...draft, edges: draft.edges.map(item => item.id === selectedEdge.id ? { ...item, ...patch } : item) })
  }

  return <div className={css.workbench}>
    <header className={css.toolbar}>
      <div><strong>{draft.name}</strong><small>{props.document.document.path} · {renderedNodes.length}/{draft.nodes.length} {props.t('visibleNodes')}</small></div>
      <div>
        <button type="button" disabled={undo.current.length === 0} onClick={() => { travel(undo, redo) }}>{props.t('undo')}</button>
        <button type="button" disabled={redo.current.length === 0} onClick={() => { travel(redo, undo) }}>{props.t('redo')}</button>
        <button type="button" onClick={() => {
          const next = layoutWorldMap(draft)
          commit(next)
          window.requestAnimationFrame(() => {
            const target = scroller.current
            if (target === null) return
            const nextFrame = mapCanvasFrame(next)
            const centerX = (Math.min(...next.nodes.map(item => item.position.x))
              + Math.max(...next.nodes.map(item => item.position.x))) / 2 + nextFrame.offsetX
            const centerY = (Math.min(...next.nodes.map(item => item.position.y))
              + Math.max(...next.nodes.map(item => item.position.y))) / 2 + nextFrame.offsetY
            target.scrollTo({
              left: centerX * zoom - target.clientWidth / 2,
              top: centerY * zoom - target.clientHeight / 2,
              behavior: 'smooth',
            })
          })
        }}>{props.t('autoLayout')}</button>
        <button type="button" onClick={() => { setIssues(mapIssues(draft)) }}>{props.t('validate')}</button>
        <button type="button" onClick={() => {
          const id = nextId('map-node', new Set(draft.nodes.map(item => item.id))) as MapNode['id']
          const targetLayer = draft.layers.find(item => item.visible && !item.locked) ?? draft.layers[0]
          if (targetLayer === undefined) return
          commit({ ...draft, nodes: [...draft.nodes, { id, layerId: targetLayer.id, kind: 'region', name: `新区域 ${String(draft.nodes.length + 1)}`, position: { x: viewport.left + 140, y: viewport.top + 100 }, permissions: [], hazards: [], entryNodeIds: [] }] })
          setSelectedNodeId(id); setSelectedEdgeId(undefined)
        }}>{props.t('addNode')}</button>
        <button type="button" disabled={draft.nodes.length < 2} onClick={() => {
          const from = selectedNode ?? draft.nodes[0]
          const to = draft.nodes.find(item => item.id !== from?.id)
          if (from === undefined || to === undefined) return
          const id = nextId('map-edge', new Set(draft.edges.map(item => item.id))) as MapEdge['id']
          commit({ ...draft, edges: [...draft.edges, { id, from: from.id, to: to.id, bidirectional: true, distance: 1, baseDuration: 1, modes: ['walk'], permissions: [], hazards: [] }] })
          setSelectedEdgeId(id); setSelectedNodeId(undefined)
        }}>{props.t('addEdge')}</button>
        <label className={css.zoom}>{props.t('zoom')}<input type="range" min="0.25" max="2" step="0.05" value={zoom} onChange={(event) => { setZoom(Number(event.target.value)); window.requestAnimationFrame(() => { updateViewport() }) }} /></label>
        <button type="button" onClick={() => { void props.saveDocument() }}>{props.t('save')}</button>
      </div>
    </header>
    <div className={css.canvasScroller} data-testid="worldline-map-canvas"
      data-panning={panning || undefined} ref={scroller}
      onScroll={updateViewport} onPointerDown={beginPan} onPointerMove={movePan}
      onPointerUp={endPan} onPointerCancel={endPan}>
      <svg ref={canvas} className={css.canvas} width={width * zoom} height={height * zoom} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={draft.name}>
        <defs><pattern id="worldline-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" /></pattern></defs>
        <rect width="100%" height="100%" fill="url(#worldline-grid)" />
        {draft.backgroundAssetId !== undefined && <text className={css.backgroundLabel} x="18" y="30">{props.t('background')}: {draft.backgroundAssetId}</text>}
        <g transform={`translate(${String(frame.offsetX)} ${String(frame.offsetY)})`}>
          {edgeBatchPath !== '' && <path className={css.edgeBatch} d={edgeBatchPath} />}
          {renderedEdges.map(({ item, from, to }) => {
            if (batchEdges && item.id !== selectedEdgeId) return null
            return <g key={item.id} className={css.edge} data-map-interactive data-selected={item.id === selectedEdgeId || undefined} role="button" tabIndex={0} onClick={() => { setSelectedEdgeId(item.id); setSelectedNodeId(undefined) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelectedEdgeId(item.id); setSelectedNodeId(undefined) } }}>
              <line x1={from.position.x} y1={from.position.y} x2={to.position.x} y2={to.position.y} />
              <text x={(from.position.x + to.position.x) / 2} y={(from.position.y + to.position.y) / 2 - 6}>{item.modes.map(worldlineLabel).join('/')} · {item.baseDuration}t</text>
            </g>
          })}
          {clustered.clusters.map(cluster => <g key={cluster.id} className={css.cluster} data-map-interactive transform={`translate(${String(cluster.x)} ${String(cluster.y)})`} role="button" tabIndex={0} aria-label={`${String(cluster.count)} ${props.t('clusteredNodes')}`} onClick={() => {
            const nextZoom = Math.min(2, Math.max(.8, zoom * 1.75))
            setZoom(nextZoom)
            window.requestAnimationFrame(() => {
              if (scroller.current === null) return
              scroller.current.scrollTo({ left: (cluster.x + frame.offsetX) * nextZoom - scroller.current.clientWidth / 2, top: (cluster.y + frame.offsetY) * nextZoom - scroller.current.clientHeight / 2, behavior: 'smooth' })
              updateViewport()
            })
          }}><circle r={Math.min(38, 18 + Math.log2(cluster.count) * 4)} /><text textAnchor="middle" y="4">{cluster.count}</text></g>)}
          {clustered.nodes.map(item => <g key={item.id} className={css.node} data-map-interactive data-selected={item.id === selectedNodeId || undefined} data-locked={draft.layers.find(layerItem => layerItem.id === item.layerId)?.locked || undefined} transform={`translate(${String(item.position.x - 58)} ${String(item.position.y - 28)})`} role="button" tabIndex={0} aria-label={`${item.name} ${worldlineLabel(item.kind)}`} onPointerDown={(event) => { beginNodeDrag(event, item) }} onPointerMove={moveNodeDrag} onPointerUp={endNodeDrag} onPointerCancel={cancelNodeDrag} onClick={() => {
            if (suppressNodeClick.current === item.id) { suppressNodeClick.current = undefined; return }
            setSelectedNodeId(item.id); setSelectedEdgeId(undefined)
          }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelectedNodeId(item.id); setSelectedEdgeId(undefined) } }}>
            {item.polygon !== undefined && <polygon points={item.polygon.map(pointItem => `${String(pointItem.x - item.position.x + 58)},${String(pointItem.y - item.position.y + 28)}`).join(' ')} />}
            <rect width="116" height="56" rx="14" /><text x="58" y="24" textAnchor="middle">{item.name}</text><text x="58" y="42" textAnchor="middle">{worldlineLabel(item.kind)}</text>
          </g>)}
        </g>
      </svg>
    </div>
    <aside className={css.inspector}>
      <section className={css.layers}><header><h3>{props.t('layers')}</h3><button type="button" onClick={() => {
        let index = draft.layers.length + 1
        while (draft.layers.some(item => item.id === `layer-${String(index)}`)) index += 1
        commit({ ...draft, layers: [...draft.layers, { id: `layer-${String(index)}`, name: `图层 ${String(index)}`, visible: true, locked: false, order: draft.layers.length }] })
      }}>＋</button></header>{[...draft.layers].sort((a, b) => a.order - b.order).map(item => <div key={item.id}>
        <button type="button" aria-label={`${props.t('visibility')} ${item.name}`} data-enabled={item.visible || undefined} onClick={() => { commit({ ...draft, layers: draft.layers.map(layerItem => layerItem.id === item.id ? { ...layerItem, visible: !layerItem.visible } : layerItem) }) }}>{item.visible ? '◉' : '○'}</button>
        <input value={item.name} onChange={(event) => { commit({ ...draft, layers: draft.layers.map(layerItem => layerItem.id === item.id ? { ...layerItem, name: event.target.value } : layerItem) }) }} />
        <button type="button" aria-label={`${props.t('lock')} ${item.name}`} data-enabled={item.locked || undefined} onClick={() => { commit({ ...draft, layers: draft.layers.map(layerItem => layerItem.id === item.id ? { ...layerItem, locked: !layerItem.locked } : layerItem) }) }}>{item.locked ? '◆' : '◇'}</button>
      </div>)}</section>
      <label>{props.t('background')}<input value={draft.backgroundAssetId ?? ''} placeholder="asset:…" onChange={(event) => {
        const value = event.target.value.trim()
        if (value !== '') { commit({ ...draft, backgroundAssetId: value as NonNullable<WorldMap['backgroundAssetId']> }); return }
        const { backgroundAssetId: _backgroundAssetId, ...withoutBackground } = draft
        commit(withoutBackground)
      }} /></label>
      {selectedNode !== undefined && <section><h3>{selectedNode.name}</h3>
        {selectedLayer?.locked === true && <p className={css.locked}>{props.t('layerLocked')}</p>}
        <label>ID<input value={selectedNode.id} readOnly /></label>
        <label>{props.t('mapName')}<input value={selectedNode.name} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ name: event.target.value }) }} /></label>
        <label>{props.t('mapKind')}<select value={selectedNode.kind} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ kind: event.target.value as MapNode['kind'] }) }}>{MAP_NODE_KINDS.map(kind => <option key={kind} value={kind}>{worldlineLabel(kind)}</option>)}</select></label>
        <label>{props.t('layers')}<select value={selectedNode.layerId} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ layerId: event.target.value }) }}>{draft.layers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>{props.t('mapParent')}<select value={selectedNode.parentId ?? ''} disabled={selectedLayer?.locked} onChange={(event) => {
          if (event.target.value !== '') { updateSelectedNode({ parentId: event.target.value as MapNode['id'] }); return }
          const { parentId: _parentId, ...withoutParent } = selectedNode
          commit({ ...draft, nodes: draft.nodes.map(item => item.id === selectedNode.id ? withoutParent : item) })
        }}><option value="">—</option>{draft.nodes.filter(item => item.id !== selectedNode.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className={css.coordinates}><label>X<input type="number" value={selectedNode.position.x} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ position: { ...selectedNode.position, x: Number(event.target.value) } }) }} /></label><label>Y<input type="number" value={selectedNode.position.y} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ position: { ...selectedNode.position, y: Number(event.target.value) } }) }} /></label></div>
        <label>{props.t('mapCapacity')}<input type="number" min="0" value={selectedNode.capacity ?? ''} disabled={selectedLayer?.locked} onChange={(event) => {
          if (event.target.value !== '') { updateSelectedNode({ capacity: Number(event.target.value) }); return }
          const { capacity: _capacity, ...withoutCapacity } = selectedNode
          commit({ ...draft, nodes: draft.nodes.map(item => item.id === selectedNode.id ? withoutCapacity : item) })
        }} /></label>
        <label>{props.t('mapEntries')}<input value={selectedNode.entryNodeIds.join(', ')} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ entryNodeIds: list(event.target.value) as readonly MapNode['id'][] }) }} /></label>
        <label>{props.t('mapPermissions')}<input value={selectedNode.permissions.join(', ')} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ permissions: list(event.target.value) }) }} /></label>
        <label>{props.t('mapHazards')}<input value={selectedNode.hazards.join(', ')} disabled={selectedLayer?.locked} onChange={(event) => { updateSelectedNode({ hazards: list(event.target.value) }) }} /></label>
      </section>}
      {selectedEdge !== undefined && <section><h3>{selectedEdge.id}</h3>
        <label>{props.t('edgeFrom')}<select value={selectedEdge.from} onChange={(event) => { updateSelectedEdge({ from: event.target.value as MapNode['id'] }) }}>{draft.nodes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>{props.t('edgeTo')}<select value={selectedEdge.to} onChange={(event) => { updateSelectedEdge({ to: event.target.value as MapNode['id'] }) }}>{draft.nodes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className={css.check}><input type="checkbox" checked={selectedEdge.bidirectional} onChange={(event) => { updateSelectedEdge({ bidirectional: event.target.checked }) }} />{props.t('edgeBidirectional')}</label>
        <div className={css.coordinates}><label>{props.t('edgeDistance')}<input type="number" min="0" value={selectedEdge.distance} onChange={(event) => { updateSelectedEdge({ distance: Number(event.target.value) }) }} /></label><label>{props.t('edgeDuration')}<input type="number" min="0" value={selectedEdge.baseDuration} onChange={(event) => { updateSelectedEdge({ baseDuration: Number(event.target.value) }) }} /></label></div>
        <label>{props.t('mapCapacity')}<input type="number" min="0" value={selectedEdge.capacity ?? ''} onChange={(event) => {
          if (event.target.value !== '') { updateSelectedEdge({ capacity: Number(event.target.value) }); return }
          const { capacity: _capacity, ...withoutCapacity } = selectedEdge
          commit({ ...draft, edges: draft.edges.map(item => item.id === selectedEdge.id ? withoutCapacity : item) })
        }} /></label>
        <label>{props.t('edgeModes')}<input value={selectedEdge.modes.join(', ')} onChange={(event) => { updateSelectedEdge({ modes: list(event.target.value) }) }} /></label>
        <label>{props.t('mapPermissions')}<input value={selectedEdge.permissions.join(', ')} onChange={(event) => { updateSelectedEdge({ permissions: list(event.target.value) }) }} /></label>
        <label>{props.t('mapHazards')}<input value={selectedEdge.hazards.join(', ')} onChange={(event) => { updateSelectedEdge({ hazards: list(event.target.value) }) }} /></label>
        <label>{props.t('dynamicCondition')}<input value={selectedEdge.dynamicCondition ?? ''} onChange={(event) => {
          if (event.target.value !== '') { updateSelectedEdge({ dynamicCondition: event.target.value }); return }
          const { dynamicCondition: _dynamicCondition, ...withoutCondition } = selectedEdge
          commit({ ...draft, edges: draft.edges.map(item => item.id === selectedEdge.id ? withoutCondition : item) })
        }} /></label>
      </section>}
      <section className={css.validation} data-valid={issues.length === 0 || undefined}><strong>{issues.length === 0 ? props.t('validationPassed') : `${props.t('validate')} · ${String(issues.length)} 项问题`}</strong>{issues.map(issue => <p key={issue}>{issue}</p>)}</section>
    </aside>
  </div>
}
