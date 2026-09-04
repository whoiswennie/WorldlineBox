/* eslint-disable @stylistic/max-len */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, SVGProps } from 'react'
import type { DocumentView, ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { ProjectClient } from './types.ts'
import { ArtworkImage } from './ArtworkImage.tsx'
import { DEFAULT_ARTWORK, DEFAULT_MAP_ARTWORK } from './default-artwork.ts'
import { locationConnection, locationDraft, locationMarkdown, type NativeLocationDraft } from './nativeOc.ts'
import { gameDuration, projectMediaUrl, worldlineLabel } from './presentation.ts'
import css from './LocationMapComposer.module.css'

type LocationEntry = { readonly document: DocumentView; readonly draft: NativeLocationDraft }

function SvgArtwork({ sources: candidates, ...props }: SVGProps<SVGImageElement> & { readonly sources: readonly (string | undefined)[] }) {
  const sources = [...new Set(candidates.filter((source): source is string => source !== undefined && source !== ''))]
  const signature = sources.join('\u0000')
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0) }, [signature])
  const source = sources[index]
  if (source === undefined) return null
  return <image {...props} href={source} onError={() => { setIndex(current => current + 1) }} />
}

export function LocationMapComposer({ project, projects, openAuthoring }: { readonly project: ProjectSummary; readonly projects: ProjectClient; readonly openAuthoring: () => void }) {
  const [entries, setEntries] = useState<readonly LocationEntry[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState<string>()
  const [routeTarget, setRouteTarget] = useState('')
  const [routeDuration, setRouteDuration] = useState(10)
  const scroller = useRef<HTMLDivElement>(null)
  const pan = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>()
  const drag = useRef<{ pointerId: number; id: string; x: number; y: number; startX: number; startY: number }>()

  const load = useCallback(async (): Promise<void> => {
    try {
      const listing = await projects.tree({ projectId: project.manifest.id, path: 'maps/places', limit: 1_000 })
      const documents = await Promise.all(listing.entries.filter(item => item.kind === 'document' && item.path.endsWith('.md')).map(item => projects.read({ projectId: project.manifest.id, path: item.path })))
      setEntries(documents.map(document => ({ document, draft: locationDraft(document) })))
      const first = documents[0]
      setSelectedId(current => current !== undefined && documents.some(document => locationDraft(document).id === current) ? current : first === undefined ? undefined : locationDraft(first).id)
      setError(undefined)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(/(?:ENOENT|not found|no such file or directory)/iu.test(message) ? undefined : '地点档案暂时无法读取，请稍后重新载入。')
      setEntries([])
    }
  }, [project.manifest.id, projects])

  useEffect(() => { void load() }, [load])
  const selected = entries.find(entry => entry.draft.id === selectedId)
  const nodeIds = useMemo(() => new Set(entries.map(entry => entry.draft.id)), [entries])
  const issues = useMemo(() => {
    const found: string[] = []
    if (nodeIds.size !== entries.length) found.push('地点稳定 ID 存在重复。')
    for (const entry of entries) {
      if (entry.draft.parentId !== '' && !nodeIds.has(entry.draft.parentId)) found.push(`${entry.draft.name} 的上级地点不存在。`)
      for (const raw of entry.draft.connections.split(/\r?\n/gu)) {
        const connection = locationConnection(raw)
        if (connection !== undefined && !nodeIds.has(connection.targetId)) found.push(`${entry.draft.name} 连接了不存在的地点。`)
      }
    }
    return found
  }, [entries, nodeIds])

  const saveEntry = async (entry: LocationEntry, nextDraft: NativeLocationDraft): Promise<void> => {
    setSaving(nextDraft.id); setError(undefined)
    try {
      const saved = await projects.write({ projectId: project.manifest.id, path: entry.document.path, content: locationMarkdown(nextDraft), expectedRevision: entry.document.revision, documentId: entry.document.id, objectKind: 'place', tags: entry.document.tags, createParents: true })
      setEntries(current => current.map(item => item.draft.id === nextDraft.id ? { document: saved, draft: locationDraft(saved) } : item))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); await load() }
    finally { setSaving(undefined) }
  }

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest('[data-location-node]') !== null) return
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault()
  }
  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = pan.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    event.currentTarget.scrollLeft = state.left - (event.clientX - state.x)
    event.currentTarget.scrollTop = state.top - (event.clientY - state.y)
  }
  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => { if (pan.current?.pointerId === event.pointerId) pan.current = undefined }
  const beginDrag = (event: ReactPointerEvent<SVGGElement>, entry: LocationEntry): void => {
    if (event.button !== 0) return
    drag.current = { pointerId: event.pointerId, id: entry.draft.id, x: event.clientX, y: event.clientY, startX: entry.draft.x, startY: entry.draft.y }
    event.currentTarget.setPointerCapture(event.pointerId); setSelectedId(entry.draft.id); event.stopPropagation()
  }
  const moveDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    const state = drag.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    const x = Math.round(state.startX + (event.clientX - state.x) / zoom)
    const y = Math.round(state.startY + (event.clientY - state.y) / zoom)
    setEntries(current => current.map(item => item.draft.id === state.id ? { ...item, draft: { ...item.draft, x, y } } : item))
  }
  const endDrag = (event: ReactPointerEvent<SVGGElement>): void => {
    const state = drag.current
    if (state === undefined || state.pointerId !== event.pointerId) return
    drag.current = undefined
    const entry = entries.find(item => item.draft.id === state.id)
    if (entry !== undefined) void saveEntry(entry, entry.draft)
  }

  if (entries.length === 0) return <div className={css.empty}><ArtworkImage sources={[DEFAULT_MAP_ARTWORK]} alt="默认世界地图" /><span>WORLD MAP COMPOSER</span><h2>先定义地点，再组装世界</h2><p>地点不应该在地图里临时捏造。请先在“创作设定 → 地点”中建立地点档案，然后回到这里拖拽编排。</p><button type="button" data-primary onClick={openAuthoring}>去创建地点</button>{error !== undefined && <small>{error}</small>}</div>
  return <div className={css.composer}>
    <header><div><span>NODE WORLD COMPOSER</span><h2>地点节点编排</h2><p>{entries.length} 个地点 · {issues.length === 0 ? '地图结构有效' : `${issues.length} 项需要处理`}</p></div><section><button type="button" onClick={openAuthoring}>管理地点档案</button><button type="button" onClick={() => { void load() }}>重新载入</button><label>缩放 <input type="range" min="0.55" max="1.65" step="0.05" value={zoom} onChange={(event) => { setZoom(Number(event.target.value)) }} /></label></section></header>
    <main>
      <div ref={scroller} className={css.canvasScroller} data-panning={pan.current !== undefined || undefined} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan}>
        <svg width={1800 * zoom} height={1100 * zoom} viewBox="0 0 1800 1100" role="img" aria-label="地点节点式世界地图"><defs><pattern id="native-location-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" /></pattern></defs><rect width="100%" height="100%" fill="url(#native-location-grid)" />
          {entries.flatMap(entry => entry.draft.connections.split(/\r?\n/gu).flatMap((raw) => { const connection = locationConnection(raw); const target = entries.find(item => item.draft.id === connection?.targetId); return connection === undefined || target === undefined ? [] : [{ entry, target, connection }] })).map(({ entry, target, connection }) => <g key={`${entry.draft.id}:${target.draft.id}`} className={css.edge}><line x1={entry.draft.x} y1={entry.draft.y} x2={target.draft.x} y2={target.draft.y} /><text x={(entry.draft.x + target.draft.x) / 2} y={(entry.draft.y + target.draft.y) / 2 - 7} textAnchor="middle">{gameDuration(connection.duration)}</text></g>)}
          {entries.map((entry) => {
            const image = projectMediaUrl(project.manifest.id, entry.draft.background) ?? DEFAULT_ARTWORK.place
            const clipId = `clip-${entry.document.id.replace(/[^a-z0-9]/giu, '')}`
            return <g
              key={entry.draft.id}
              data-location-node
              className={css.node}
              data-selected={entry.draft.id === selectedId || undefined}
              transform={`translate(${String(entry.draft.x)} ${String(entry.draft.y)})`}
              onPointerDown={(event) => { beginDrag(event, entry) }}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="button"
              tabIndex={0}
            >
              <circle r="42" fill="#edf7f1" stroke="#6da98f" />
              <defs><clipPath id={clipId}><circle r="39" /></clipPath></defs>
              <SvgArtwork
                sources={[image, DEFAULT_ARTWORK.place]}
                x="-39"
                y="-39"
                width="78"
                height="78"
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#${clipId})`}
              />
              <circle r="42" fill="none" stroke="#6da98f" />
              <text y="63" textAnchor="middle">{entry.draft.name}</text>
              <text y="79" textAnchor="middle">{worldlineLabel(entry.draft.kind)}</text>
              {saving === entry.draft.id && <text y="96" textAnchor="middle">保存中…</text>}
            </g>
          })}
        </svg>
      </div>
      <aside><span>PLACE ARCHIVE</span><h3>{selected?.draft.name ?? '选择地点'}</h3>{selected !== undefined && <><p>{selected.draft.summary}</p><dl><div><dt>类型</dt><dd>{worldlineLabel(selected.draft.kind)}</dd></div><div><dt>坐标</dt><dd>{Math.round(selected.draft.x)}, {Math.round(selected.draft.y)}</dd></div><div><dt>上级</dt><dd>{entries.find(item => item.draft.id === selected.draft.parentId)?.draft.name ?? '—'}</dd></div></dl><h4>添加通路</h4><select value={routeTarget} onChange={(event) => { setRouteTarget(event.target.value) }}><option value="">选择目标地点</option>{entries.filter(item => item.draft.id !== selected.draft.id).map(item => <option key={item.draft.id} value={item.draft.id}>{item.draft.name}</option>)}</select><label>游戏内路程（分钟）<input type="number" min="1" value={routeDuration} onChange={(event) => { setRouteDuration(Number(event.target.value)) }} /></label><button type="button" disabled={routeTarget === ''} onClick={() => { const connection = `${routeTarget}|${String(routeDuration)}`; const next = { ...selected.draft, connections: [...selected.draft.connections.split(/\r?\n/gu).filter(Boolean), connection].join('\n') }; setEntries(current => current.map(item => item.draft.id === next.id ? { ...item, draft: next } : item)); setRouteTarget(''); void saveEntry(selected, next) }}>连接地点</button></>}
        <section data-valid={issues.length === 0 || undefined}><strong>{issues.length === 0 ? '地图结构有效' : '地图需要修正'}</strong>{issues.map(issue => <p key={issue}>{issue}</p>)}</section>{error !== undefined && <p className={css.error}>{error}</p>}<small>按住空白处拖动画布 · 拖动地点改变位置 · 坐标会自动写回地点档案</small></aside>
    </main>
  </div>
}
