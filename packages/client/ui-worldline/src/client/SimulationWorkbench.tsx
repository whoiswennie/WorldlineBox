/* oxlint-disable @stylistic/max-len -- JSX keeps dense runtime controls structurally visible. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { CheckpointView, RunEventExplanation, RunRecordsPage, RunSpatialView, RunSummary, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { AiBudgetStatus, WorldlineAiCatalog } from '@deepseek-ai/dsh-worldline-ai/types'
import type { ContextPack, EntityId, JsonObject, JsonValue, MapId, ModelPurpose } from '@deepseek-ai/dsh-worldline-standard/types'
import type { AiClient, RunsClient } from './types.ts'
import { useWorldlineEntrance } from './motion.ts'
import css from './SimulationWorkbench.module.css'

interface SimulationWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly runs: RunsClient
  readonly ai: AiClient
  readonly runRevision: number
  readonly onRunsChanged: () => void
  readonly onOpenTextPlay: (runId: RunSummary['runId'], actorId?: EntityId) => void
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function entityIds(view: RunView | undefined): EntityId[] {
  const entities = record(view?.snapshot.state['entities'])
  return Object.keys(entities ?? {}) as EntityId[]
}

function shortId(value: string): string { return value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value }

function SpatialMap({ spatial, selectedActor }: {
  readonly spatial: RunSpatialView
  readonly selectedActor?: EntityId | undefined
}) {
  const map = spatial.map
  if (map === undefined || map.nodes.length === 0) return <div className={css.mapEmpty}>No map projection</div>
  const xs = map.nodes.map(node => node.position.x)
  const ys = map.nodes.map(node => node.position.y)
  const minX = Math.min(...xs); const maxX = Math.max(...xs)
  const minY = Math.min(...ys); const maxY = Math.max(...ys)
  const point = (nodeId: string): { x: number; y: number } | undefined => {
    const node = map.nodes.find(item => item.id === nodeId)
    if (node === undefined) return undefined
    return {
      x: 42 + (node.position.x - minX) / Math.max(1, maxX - minX) * 636,
      y: 36 + (node.position.y - minY) / Math.max(1, maxY - minY) * 232,
    }
  }
  return <svg className={css.runtimeMap} viewBox="0 0 720 304" role="img" aria-label={map.name}>
    <defs><pattern id="run-grid" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" /></pattern></defs>
    <rect width="720" height="304" fill="url(#run-grid)" />
    {map.edges.map((edge) => {
      const from = point(edge.from); const to = point(edge.to)
      return from === undefined || to === undefined ? null : <line key={edge.id} className={css.mapEdge} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
    })}
    {spatial.movements.map((movement) => {
      const route = movement.route.map(point).filter((item): item is { x: number; y: number } => item !== undefined)
      return route.length < 2 ? null : <polyline key={movement.processId} className={css.mapRoute} points={route.map(item => `${String(item.x)},${String(item.y)}`).join(' ')} />
    })}
    {map.nodes.map((node) => {
      const position = point(node.id)
      if (position === undefined) return null
      return <g key={node.id} className={css.mapNode} transform={`translate(${String(position.x)} ${String(position.y)})`}><circle r="16" /><text y="30" textAnchor="middle">{node.name}</text></g>
    })}
    {spatial.actors.map((actor) => {
      const movement = spatial.movements.find(item => item.actorId === actor.actorId)
      const current = movement === undefined ? point(actor.nodeId) : point(movement.route[movement.edgeIndex] ?? actor.nodeId)
      const next = movement === undefined ? undefined : point(movement.route[movement.edgeIndex + 1] ?? actor.nodeId)
      if (current === undefined) return null
      const progress = movement?.edgeFraction ?? 0
      const x = next === undefined ? current.x : current.x + (next.x - current.x) * progress
      const y = next === undefined ? current.y : current.y + (next.y - current.y) * progress
      return <g key={actor.actorId} className={css.actorMarker} data-selected={actor.actorId === selectedActor || undefined} transform={`translate(${String(x)} ${String(y)})`}><circle r="8" /><text x="11" y="4">{shortId(actor.actorId)}</text></g>
    })}
  </svg>
}

export function SimulationWorkbench(props: SimulationWorkbenchProps) {
  const [summaries, setSummaries] = useState<readonly RunSummary[]>([])
  const [selectedId, setSelectedId] = useState<RunSummary['runId']>()
  const [view, setView] = useState<RunView>()
  const [records, setRecords] = useState<RunRecordsPage>()
  const [spatial, setSpatial] = useState<RunSpatialView>()
  const [selectedMapId, setSelectedMapId] = useState<MapId>()
  const [checkpoints, setCheckpoints] = useState<readonly CheckpointView[]>([])
  const [explanation, setExplanation] = useState<RunEventExplanation>()
  const [stream, setStream] = useState<RunRecordsPage['records'][number]['stream'] | undefined>()
  const [selectedActor, setSelectedActor] = useState<EntityId>()
  const [catalog, setCatalog] = useState<WorldlineAiCatalog>()
  const [contextPack, setContextPack] = useState<ContextPack>()
  const [budget, setBudget] = useState<AiBudgetStatus>()
  const [seed, setSeed] = useState('worldline-seed')
  const [startPaused, setStartPaused] = useState(true)
  const [advanceBy, setAdvanceBy] = useState(60)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [modelPurpose, setModelPurpose] = useState<ModelPurpose>('character')
  const [modelKey, setModelKey] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const motionRoot = useRef<HTMLDivElement>(null)
  const projectId = props.project.manifest.id
  useWorldlineEntrance(motionRoot, [selectedId])

  const loadList = useCallback(async (): Promise<void> => {
    const all = await props.runs.list()
    const filtered = all.filter(run => run.projectId === projectId)
    setSummaries(filtered)
    setSelectedId(current => current !== undefined && filtered.some(run => run.runId === current)
      ? current : filtered[0]?.runId)
  }, [projectId, props.runs])

  const refresh = useCallback(async (runId = selectedId): Promise<void> => {
    if (runId === undefined) { setView(undefined); setRecords(undefined); setSpatial(undefined); setCheckpoints([]); return }
    const [nextView, nextRecords, nextCheckpoints, nextSpatial] = await Promise.all([
      props.runs.view({ runId }),
      props.runs.records({ runId, limit: 200, ...(stream === undefined ? {} : { stream }) }),
      props.runs.checkpoints({ runId }),
      props.runs.spatial({ runId, ...(selectedMapId === undefined ? {} : { mapId: selectedMapId }), maxNodes: 1_500 }),
    ])
    setView(nextView)
    setRecords(nextRecords)
    setCheckpoints(nextCheckpoints)
    setSpatial(nextSpatial)
    setSelectedMapId(current => current !== undefined
      && nextSpatial.availableMaps.some(map => map.id === current) ? current : nextSpatial.availableMaps[0]?.id)
    const actors = entityIds(nextView)
    setSelectedActor(current => current !== undefined && actors.includes(current) ? current : actors[0])
  }, [props.runs, selectedId, selectedMapId, stream])

  useEffect(() => { void loadList().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [loadList, props.runRevision])
  useEffect(() => { void refresh().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [refresh])
  useEffect(() => { void props.ai.catalog().then(setCatalog).catch(() => {}) }, [props.ai])

  const mutate = async (key: string, operation: () => Promise<RunSummary['runId'] | void>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { const nextRunId = await operation(); await loadList(); await refresh(nextRunId ?? selectedId) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(undefined) }
  }

  const actors = entityIds(view)
  const selectedEntity = record(record(view?.snapshot.state['entities'])?.[selectedActor ?? ''])
  const model = catalog?.models.find(item => `${item.provider}/${item.id}` === modelKey)
  const usage = view?.aiUsage

  return <div ref={motionRoot} className={css.workbench}>
    <aside className={css.runList} data-worldline-reveal>
      <header><div><span>WORKER RUNTIME</span><h2>{props.t('runs')}</h2></div><button type="button" onClick={() => { void loadList() }}>↻</button></header>
      <div className={css.newRun}>
        <label>{props.t('seed')}<input value={seed} onChange={(event) => { setSeed(event.target.value) }} /></label>
        <label className={css.check}><input type="checkbox" checked={startPaused} onChange={(event) => { setStartPaused(event.target.checked) }} />{props.t('startPaused')}</label>
        <button type="button" disabled={busy !== undefined} onClick={() => { void mutate('create', async () => {
          const created = await props.runs.create({ projectId, seed: seed || 'worldline-seed', startPaused })
          setSelectedId(created.summary.runId)
          props.onRunsChanged()
          return created.summary.runId
        }) }}>{props.t('newRun')}</button>
      </div>
      <ul>{summaries.map(run => <li key={run.runId}><button type="button" data-active={selectedId === run.runId || undefined} onClick={() => { setSelectedId(run.runId) }}>
        <span data-status={run.status} /><strong>{shortId(run.runId)}</strong><small>{run.status} · t={run.logicalTime.toLocaleString()}</small>
      </button></li>)}</ul>
    </aside>

    <main className={css.main} data-worldline-hero>
      {view === undefined ? <div className={css.empty}><span>◉</span><h2>{props.t('simulation')}</h2><p>{props.t('newRun')}</p></div> : <>
        <header className={css.controlBar}>
          <div><strong>{shortId(view.summary.runId)}</strong><small>{view.summary.status} · {view.summary.blueprintDigest.slice(0, 12)}</small></div>
          <div>
            <button type="button" disabled={busy !== undefined || view.summary.status === 'paused'} onClick={() => { void mutate('pause', async () => { await props.runs.pause({ runId: view.summary.runId }) }) }}>{props.t('pause')}</button>
            <button type="button" disabled={busy !== undefined || view.summary.status === 'running'} onClick={() => { void mutate('resume', async () => { await props.runs.resume({ runId: view.summary.runId }) }) }}>{props.t('resume')}</button>
            <input aria-label={props.t('advance')} type="number" min="0.001" value={advanceBy} onChange={(event) => { setAdvanceBy(Number(event.target.value)) }} />
            <button type="button" disabled={busy !== undefined} onClick={() => { void mutate('advance', async () => { await props.runs.advance({ runId: view.summary.runId, duration: advanceBy, maxEvents: 10_000 }) }) }}>{props.t('advance')}</button>
            <button type="button" disabled={busy !== undefined} onClick={() => { void mutate('checkpoint', async () => { await props.runs.checkpoint({ runId: view.summary.runId, label: `t=${String(view.snapshot.logicalTime)}` }) }) }}>{props.t('checkpoint')}</button>
            <button type="button" data-danger disabled={busy !== undefined || view.summary.status === 'stopped'} onClick={() => { void mutate('stop', async () => { await props.runs.stop({ runId: view.summary.runId }) }) }}>{props.t('stop')}</button>
          </div>
        </header>
        {error !== undefined && <div className={css.error} role="alert">{props.t('error')}: {error}</div>}
        <section className={css.metrics} data-worldline-stagger>
          <div><small>{props.t('logicalTime')}</small><strong>{view.snapshot.logicalTime.toLocaleString()}</strong></div>
          <div><small>{props.t('sequence')}</small><strong>{view.snapshot.sequence.toLocaleString()}</strong></div>
          <div><small>{props.t('queue')}</small><strong>{view.health.futureQueueDepth}</strong></div>
          <div><small>{props.t('processes')}</small><strong>{view.health.activeProcesses}<i> / {view.health.waitingProcesses}</i></strong></div>
          <div><small>{props.t('reservations')}</small><strong>{view.health.reservations}</strong></div>
          <div><small>{props.t('fairness')}</small><strong>{view.health.fairnessInterventions}</strong></div>
          <div><small>{props.t('deadlocks')}</small><strong>{view.health.deadlocksResolved}</strong></div>
          <div><small>{props.t('livelocks')}</small><strong>{view.health.livelocksResolved}</strong></div>
        </section>
        <div className={css.contentGrid} data-worldline-stagger>
          {spatial !== undefined && <section className={`${css.panel} ${css.spatialPanel}`}>
            <header><div><h3>{props.t('runtimeMap')}</h3><small>{spatial.map === undefined ? '—' : `${String(spatial.map.nodes.length)}/${String(spatial.map.totalNodes)} ${props.t('visibleNodes')}`}</small></div><select value={selectedMapId ?? ''} onChange={(event) => { setSelectedMapId(event.target.value as MapId) }}>{spatial.availableMaps.map(map => <option key={map.id} value={map.id}>{map.name} · {map.nodeCount}</option>)}</select></header>
            <SpatialMap spatial={spatial} selectedActor={selectedActor} />
            {spatial.map?.truncated === true && <p className={css.mapNotice}>{props.t('mapProjectionClipped')}</p>}
            <ul className={css.movementList}>{spatial.movements.map(item => <li key={item.processId}><strong>{shortId(item.actorId)}</strong><span>{item.origin} → {item.destination}</span><small>{item.mode} · {Math.round(item.edgeFraction * 100)}% · {item.remainingDuration.toLocaleString()} {props.t('remaining')}</small></li>)}</ul>
          </section>}
          <section className={css.panel}>
            <header><h3>{props.t('entities')}</h3><select value={selectedActor ?? ''} onChange={(event) => { setSelectedActor(event.target.value as EntityId) }}>{actors.map(id => <option key={id}>{id}</option>)}</select></header>
            <pre>{JSON.stringify(selectedEntity ?? {}, null, 2)}</pre>
            {selectedActor !== undefined && <div className={css.actorActions}>
              <select value={view.controls[selectedActor] ?? 'autonomous'} onChange={(event) => { void mutate('control', async () => { await props.runs.setControl({ runId: view.summary.runId, actorId: selectedActor, mode: event.target.value as 'autonomous' | 'suggestions' | 'player' }) }) }}>
                <option value="autonomous">autonomous</option><option value="suggestions">suggestions</option><option value="player">player</option>
              </select>
              <button type="button" onClick={() => { props.onOpenTextPlay(view.summary.runId, selectedActor) }}>{props.t('textPlay')}</button>
            </div>}
          </section>
          <section className={css.panel}>
            <header><h3>{props.t('processes')} / {props.t('reservations')}</h3></header>
            <pre>{JSON.stringify({ processes: view.snapshot.processes, reservations: view.snapshot.reservations }, null, 2)}</pre>
          </section>
          <section className={`${css.panel} ${css.events}`}>
            <header><h3>{props.t('events')}</h3><select value={stream ?? ''} onChange={(event) => { setStream(event.target.value === '' ? undefined : event.target.value as typeof stream) }}>
              <option value="">all streams</option>{['world-event', 'decision-trace', 'ai-intent', 'ai-invocation', 'observation', 'narrative-beat', 'telemetry'].map(value => <option key={value}>{value}</option>)}
            </select></header>
            <ol>{records?.records.map(item => <li key={`${String(item.sequence)}:${String(item.ordinal ?? 0)}:${item.stream}:${item.id}`}>
              <div><span>{item.stream}</span><strong>#{item.sequence}</strong><small>t={item.logicalTime}</small><button type="button" disabled={busy !== undefined} onClick={() => { void mutate(`explain:${item.id}`, async () => { setExplanation(await props.runs.explain({ runId: view.summary.runId, eventId: item.id })) }) }}>{props.t('explain')}</button></div><pre>{JSON.stringify(item.payload, null, 2)}</pre>
            </li>)}</ol>
            {explanation !== undefined && <div className={css.explanation}><header><strong>{props.t('causalExplanation')}</strong><button type="button" onClick={() => { setExplanation(undefined) }}>×</button></header><p>{explanation.summary}</p><pre>{JSON.stringify({ event: explanation.event, decisions: explanation.decisions, processes: explanation.processes, reservations: explanation.reservations, telemetry: explanation.telemetry }, null, 2)}</pre></div>}
          </section>
          <section className={`${css.panel} ${css.checkpoints}`}>
            <header><h3>{props.t('checkpoints')}</h3><small>{checkpoints.length}</small></header>
            <ol>{checkpoints.map(item => <li key={item.checkpoint.id}><div><strong>{item.label}</strong><small>#{item.checkpoint.sequence} · t={item.checkpoint.snapshot.logicalTime}</small></div><button type="button" disabled={busy !== undefined} onClick={() => { void mutate(`branch:${item.checkpoint.id}`, async () => {
              const branch = await props.runs.branch({ runId: view.summary.runId, checkpointId: item.checkpoint.id })
              setSelectedId(branch.summary.runId); props.onRunsChanged(); return branch.summary.runId
            }) }}>{props.t('replayBranch')}</button></li>)}</ol>
          </section>
          <section className={`${css.panel} ${css.aiPanel}`}>
            <header><h3>{props.t('ai')}</h3><button type="button" data-enabled={view.snapshot.modelPolicy.aiEnabled || undefined} onClick={() => { void mutate('ai-toggle', async () => { await props.runs.setAiEnabled({ runId: view.summary.runId, enabled: !view.snapshot.modelPolicy.aiEnabled }) }) }}>{view.snapshot.modelPolicy.aiEnabled ? props.t('aiEnabled') : props.t('aiDisabled')}</button></header>
            <div className={css.usage}>
              <span>Calls <strong>{usage?.calls ?? 0}</strong></span><span>Input <strong>{usage?.inputTokens.toLocaleString() ?? 0}</strong></span><span>Output <strong>{usage?.outputTokens.toLocaleString() ?? 0}</strong></span><span>Cost <strong>{usage?.estimatedCost.toFixed(4) ?? '0'}</strong></span>
            </div>
            <div className={css.modelForm}>
              <select value={modelPurpose} onChange={(event) => { setModelPurpose(event.target.value as ModelPurpose) }}>{['character', 'narrator', 'summary', 'creative', 'compiler'].map(value => <option key={value}>{value}</option>)}</select>
              <select value={modelKey} onChange={(event) => { setModelKey(event.target.value); setReasoningEffort('') }}><option value="">{props.t('modelCatalog')}</option>{catalog?.models.map(item => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.provider} / {item.name}</option>)}</select>
              <select value={reasoningEffort} disabled={model === undefined || model.reasoningEfforts.length === 0} onChange={(event) => { setReasoningEffort(event.target.value) }}><option value="">{props.t('defaultReasoning')}</option>{model?.reasoningEfforts.map(value => <option key={value}>{value}</option>)}</select>
              <button type="button" disabled={model === undefined} onClick={() => {
                if (model === undefined) return
                void mutate('model', async () => { await props.runs.switchModel({
                  runId: view.summary.runId,
                  expectedSequence: view.snapshot.sequence,
                  modelPolicy: { ...view.snapshot.modelPolicy, routes: { ...view.snapshot.modelPolicy.routes, [modelPurpose]: { provider: model.provider, model: model.id, ...(reasoningEffort === '' ? {} : { reasoningEffort }) } } },
                }) })
              }}>{props.t('modelRoute')}</button>
            </div>
            {selectedActor !== undefined && <div className={css.aiActions}>
              <button type="button" onClick={() => { void mutate('budget', async () => { setBudget(await props.ai.budget({ runId: view.summary.runId, actorId: selectedActor })) }) }}>{props.t('budget')}</button>
              <button type="button" onClick={() => { void mutate('context', async () => { setContextPack(await props.ai.contextPack({ runId: view.summary.runId, actorId: selectedActor })) }) }}>{props.t('context')}</button>
              <button type="button" onClick={() => { void mutate('decide', async () => { await props.ai.decide({ runId: view.summary.runId, actorId: selectedActor }) }) }}>{props.t('decide')}</button>
            </div>}
            {budget !== undefined && <div className={css.budgetStatus} data-allowed={budget.allowed || undefined}><strong>{budget.allowed ? props.t('budgetAvailable') : props.t('budgetBlocked')}</strong><span>{budget.callsRemaining} calls · {budget.inputTokensRemaining.toLocaleString()} input · {budget.outputTokensRemaining.toLocaleString()} output · {budget.estimatedCostRemaining.toFixed(4)} remaining</span>{budget.reasons.map(reason => <small key={reason}>{reason}</small>)}</div>}
            {contextPack !== undefined && <details open><summary>{props.t('context')} · {contextPack.totalTokens}/{contextPack.inputLimit}</summary><pre>{JSON.stringify(contextPack, null, 2)}</pre></details>}
          </section>
        </div>
      </>}
    </main>
  </div>
}
