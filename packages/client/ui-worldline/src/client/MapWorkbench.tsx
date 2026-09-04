import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { RunSpatialMap, RunSpatialView, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { MapNode, WorldMap } from '@deepseek-ai/dsh-worldline-standard/types'
import { entityName, gameCalendar, gameDuration, placeName, snapshotEntities, worldlineLabel } from './presentation.ts'
import { LocationMapComposer } from './LocationMapComposer.tsx'
import type { ProjectClient, RunsClient } from './types.ts'
import css from './MapWorkbench.module.css'

const SPATIAL_CELL = 320
const CANVAS_MIN_WIDTH = 1400
const CANVAS_MIN_HEIGHT = 860
const CANVAS_NODE_PADDING_X = 86
const CANVAS_NODE_PADDING_Y = 58

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

export function layoutWorldMap<T extends WorldMap | RunSpatialMap>(map: T): T {
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
  return {
    offsetX: (width - contentWidth) / 2 - minX,
    offsetY: (height - contentHeight) / 2 - minY,
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

function RuntimeWorldAtlas({ project, runs, runRevision = 0 }: {
  readonly project: ProjectSummary
  readonly runs: RunsClient
  readonly runRevision?: number
}) {
  const [view, setView] = useState<RunView>()
  const [spatial, setSpatial] = useState<RunSpatialView>()
  const [selectedNodeId, setSelectedNodeId] = useState<string>()
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  const pan = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>()

  const load = useCallback(async (): Promise<void> => {
    const available = (await runs.list()).filter(item => item.projectId === project.manifest.id)
    const run = available.find(item => item.status === 'running') ?? available[0]
    if (run === undefined) { setView(undefined); setSpatial(undefined); return }
    const [nextView, nextSpatial] = await Promise.all([
      runs.view({ runId: run.runId }),
      runs.spatial({ runId: run.runId, maxNodes: 5_000 }),
    ])
    setView(nextView)
    setSpatial(nextSpatial)
    setSelectedNodeId(current => current !== undefined && nextSpatial.map?.nodes.some(item => item.id === current)
      ? current : nextSpatial.map?.rootNodeId)
  }, [project.manifest.id, runs])

  useEffect(() => {
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [load, runRevision])

  const map = spatial?.map === undefined ? undefined : layoutWorldMap(spatial.map)
  const selectedNode = map?.nodes.find(item => item.id === selectedNodeId)
  const entities = snapshotEntities(view?.snapshot)
  const actorNames = new Map(spatial?.actors.map((actor, index) => [
    actor.actorId, entityName(entities, actor.actorId, index),
  ]) ?? [])
  const calendar = view === undefined ? undefined : gameCalendar(view.snapshot)
  const bounds = map === undefined || map.nodes.length === 0 ? undefined : {
    minX: Math.min(...map.nodes.map(item => item.position.x)),
    maxX: Math.max(...map.nodes.map(item => item.position.x)),
    minY: Math.min(...map.nodes.map(item => item.position.y)),
    maxY: Math.max(...map.nodes.map(item => item.position.y)),
  }
  const point = (nodeId: string): { x: number; y: number } | undefined => {
    const item = map?.nodes.find(candidate => candidate.id === nodeId)
    if (item === undefined || bounds === undefined) return undefined
    return {
      x: 90 + (item.position.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX) * 960,
      y: 80 + (item.position.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY) * 520,
    }
  }
  const residents = spatial?.actors.filter(actor => actor.nodeId === selectedNodeId) ?? []

  if (map === undefined || map.nodes.length === 0) return <div className={css.atlasEmpty}>
    <span>WORLD ATLAS</span><h2>地图尚未进入运行世界</h2><p>请先在“创作设定”中通过可运行性检查并开启一次视觉演绎。地点档案和地图编排会自动转成运行地图，不需要在 Markdown 中填写 JSON。</p>
    {error !== undefined && <small>{error}</small>}
  </div>

  return <div className={css.atlas}>
    <header className={css.atlasHeader}><div><span>OC WORLD ATLAS</span><h2>{map.name}</h2><p>{String(map.nodes.length)} 个地点 · {String(map.edges.length)} 条通路</p></div><div className={css.atlasClock}><small>{calendar?.dateLabel ?? '世界时间'}</small><strong>{calendar?.timeLabel ?? '--:--'}</strong><label>缩放 <input type="range" min="0.7" max="1.8" step="0.1" value={zoom} onChange={(event) => { setZoom(Number(event.target.value)) }} /></label></div></header>
    <div className={css.atlasBody}>
      <div ref={scroller} className={css.atlasScroller} data-panning={pan.current !== undefined || undefined} onPointerDown={(event) => {
        if (event.button !== 0 || event.target instanceof Element && event.target.closest('[data-place]') !== null) return
        const target = scroller.current
        if (target === null) return
        target.setPointerCapture(event.pointerId)
        pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: target.scrollLeft, top: target.scrollTop }
      }} onPointerMove={(event) => {
        const state = pan.current; const target = scroller.current
        if (state === undefined || target === null || state.pointerId !== event.pointerId) return
        target.scrollLeft = state.left - (event.clientX - state.x); target.scrollTop = state.top - (event.clientY - state.y)
      }} onPointerUp={(event) => {
        if (pan.current?.pointerId === event.pointerId) pan.current = undefined
      }} onPointerCancel={() => { pan.current = undefined }}>
        <svg className={css.atlasCanvas} style={{ width: `${String(1_180 * zoom)}px`, height: `${String(680 * zoom)}px` }} viewBox="0 0 1180 680" role="img" aria-label={map.name}>
          <defs><pattern id="atlas-grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" /></pattern></defs><rect width="1180" height="680" fill="url(#atlas-grid)" />
          {map.edges.map((edge) => { const from = point(edge.from); const to = point(edge.to); return from === undefined || to === undefined ? null : <g key={edge.id} className={css.atlasEdge}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} /><text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 7} textAnchor="middle">{gameDuration(edge.baseDuration)}</text></g> })}
          {map.nodes.map((node) => { const position = point(node.id); if (position === undefined) return null; const count = spatial?.actors.filter(actor => actor.nodeId === node.id).length ?? 0; const label = node.name.length > 10 ? `${node.name.slice(0, 9)}…` : node.name; return <g key={node.id} data-place className={css.atlasNode} data-selected={node.id === selectedNodeId || undefined} transform={`translate(${String(position.x)} ${String(position.y)})`} role="button" tabIndex={0} onClick={() => { setSelectedNodeId(node.id) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedNodeId(node.id) }}><rect x="-68" y="-31" width="136" height="62" rx="14" /><text y="-4" textAnchor="middle">{label}</text><text y="15" textAnchor="middle">{worldlineLabel(node.kind)}{count === 0 ? '' : ` · ${String(count)} 人`}</text></g> })}
          {spatial?.actors.map((actor, index) => { const position = point(actor.nodeId); if (position === undefined) return null; const angle = index * 1.8; return <g key={actor.actorId} className={css.atlasActor} transform={`translate(${String(position.x + Math.cos(angle) * 42)} ${String(position.y + Math.sin(angle) * 42)})`}><circle r="7" /><title>{actorNames.get(actor.actorId)}</title></g> })}
        </svg>
      </div>
      <aside className={css.atlasPanel}><span>PLACE ARCHIVE</span><h3>{selectedNode?.name ?? '选择地点'}</h3><p className={css.placeType}>{selectedNode === undefined ? '点击地图上的地点，查看完整地点档案。' : `${worldlineLabel(selectedNode.kind)} · ${map.layers.find(layer => layer.id === selectedNode.layerId)?.name ?? '世界地图'}`}</p>{selectedNode !== undefined && <section className={css.placeDescription}><small>地点描述</small><p>{selectedNode.description ?? '此地点在旧构建中缺少描述；重新构建后将由地点档案提供完整风貌、感官与用途。'}</p></section>}<dl><div><dt>相邻地点</dt><dd>{String(map.edges.filter(edge => edge.from === selectedNodeId || edge.to === selectedNodeId).length)}</dd></div><div><dt>当前居民</dt><dd>{String(residents.length)}</dd></div><div><dt>环境风险</dt><dd>{selectedNode?.hazards.length === 0 ? '无' : selectedNode?.hazards.map(worldlineLabel).join('、')}</dd></div><div><dt>通行要求</dt><dd>{selectedNode?.permissions.length === 0 ? '公开' : selectedNode?.permissions.map(worldlineLabel).join('、')}</dd></div><div><dt>容量</dt><dd>{selectedNode?.capacity === undefined ? '未限制' : String(selectedNode.capacity)}</dd></div></dl><h4>此刻在这里</h4>{residents.length === 0 ? <p>此刻没有角色停留。</p> : <ul>{residents.map((actor, index) => <li key={actor.actorId}><i>{(actorNames.get(actor.actorId) ?? '角').slice(0, 1)}</i><span><strong>{actorNames.get(actor.actorId) ?? entityName(entities, actor.actorId, index)}</strong><small>{placeName(spatial, actor.nodeId)}</small></span></li>)}</ul>}<small className={css.dragHint}>按住空白处拖动地图 · 滚动查看更多区域</small></aside>
    </div>
  </div>
}

interface MapWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly projects: ProjectClient
  readonly runs?: RunsClient
  readonly runRevision?: number
  readonly openAuthoring?: () => void
}

/** Current project map surface: native place documents for authoring, frozen map for observation. */
export function MapWorkbench(props: MapWorkbenchProps) {
  const [mode, setMode] = useState<'compose' | 'observe'>('observe')
  return <div className={css.mapHub}><nav><div><strong>世界地图</strong><span>默认展示当前已生成的完整地图、地点档案、通路与实时居民。</span></div><section><button type="button" data-active={mode === 'observe' || undefined} disabled={props.runs === undefined} onClick={() => { setMode('observe') }}>地图总览</button><button type="button" data-active={mode === 'compose' || undefined} onClick={() => { setMode('compose') }}>编排布局</button></section></nav><div>{mode === 'compose' ? <LocationMapComposer project={props.project} projects={props.projects} openAuthoring={props.openAuthoring ?? (() => {})} /> : props.runs === undefined ? null : <RuntimeWorldAtlas project={props.project} runs={props.runs} {...(props.runRevision === undefined ? {} : { runRevision: props.runRevision })} />}</div></div>
}
