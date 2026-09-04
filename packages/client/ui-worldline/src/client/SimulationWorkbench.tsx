/* eslint-disable @stylistic/max-len */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { RunChoicesView, RunDefinitionView, RunRecordsPage, RunSpatialView, RunSummary, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { EntityId, JsonObject, JsonValue } from '@deepseek-ai/dsh-worldline-standard/types'
import {
  characterFacts,
  entityName,
  gameCalendar,
  gameDuration,
  newWorldlineSeed,
  placeName,
  snapshotEntities,
  worldlineLabel,
} from './presentation.ts'
import type { AiClient, RunsClient } from './types.ts'
import css from './SimulationWorkbench.module.css'

interface SimulationWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly runs: RunsClient
  readonly ai: AiClient
  readonly runRevision: number
  readonly onRunsChanged: () => void
  readonly onOpenTextPlay: (runId: RunSummary['runId'], actorId?: EntityId) => void
  readonly onImportRun: () => void
  readonly onExportRun: (runId: RunSummary['runId']) => void
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function actorIds(view: RunView | undefined, definition: RunDefinitionView | undefined): EntityId[] {
  const all = Object.keys(snapshotEntities(view?.snapshot) ?? {}) as EntityId[]
  const types = new Map(definition?.entities.map(entity => [entity.id, entity.type]) ?? [])
  const actors = all.filter(id => ['character', 'person', 'npc', 'actor'].includes(types.get(id) ?? ''))
  return actors.length === 0 ? all : actors
}

function actionLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    'farm.plant': '播种', 'farm.water': '浇水', 'farm.harvest': '收获', 'farm.sleep': '休息',
    'character.move': '前往相邻地点', 'character.talk': '与人交谈', 'character.work': '完成工作',
    'social.talk': '与人交谈', 'social.gift': '赠送礼物', 'world.clock': '世界时钟',
  }
  return labels[value] ?? worldlineLabel(value)
}

export function eventTitle(item: RunRecordsPage['records'][number]): string {
  const payload = item.payload
  const explicit = payload['description'] ?? payload['label'] ?? payload['message']
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const type = payload['actionType'] ?? payload['eventType'] ?? payload['type'] ?? payload['systemId']
  return typeof type === 'string' ? actionLabel(type) : worldlineLabel(item.stream)
}

/** Advance one bounded autonomous turn without borrowing capabilities from any Agent mode. */
export async function runAutonomyCycle(
  runs: RunsClient,
  runId: RunSummary['runId'],
  _definition: RunDefinitionView | undefined,
  duration: number,
): Promise<void> {
  const current = await runs.view({ runId })
  if (current.summary.status !== 'running') return
  await runs.simulate({ runId, cycles: 1, stepDuration: duration })
}

export function LivingMap({ spatial, entities, selectedActor }: {
  readonly spatial: RunSpatialView
  readonly entities: JsonObject | undefined
  readonly selectedActor: EntityId | undefined
}) {
  const map = spatial.map
  if (map === undefined || map.nodes.length === 0) return <div className={css.mapEmpty}>这条世界线还没有可观察的地图。</div>
  const xs = map.nodes.map(node => node.position.x); const ys = map.nodes.map(node => node.position.y)
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys)
  const point = (nodeId: string): { x: number; y: number } | undefined => {
    const node = map.nodes.find(item => item.id === nodeId)
    return node === undefined ? undefined : {
      x: 58 + (node.position.x - minX) / Math.max(1, maxX - minX) * 764,
      y: 48 + (node.position.y - minY) / Math.max(1, maxY - minY) * 274,
    }
  }
  return <svg className={css.runtimeMap} viewBox="0 0 880 370" role="img" aria-label={map.name}>
    <defs><pattern id="living-grid" width="30" height="30" patternUnits="userSpaceOnUse">
      <path d="M30 0H0V30" />
    </pattern></defs>
    <rect width="880" height="370" fill="url(#living-grid)" />
    {map.edges.map((edge) => {
      const from = point(edge.from)
      const to = point(edge.to)
      return from === undefined || to === undefined
        ? null
        : <line key={edge.id} className={css.mapEdge}
          x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
    })}
    {spatial.movements.map((movement) => {
      const route = movement.route.map(point)
        .filter((item): item is { x: number; y: number } => item !== undefined)
      return route.length < 2
        ? null
        : <polyline key={movement.processId} className={css.mapRoute}
          points={route.map(item => `${String(item.x)},${String(item.y)}`).join(' ')} />
    })}
    {map.nodes.map((node) => {
      const position = point(node.id)
      if (position === undefined) return null
      return <g key={node.id} className={css.mapNode}
        transform={`translate(${String(position.x)} ${String(position.y)})`}>
        <circle r="23" /><text y="43" textAnchor="middle">{node.name}</text>
      </g>
    })}
    {spatial.actors.map((actor, index) => {
      const movement = spatial.movements.find(item => item.actorId === actor.actorId)
      const current = point(movement === undefined
        ? actor.nodeId
        : movement.route[movement.edgeIndex] ?? actor.nodeId)
      const next = point(movement === undefined
        ? actor.nodeId
        : movement.route[movement.edgeIndex + 1] ?? actor.nodeId)
      if (current === undefined) return null
      const progress = movement?.edgeFraction ?? 0
      const x = next === undefined ? current.x : current.x + (next.x - current.x) * progress
      const y = next === undefined ? current.y : current.y + (next.y - current.y) * progress
      return <g key={actor.actorId} className={css.actorMarker}
        data-selected={actor.actorId === selectedActor || undefined}
        transform={`translate(${String(x)} ${String(y)})`}>
        <circle r="9" /><text x="14" y="4">{entityName(entities, actor.actorId, index)}</text>
      </g>
    })}
  </svg>
}

