/* oxlint-disable @stylistic/max-len -- JSX keeps dense runtime controls structurally visible. */
import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { RunRecordsPage, RunSummary, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { AiBudgetStatus, WorldlineAiCatalog } from '@deepseek-ai/dsh-worldline-ai/types'
import type { ContextPack, EntityId, JsonObject, JsonValue, ModelPurpose } from '@deepseek-ai/dsh-worldline-standard/types'
import type { AiClient, RunsClient } from './types.ts'
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

export function SimulationWorkbench(props: SimulationWorkbenchProps) {
  const [summaries, setSummaries] = useState<readonly RunSummary[]>([])
  const [selectedId, setSelectedId] = useState<RunSummary['runId']>()
  const [view, setView] = useState<RunView>()
  const [records, setRecords] = useState<RunRecordsPage>()
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
  const projectId = props.project.manifest.id

  const loadList = useCallback(async (): Promise<void> => {
    const all = await props.runs.list()
    const filtered = all.filter(run => run.projectId === projectId)
    setSummaries(filtered)
    setSelectedId(current => current !== undefined && filtered.some(run => run.runId === current)
      ? current : filtered[0]?.runId)
  }, [projectId, props.runs])

  const refresh = useCallback(async (runId = selectedId): Promise<void> => {
    if (runId === undefined) { setView(undefined); setRecords(undefined); return }
    const [nextView, nextRecords] = await Promise.all([
      props.runs.view({ runId }),
      props.runs.records({ runId, limit: 200, ...(stream === undefined ? {} : { stream }) }),
    ])
    setView(nextView)
    setRecords(nextRecords)
    const actors = entityIds(nextView)
    setSelectedActor(current => current !== undefined && actors.includes(current) ? current : actors[0])
  }, [props.runs, selectedId, stream])

  useEffect(() => { void loadList().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [loadList, props.runRevision])
  useEffect(() => { void refresh().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [refresh])
  useEffect(() => { void props.ai.catalog().then(setCatalog).catch(() => {}) }, [props.ai])

  const mutate = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { await operation(); await loadList(); await refresh() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(undefined) }
  }

  const actors = entityIds(view)
  const selectedEntity = record(record(view?.snapshot.state['entities'])?.[selectedActor ?? ''])
  const model = catalog?.models.find(item => `${item.provider}/${item.id}` === modelKey)
  const usage = view?.aiUsage

  return <div className={css.workbench}>
    <aside className={css.runList}>
      <header><div><span>WORKER RUNTIME</span><h2>{props.t('runs')}</h2></div><button type="button" onClick={() => { void loadList() }}>↻</button></header>
      <div className={css.newRun}>
        <label>{props.t('seed')}<input value={seed} onChange={(event) => { setSeed(event.target.value) }} /></label>
        <label className={css.check}><input type="checkbox" checked={startPaused} onChange={(event) => { setStartPaused(event.target.checked) }} />{props.t('startPaused')}</label>
        <button type="button" disabled={busy !== undefined} onClick={() => { void mutate('create', async () => {
          const created = await props.runs.create({ projectId, seed: seed || 'worldline-seed', startPaused })
          setSelectedId(created.summary.runId)
          props.onRunsChanged()
        }) }}>{props.t('newRun')}</button>
      </div>
      <ul>{summaries.map(run => <li key={run.runId}><button type="button" data-active={selectedId === run.runId || undefined} onClick={() => { setSelectedId(run.runId) }}>
        <span data-status={run.status} /><strong>{shortId(run.runId)}</strong><small>{run.status} · t={run.logicalTime.toLocaleString()}</small>
      </button></li>)}</ul>
    </aside>

    <main className={css.main}>
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
        <section className={css.metrics}>
          <div><small>{props.t('logicalTime')}</small><strong>{view.snapshot.logicalTime.toLocaleString()}</strong></div>
          <div><small>{props.t('sequence')}</small><strong>{view.snapshot.sequence.toLocaleString()}</strong></div>
          <div><small>{props.t('queue')}</small><strong>{view.health.futureQueueDepth}</strong></div>
          <div><small>{props.t('processes')}</small><strong>{view.health.activeProcesses}<i> / {view.health.waitingProcesses}</i></strong></div>
          <div><small>{props.t('reservations')}</small><strong>{view.health.reservations}</strong></div>
          <div><small>{props.t('fairness')}</small><strong>{view.health.fairnessInterventions}</strong></div>
          <div><small>{props.t('deadlocks')}</small><strong>{view.health.deadlocksResolved}</strong></div>
          <div><small>{props.t('livelocks')}</small><strong>{view.health.livelocksResolved}</strong></div>
        </section>
        <div className={css.contentGrid}>
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
              <div><span>{item.stream}</span><strong>#{item.sequence}</strong><small>t={item.logicalTime}</small></div><pre>{JSON.stringify(item.payload, null, 2)}</pre>
            </li>)}</ol>
          </section>
          <section className={`${css.panel} ${css.aiPanel}`}>
            <header><h3>{props.t('ai')}</h3><button type="button" data-enabled={view.snapshot.modelPolicy.aiEnabled || undefined} onClick={() => { void mutate('ai-toggle', async () => { await props.runs.setAiEnabled({ runId: view.summary.runId, enabled: !view.snapshot.modelPolicy.aiEnabled }) }) }}>{view.snapshot.modelPolicy.aiEnabled ? props.t('aiEnabled') : props.t('aiDisabled')}</button></header>
            <div className={css.usage}>
              <span>Calls <strong>{usage?.calls ?? 0}</strong></span><span>Input <strong>{usage?.inputTokens.toLocaleString() ?? 0}</strong></span><span>Output <strong>{usage?.outputTokens.toLocaleString() ?? 0}</strong></span><span>Cost <strong>{usage?.estimatedCost.toFixed(4) ?? '0'}</strong></span>
            </div>
            <div className={css.modelForm}>
              <select value={modelPurpose} onChange={(event) => { setModelPurpose(event.target.value as ModelPurpose) }}>{['character', 'narrator', 'summary', 'creative', 'compiler'].map(value => <option key={value}>{value}</option>)}</select>
              <select value={modelKey} onChange={(event) => { setModelKey(event.target.value) }}><option value="">{props.t('modelCatalog')}</option>{catalog?.models.map(item => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.provider} / {item.name}</option>)}</select>
              <button type="button" disabled={model === undefined} onClick={() => {
                if (model === undefined) return
                void mutate('model', async () => { await props.runs.switchModel({
                  runId: view.summary.runId,
                  expectedSequence: view.snapshot.sequence,
                  modelPolicy: { ...view.snapshot.modelPolicy, routes: { ...view.snapshot.modelPolicy.routes, [modelPurpose]: { provider: model.provider, model: model.id } } },
                }) })
              }}>{props.t('modelRoute')}</button>
            </div>
            {selectedActor !== undefined && <div className={css.aiActions}>
              <button type="button" onClick={() => { void mutate('budget', async () => { setBudget(await props.ai.budget({ runId: view.summary.runId, actorId: selectedActor })) }) }}>{props.t('budget')}</button>
              <button type="button" onClick={() => { void mutate('context', async () => { setContextPack(await props.ai.contextPack({ runId: view.summary.runId, actorId: selectedActor })) }) }}>{props.t('context')}</button>
              <button type="button" onClick={() => { void mutate('decide', async () => { await props.ai.decide({ runId: view.summary.runId, actorId: selectedActor }) }) }}>{props.t('decide')}</button>
            </div>}
            {budget !== undefined && <pre>{JSON.stringify(budget, null, 2)}</pre>}
            {contextPack !== undefined && <details open><summary>{props.t('context')} · {contextPack.totalTokens}/{contextPack.inputLimit}</summary><pre>{JSON.stringify(contextPack, null, 2)}</pre></details>}
          </section>
        </div>
      </>}
    </main>
  </div>
}
