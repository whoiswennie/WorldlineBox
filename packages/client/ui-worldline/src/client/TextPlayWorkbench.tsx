/* oxlint-disable @stylistic/max-len -- JSX keeps each compact story action structurally visible. */
import { useCallback, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { RunSummary, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { TextPlayView, StoryStageStatus } from '@deepseek-ai/dsh-worldline-narrative/types'
import type { EntityId, JsonObject, JsonValue, NarrativeBeat } from '@deepseek-ai/dsh-worldline-standard/types'
import { worldlineLabel } from './presentation.ts'
import type { NarrativeClient, RunsClient } from './types.ts'
import css from './TextPlayWorkbench.module.css'

interface TextPlayWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly runs: RunsClient
  readonly narrative: NarrativeClient
  readonly preferredRunId?: RunSummary['runId'] | undefined
  readonly preferredActorId?: EntityId | undefined
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function actors(view: RunView | undefined): EntityId[] {
  return Object.keys(record(view?.snapshot.state['entities']) ?? {}) as EntityId[]
}

export function TextPlayWorkbench(props: TextPlayWorkbenchProps) {
  const [runs, setRuns] = useState<readonly RunSummary[]>([])
  const [runId, setRunId] = useState<RunSummary['runId'] | undefined>(props.preferredRunId)
  const [actorId, setActorId] = useState<EntityId | undefined>(props.preferredActorId)
  const [runView, setRunView] = useState<RunView>()
  const [play, setPlay] = useState<TextPlayView>()
  const [stage, setStage] = useState<StoryStageStatus>()
  const [camera, setCamera] = useState('limited-third-person')
  const [templateOnly, setTemplateOnly] = useState(false)
  const [freeText, setFreeText] = useState('')
  const [retryChoiceId, setRetryChoiceId] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const projectId = props.project.manifest.id

  const loadRuns = useCallback(async (): Promise<void> => {
    const next = (await props.runs.list()).filter(item => item.projectId === projectId)
    setRuns(next)
    setRunId(current => current !== undefined && next.some(item => item.runId === current)
      ? current : props.preferredRunId !== undefined && next.some(item => item.runId === props.preferredRunId)
        ? props.preferredRunId : next[0]?.runId)
  }, [projectId, props.preferredRunId, props.runs])

  const loadRun = useCallback(async (): Promise<void> => {
    if (runId === undefined) { setRunView(undefined); setPlay(undefined); return }
    const next = await props.runs.view({ runId })
    setRunView(next)
    const ids = actors(next)
    setActorId(current => current !== undefined && ids.includes(current) ? current
      : props.preferredActorId !== undefined && ids.includes(props.preferredActorId)
        ? props.preferredActorId : ids[0])
  }, [props.preferredActorId, props.runs, runId])

  const refreshPlay = useCallback(async (): Promise<void> => {
    if (runId === undefined || actorId === undefined) { setPlay(undefined); return }
    setPlay(await props.narrative.open({ runId, actorId, camera }))
  }, [actorId, camera, props.narrative, runId])

  useEffect(() => { void loadRuns().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [loadRuns])
  useEffect(() => { void loadRun().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [loadRun])
  useEffect(() => { void refreshPlay().catch((reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)) }) }, [refreshPlay])
  useEffect(() => { void props.narrative.storyStage().then(setStage).catch(() => {}) }, [props.narrative])
  useEffect(() => {
    if (play === undefined) return
    setRetryChoiceId(current => play.choices.choices.some(choice => choice.id === current)
      ? current : play.choices.choices[0]?.id ?? '')
  }, [play])

  const mutate = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { await operation(); await loadRuns(); await loadRun(); await refreshPlay() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(undefined) }
  }

  const narrate = (): void => {
    if (runId === undefined || actorId === undefined) return
    setStreamingText('')
    void mutate('narrate', async () => {
      await props.narrative.narrateStream({ runId, actorId, camera, templateOnly }, (chunk) => {
        if (chunk.type === 'text-delta') setStreamingText(current => current + chunk.text)
        if (chunk.type === 'replace') setStreamingText(chunk.text)
      })
      setStreamingText('')
    })
  }

  const rephrase = (beat: NarrativeBeat): void => {
    if (runId === undefined || actorId === undefined) return
    void mutate(`rephrase:${beat.id}`, async () => { await props.narrative.rephrase({ runId, actorId, beatId: beat.id, camera }) })
  }

  return <div className={css.page}>
    <header className={css.header}>
      <div><span>文字叙事投影</span><h2>{props.t('textPlay')}</h2></div>
      <div className={css.selectors}>
        <label>{props.t('run')}<select value={runId ?? ''} onChange={(event) => { setRunId(event.target.value as RunSummary['runId']) }}>{runs.map(item => <option key={item.runId} value={item.runId}>{item.runId.slice(-12)} · {worldlineLabel(item.status)}</option>)}</select></label>
        <label>{props.t('actor')}<select value={actorId ?? ''} onChange={(event) => { setActorId(event.target.value as EntityId) }}>{actors(runView).map(id => <option key={id}>{id}</option>)}</select></label>
        <label>{props.t('camera')}<select value={camera} onChange={(event) => { setCamera(event.target.value) }}><option value="limited-third-person">{worldlineLabel('limited-third-person')}</option><option value="first-person">{worldlineLabel('first-person')}</option><option value="objective">{worldlineLabel('objective')}</option></select></label>
      </div>
    </header>
    {error !== undefined && <div className={css.error} role="alert">{props.t('error')}: {error}</div>}
    {play === undefined ? <div className={css.empty}><span>❧</span><p>{runs.length === 0 ? props.t('newRun') : props.t('actor')}</p></div> : <div className={css.layout}>
      <main className={css.story}>
        <section className={css.sceneMeta}>
          <div><small>{props.t('logicalTime')}</small><strong>{play.frame.logicalTime.toLocaleString()}</strong></div>
          <div><small>{props.t('place')}</small><strong>{play.frame.placeId ?? '—'}</strong></div>
          <div><small>{props.t('presentActors')}</small><strong>{play.frame.presentEntityIds.length}</strong></div>
          <button type="button" disabled={busy !== undefined} onClick={narrate}>{busy === 'narrate' ? '…' : props.t('narrate')}</button>
          <label><input type="checkbox" checked={templateOnly} onChange={(event) => { setTemplateOnly(event.target.checked) }} />{props.t('templateNarration')}</label>
        </section>
        <div className={css.transcript} aria-live="polite">
          {play.beats.length === 0 && streamingText === '' && <p className={css.quiet}>{props.t('waitingNarration')}</p>}
          {play.beats.map((beat, index) => <article key={beat.id} data-style={beat.style} data-latest={index === play.beats.length - 1 || undefined}>
            <header><span>{worldlineLabel(beat.camera)}</span><small>{worldlineLabel(beat.style)}{beat.modelRoute === undefined ? '' : ` · ${beat.modelRoute.provider}/${beat.modelRoute.model}`}</small></header>
            <MarkdownText text={beat.text} />
            <footer><span>{beat.eventIds.length} {props.t('eventCount')} · {beat.observationIds.length} {props.t('observationCount')}</span><button type="button" onClick={() => { rephrase(beat) }}>{props.t('rephrase')}</button></footer>
          </article>)}
          {streamingText !== '' && <article data-streaming data-latest><header><span>{worldlineLabel(camera)}</span><small>{props.t('streaming')}</small></header><MarkdownText text={streamingText} streaming /></article>}
        </div>
        <section className={css.composer}>
          <div className={css.choices}>{play.choices.choices.map(choice => <button type="button" key={choice.id} disabled={busy !== undefined} onClick={() => { void mutate(`choice:${choice.id}`, async () => { await props.narrative.choose({ runId: play.run.summary.runId, actorId: play.choices.actorId, choiceId: choice.id, expectedSequence: play.choices.sequence, camera }) }) }}>
            <strong>{choice.label}</strong><span>{choice.description}</span><small>{choice.estimatedDuration}t{choice.risks.length === 0 ? '' : ` · ${choice.risks.join(', ')}`}</small>
          </button>)}</div>
          <form onSubmit={(event) => {
            event.preventDefault()
            const text = freeText.trim()
            if (text === '') return
            void mutate('free', async () => {
              const result = await props.narrative.freeInput({ runId: play.run.summary.runId, actorId: play.choices.actorId, text, expectedSequence: play.choices.sequence, camera })
              if (result.status !== 'submitted') throw new Error(`${result.status}: ${result.candidates.map(item => item.label).join(', ')}`)
              setFreeText('')
            })
          }}><textarea value={freeText} onChange={(event) => { setFreeText(event.target.value) }} placeholder={props.t('freeInput')} /><button type="submit" disabled={busy !== undefined}>{props.t('submit')}</button></form>
        </section>
      </main>
      <aside className={css.sidebar}>
        <section><h3>{props.t('savePoint')}</h3><button type="button" disabled={runId === undefined || actorId === undefined} onClick={() => {
          if (runId === undefined || actorId === undefined) return
          void mutate('save', async () => { await props.narrative.save({ runId, actorId, label: `故事舞台 · t=${String(play.frame.logicalTime)}`, camera }) })
        }}>{props.t('savePoint')}</button>
        {play.saves.length > 0 && <label className={css.retryChoice}>{props.t('retryChoice')}<select value={retryChoiceId} onChange={(event) => { setRetryChoiceId(event.target.value) }}>{play.choices.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>}
        <ul>{play.saves.map(save => <li key={save.checkpoint.id}><div><strong>{save.label}</strong><small>#{save.checkpoint.sequence}</small></div><div className={css.saveActions}><button type="button" disabled={busy !== undefined} onClick={() => {
          if (actorId === undefined) return
          void mutate(`branch:${save.checkpoint.id}`, async () => {
            const branch = await props.narrative.branch({ runId: play.run.summary.runId, actorId, checkpointId: save.checkpoint.id, camera })
            setRunId(branch.summary.runId)
          })
        }}>{props.t('branch')}</button><button type="button" disabled={busy !== undefined || retryChoiceId === ''} onClick={() => {
          if (actorId === undefined || retryChoiceId === '') return
          void mutate(`retry:${save.checkpoint.id}`, async () => {
            const result = await props.narrative.retry({ runId: play.run.summary.runId, actorId, checkpointId: save.checkpoint.id, choiceId: retryChoiceId, camera })
            setRunId(result.view.summary.runId)
          })
        }}>{props.t('retry')}</button></div></li>)}</ul></section>
        <section data-unavailable={stage?.available === false || undefined}><h3>{props.t('storyStage')} <span>{stage?.available ? stage.renderers.length : props.t('unavailable')}</span></h3><p>{stage?.message ?? '…'}</p>{stage?.renderers.map(renderer => <div key={renderer.id}><strong>{renderer.name}</strong><small>{renderer.capabilities.join(' · ')}</small></div>)}</section>
        <section><h3>{props.t('advancedData')}</h3><pre>{JSON.stringify(play.frame, null, 2)}</pre></section>
      </aside>
    </div>}
  </div>
}