export function SimulationWorkbench(props: SimulationWorkbenchProps) {
  const [summaries, setSummaries] = useState<readonly RunSummary[]>([])
  const [selectedId, setSelectedId] = useState<RunSummary['runId']>()
  const [view, setView] = useState<RunView>()
  const [definition, setDefinition] = useState<RunDefinitionView>()
  const [spatial, setSpatial] = useState<RunSpatialView>()
  const [records, setRecords] = useState<RunRecordsPage>()
  const [choices, setChoices] = useState<RunChoicesView>()
  const [selectedActor, setSelectedActor] = useState<EntityId>()
  const [selectedChoiceId, setSelectedChoiceId] = useState<string>()
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [advanceBy, setAdvanceBy] = useState(600)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const activeSelectedIdRef = useRef(selectedId)
  const refreshRequestRef = useRef(0)
  const projectId = props.project.manifest.id
  activeSelectedIdRef.current = selectedId
  const orderedSummaries = useMemo(() => [...summaries].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId)
  )), [summaries])

  const loadList = useCallback(async (): Promise<void> => {
    const next = (await props.runs.list()).filter(item => item.projectId === projectId)
    setSummaries(next)
    setSelectedId((current) => {
      const selected = current !== undefined && next.some(item => item.runId === current)
        ? current : next[0]?.runId
      activeSelectedIdRef.current = selected
      return selected
    })
  }, [projectId, props.runs])

  const refresh = useCallback(async (runId = selectedId): Promise<void> => {
    const request = ++refreshRequestRef.current
    if (runId === undefined) { setView(undefined); setDefinition(undefined); setSpatial(undefined); setRecords(undefined); return }
    const [nextView, nextDefinition, nextSpatial, nextRecords] = await Promise.all([
      props.runs.view({ runId }), props.runs.definition({ runId }),
      props.runs.spatial({ runId, maxNodes: 2_000 }), props.runs.records({ runId, limit: 60 }),
    ])
    if (request !== refreshRequestRef.current || activeSelectedIdRef.current !== runId) return
    setView(nextView); setDefinition(nextDefinition); setSpatial(nextSpatial); setRecords(nextRecords)
    const ids = actorIds(nextView, nextDefinition)
    setSelectedActor(current => current !== undefined && ids.includes(current) ? current : ids[0])
  }, [props.runs, selectedId])

  useEffect(() => {
    void loadList().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [loadList, props.runRevision])
  useEffect(() => {
    void refresh().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [refresh])
  useEffect(() => {
    if (selectedId === undefined || selectedActor === undefined) { setChoices(undefined); return }
    void props.runs.choices({ runId: selectedId, actorId: selectedActor }).then((next) => {
      setChoices(next)
      setSelectedChoiceId(current => next.choices.some(item => item.id === current)
        ? current
        : next.choices[0]?.id)
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [props.runs, selectedActor, selectedId, view?.snapshot.sequence])
  useEffect(() => {
    if (!autoAdvance || selectedId === undefined || view?.summary.status !== 'running' || busy !== undefined) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await runAutonomyCycle(props.runs, selectedId, definition, advanceBy)
          if (!cancelled) await refresh(selectedId)
        } catch (reason) {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
        }
      })()
    }, 1_000)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [advanceBy, autoAdvance, busy, definition, props.runs, refresh, selectedId, view?.summary.status, view?.snapshot.sequence])

  const mutate = async (key: string, operation: () => Promise<RunSummary['runId'] | void>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { const next = await operation(); await loadList(); await refresh(next ?? selectedId) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(undefined) }
  }

  const entities = snapshotEntities(view?.snapshot)
  const ids = actorIds(view, definition)
  const names = useMemo(() => new Map(ids.map((id, index) => [id, entityName(entities, id, index)])), [entities, ids])
  const selectedEntity = record(entities?.[selectedActor ?? ''])
  const selectedPosition = spatial?.actors.find(actor => actor.actorId === selectedActor)
  const selectedMovement = spatial?.movements.find(item => item.actorId === selectedActor)
  const selectedChoice = choices?.choices.find(item => item.id === selectedChoiceId)
  const calendar = view === undefined ? undefined : gameCalendar(view.snapshot)
  const recent = records?.records.slice(-12).reverse() ?? []

  return <div className={css.page}>
    <header className={css.header}>
      <div><span>OC LIVING WORLD</span><h2>世界观察台</h2>
        <p>这里展示世界里正在发生的生活，而不是内部调试数据。</p></div>
      {view !== undefined && calendar !== undefined && <div className={css.clock}>
        <small>{calendar.dateLabel}</small><strong>{calendar.timeLabel}</strong>
        <i data-status={view.summary.status}>{worldlineLabel(view.summary.status)}</i>
      </div>}
    </header>
    {error !== undefined && <div className={css.error} role="alert">{error}</div>}
    <div className={css.toolbar}>
      <label>世界线<select value={selectedId ?? ''}
        onChange={(event) => { const next = event.target.value as RunSummary['runId']; activeSelectedIdRef.current = next; setSelectedId(next); setView(undefined); setDefinition(undefined); setSpatial(undefined); setRecords(undefined) }}>
        {orderedSummaries.map((item, index) => <option key={item.runId} value={item.runId}>
          世界线 {String(index + 1)} · {worldlineLabel(item.status)} · {item.runId.slice(-6)}
        </option>)}
      </select></label>
      <button type="button" onClick={props.onImportRun}>导入演算存档</button>
      {view === undefined ? <button type="button" data-primary disabled={busy !== undefined} onClick={() => { void mutate('create', async () => { const created = await props.runs.create({ projectId, seed: newWorldlineSeed(), startPaused: false }); activeSelectedIdRef.current = created.summary.runId; setSelectedId(created.summary.runId); props.onRunsChanged(); return created.summary.runId }) }}>开启世界推演</button> : <>
        <button type="button" disabled={busy !== undefined} onClick={() => { void mutate('status', async () => { if (view.summary.status === 'running') await props.runs.pause({ runId: view.summary.runId }); else await props.runs.resume({ runId: view.summary.runId }) }) }}>{view.summary.status === 'running' ? '暂停世界' : '继续世界'}</button>
        <label>每次流逝<select value={advanceBy} onChange={(event) => { setAdvanceBy(Number(event.target.value)) }}><option value={600}>10 分钟</option><option value={3600}>1 小时</option><option value={21600}>6 小时</option><option value={86400}>1 天</option></select></label>
        <button type="button" disabled={busy !== undefined} onClick={() => { void mutate('advance', async () => { await props.runs.advance({ runId: view.summary.runId, duration: advanceBy, maxEvents: 10_000 }) }) }}>流逝一次</button>
        <label className={css.auto}><input type="checkbox" checked={autoAdvance} onChange={(event) => { setAutoAdvance(event.target.checked) }} />持续自动推演</label>
        <button type="button" data-primary onClick={() => { props.onOpenTextPlay(view.summary.runId, selectedActor) }}>进入视觉演绎</button>
      </>}
    </div>
    {view === undefined || spatial === undefined ? <div className={css.empty}><span>◉</span><h3>这个世界还没有开始流动</h3><p>请先在“创作设定”中通过可运行性检查，然后点击“开启世界推演”。</p></div> : <main className={css.layout}>
      <section className={css.mapPanel}><header><div><span>LIVE MAP</span><h3>此刻的世界</h3></div><small>{spatial.map?.name ?? '世界地图'} · {String(spatial.actors.length)} 位角色可观察</small></header><LivingMap spatial={spatial} entities={entities} selectedActor={selectedActor} />
        {selectedMovement !== undefined && <p className={css.movement}>{names.get(selectedMovement.actorId)}正在从{placeName(spatial, selectedMovement.origin)}前往{placeName(spatial, selectedMovement.destination)}，已完成 {String(Math.round(selectedMovement.edgeFraction * 100))}%，预计还需 {gameDuration(selectedMovement.remainingDuration)}。</p>}
      </section>
      <section className={css.peoplePanel}><header><span>RESIDENTS</span><h3>居民与角色</h3></header><div className={css.people}>{ids.map((id, index) => { const position = spatial.actors.find(actor => actor.actorId === id); return <button type="button" key={id} data-active={id === selectedActor || undefined} onClick={() => { setSelectedActor(id) }}><i>{(names.get(id) ?? '角').slice(0, 1)}</i><span><strong>{names.get(id) ?? entityName(entities, id, index)}</strong><small>{placeName(spatial, position?.nodeId)}</small></span></button> })}</div></section>
      <section className={css.characterPanel}><header><div><span>CHARACTER NOTE</span><h3>{selectedActor === undefined ? '角色档案' : names.get(selectedActor) ?? '角色档案'}</h3></div>{selectedActor !== undefined && <button type="button" onClick={() => { props.onOpenTextPlay(view.summary.runId, selectedActor) }}>以此角色进入视觉演绎</button>}</header><p className={css.location}>现在位于 <strong>{placeName(spatial, selectedPosition?.nodeId)}</strong></p><dl>{characterFacts(selectedEntity).map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl><label>角色控制<select value={selectedActor === undefined ? '' : view.controls[selectedActor] ?? 'autonomous'} onChange={(event) => { if (selectedActor === undefined) return; void mutate('control', async () => { await props.runs.setControl({ runId: view.summary.runId, actorId: selectedActor, mode: event.target.value as 'autonomous' | 'suggestions' | 'player' }) }) }}><option value="autonomous">自主生活</option><option value="suggestions">只接受建议</option><option value="player">由玩家控制</option></select></label></section>
      <section className={css.activityPanel}><header><span>WORLD DIARY</span><h3>世界近况</h3></header>{recent.length === 0 ? <p>世界刚刚开始，第一批生活记录正在形成。</p> : <ol>{recent.map((item, index) => <li key={`${String(item.sequence)}:${item.id}`}><i>{String(recent.length - index).padStart(2, '0')}</i><div><strong>{eventTitle(item)}</strong><small>{gameCalendar({ logicalTime: item.logicalTime, state: view.snapshot.state }).fullLabel} · {worldlineLabel(item.stream)}</small></div></li>)}</ol>}</section>
      <section className={css.choicePanel}><header><div><span>INTERVENE</span><h3>为角色安排下一步</h3></div><small>只能选择当前世界规则允许的行动</small></header><div>{choices?.choices.map(choice => <button type="button" key={choice.id} data-active={choice.id === selectedChoiceId || undefined} onClick={() => { setSelectedChoiceId(choice.id) }}><strong>{actionLabel(choice.actionType) || choice.label}</strong><span>{choice.description}</span><small>约需 {gameDuration(choice.estimatedDuration)}</small></button>)}</div><button type="button" data-primary disabled={selectedActor === undefined || selectedChoice === undefined || busy !== undefined} onClick={() => { if (selectedActor === undefined || selectedChoice === undefined) return; void mutate('submit', async () => { await props.runs.submitAction({ runId: view.summary.runId, actorId: selectedActor, type: selectedChoice.actionType, parameters: selectedChoice.parameters, expectedSequence: view.snapshot.sequence, controller: 'system' }) }) }}>执行这个行动</button></section>
      <details className={css.advanced}><summary>高级设置与运行诊断</summary><div><span>未来事件 {String(view.health.futureQueueDepth)}</span><span>活动进程 {String(view.health.activeProcesses)}</span><span>等待进程 {String(view.health.waitingProcesses)}</span><span>公平调度 {String(view.health.fairnessInterventions)}</span><span>死锁恢复 {String(view.health.deadlocksResolved)}</span><span>活锁恢复 {String(view.health.livelocksResolved)}</span></div><section><h4>世界系统</h4>{definition?.systems.map(item => <p key={item.id}><strong>{actionLabel(item.id)}</strong> — {item.description}</p>)}</section><footer><button type="button" onClick={props.onImportRun}>导入演算存档</button><button type="button" onClick={() => { props.onExportRun(view.summary.runId) }}>导出演算存档</button><button type="button" onClick={() => { void mutate('checkpoint', async () => { if (calendar !== undefined) await props.runs.checkpoint({ runId: view.summary.runId, label: calendar.fullLabel }) }) }}>保存此刻</button><button type="button" data-danger onClick={() => { void mutate('stop', async () => { await props.runs.stop({ runId: view.summary.runId }) }) }}>结束推演</button></footer></details>
    </main>}
  </div>
}
