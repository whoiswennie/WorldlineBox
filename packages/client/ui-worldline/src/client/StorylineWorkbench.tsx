import { useEffect, useMemo, useState } from 'react'
import type { DocumentView, ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { ScriptProgressView } from '@deepseek-ai/dsh-worldline-narrative/types'
import type { EntityId, PlotPointDefinition } from '@deepseek-ai/dsh-worldline-standard/types'
import { plotDraft } from './nativeOc.ts'
import { characterEntityIds, snapshotEntities } from './presentation.ts'
import type { NarrativeClient, ProjectClient, RunsClient } from './types.ts'
import css from './StorylineWorkbench.module.css'

interface StorylineWorkbenchProps {
  readonly project: ProjectSummary
  readonly projects: ProjectClient
  readonly runs: RunsClient
  readonly narrative: NarrativeClient
  readonly treeRevision: number
  readonly openPath: (path: string) => Promise<void>
  readonly openVisualStory: (runId: Parameters<RunsClient['view']>[0]['runId'], actorId: EntityId) => void
}

interface TimelineIntervention {
  readonly id: string
  readonly at: number
  readonly title: string
  readonly description: string
}

interface StorylinePoint {
  readonly id: string
  readonly path?: string
  readonly name: string
  readonly summary: string
  readonly order: number
  readonly entryCondition: string
  readonly completionCriteria: string
  readonly dramaticPressure: string
  readonly successOutcome: string
  readonly failureOutcome: string
  readonly recoveryHook: string
  readonly activateAt: number
  readonly deadlineAt: number
  readonly interventions: readonly TimelineIntervention[]
}

function parseInterventions(value: string, pointId: string): readonly TimelineIntervention[] {
  return value.split(/[；\r\n]+/gu).flatMap((entry, index) => {
    const [rawAt, title, ...description] = entry.split('|').map(item => item.trim())
    const at = Number(rawAt)
    if (!Number.isFinite(at) || title === undefined || title === '' || description.length === 0) return []
    return [{ id: `${pointId}:intervention:${String(index + 1)}`, at, title, description: description.join('|') }]
  })
}

function authoredPoint(document: DocumentView): StorylinePoint {
  const draft = plotDraft(document)
  return {
    id: document.id, path: document.path, name: draft.name, summary: draft.summary,
    order: draft.order, entryCondition: draft.entryCondition,
    completionCriteria: draft.completionCriteria, dramaticPressure: draft.dramaticPressure,
    successOutcome: draft.successOutcome, failureOutcome: draft.failureOutcome,
    recoveryHook: draft.recoveryHook, activateAt: draft.activateAt,
    deadlineAt: draft.deadlineAt,
    interventions: parseInterventions(draft.interventions, document.id),
  }
}

function runtimePoint(point: PlotPointDefinition): StorylinePoint {
  return {
    id: point.id, name: point.name, summary: point.summary, order: point.order,
    entryCondition: point.entryCondition, completionCriteria: point.completionCriteria,
    dramaticPressure: point.dramaticPressure, successOutcome: point.successOutcome,
    failureOutcome: point.failureOutcome, recoveryHook: point.recoveryHook,
    activateAt: point.timing.activateAt, deadlineAt: point.timing.deadlineAt,
    interventions: point.timing.interventions,
  }
}

function clockLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3_600)
  const minutes = Math.floor((safe % 3_600) / 60)
  const remainder = safe % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function remainingLabel(target: number, logicalTime: number): string {
  const delta = target - logicalTime
  if (delta === 0) return '此刻触发'
  return delta > 0 ? `剩余 ${clockLabel(delta)}` : `已超时 ${clockLabel(-delta)}`
}

export function StorylineWorkbench(props: StorylineWorkbenchProps) {
  const [points, setPoints] = useState<readonly StorylinePoint[]>([])
  const [progress, setProgress] = useState<ScriptProgressView>()
  const [activeRun, setActiveRun] = useState<Awaited<ReturnType<RunsClient['view']>>>()
  const [viewpoint, setViewpoint] = useState<EntityId>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      setError(undefined)
      const summaries = (await props.runs.list()).filter(item => (
        item.projectId === props.project.manifest.id
      ))
      const latest = summaries.find(item => item.status === 'running') ?? summaries[0]
      if (latest !== undefined) {
        const [run, definition] = await Promise.all([
          props.runs.view({ runId: latest.runId }),
          props.runs.definition({ runId: latest.runId }),
        ])
        if (controller.signal.aborted) return
        setActiveRun(run)
        const actorId = characterEntityIds(snapshotEntities(run.snapshot))[0]
        setViewpoint(actorId)
        if (definition.plotPoints.length > 0) setPoints(definition.plotPoints.map(runtimePoint))
        if (actorId !== undefined) {
          const play = await props.narrative.open({ runId: latest.runId, actorId })
          setProgress(play.script)
        }
        return
      }
      let listing
      try {
        listing = await props.projects.tree({
          projectId: props.project.manifest.id, path: 'scenarios/plot-points', limit: 500,
        })
      } catch {
        listing = undefined
      }
      const documents = await Promise.all((listing?.entries ?? [])
        .filter(item => item.kind === 'document' && item.path.endsWith('.md'))
        .map(item => props.projects.read({ projectId: props.project.manifest.id, path: item.path })))
      if (!controller.signal.aborted) setPoints(documents.map(authoredPoint))
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { controller.abort() }
  }, [props.narrative, props.project.manifest.id, props.projects, props.runs, props.treeRevision])

  const completedIds = useMemo(() => new Set(progress?.completed.map(point => point.id) ?? []), [progress])
  const ordered = [...points].sort((left, right) => left.order - right.order)
  const logicalTime = activeRun?.snapshot.logicalTime ?? 0
  const completedCount = ordered.filter(point => completedIds.has(point.id)).length
  const activePoint = progress?.current

  return <main className={css.page}>
    <header className={css.header}>
      <div><span>STORY CONTROL</span><h1>剧情调度台</h1><p>由 Runtime 时钟和证据驱动的硬剧情控制，不依赖模型自觉遵守提示。</p></div>
      {activeRun !== undefined && viewpoint !== undefined && <button type="button" onClick={() => {
        props.openVisualStory(activeRun.summary.runId, viewpoint)
      }}>进入视觉演绎</button>}
    </header>

    <section className={css.metrics} aria-label="剧情线运行摘要">
      <div><small>RUNTIME CLOCK</small><strong>{clockLabel(logicalTime)}</strong><span>权威逻辑时钟</span></div>
      <div><small>ACTIVE STAGE</small><strong>{activePoint?.name ?? '等待运行'}</strong><span>{activePoint === undefined ? '尚未选择当前剧情点' : '由真实证据决定进度'}</span></div>
      <div><small>PROGRESS</small><strong>{String(completedCount)} / {String(ordered.length)}</strong><span>已完成剧情点</span></div>
      <div><small>ENFORCEMENT</small><strong>Runtime</strong><span>激活、干预、截止均写入事件流</span></div>
    </section>

    {error !== undefined && <div className={css.error} role="alert">{error}</div>}
    {ordered.length === 0 ? <section className={css.empty}>
      <span>⌁</span><h2>还没有剧情控制轨</h2><p>请先在创作设定中建立带硬时间窗口和干预节点的剧情点。</p>
    </section> : <section className={css.board}>
      <header className={css.boardHeader}><span>阶段</span><span>时间控制</span><span>目标与证据</span><span>结果控制</span></header>
      <ol>{ordered.map((point) => {
        const state = completedIds.has(point.id) ? 'completed'
          : progress?.current?.id === point.id ? 'current'
            : logicalTime > point.deadlineAt ? 'overdue' : 'future'
        const nextIntervention = point.interventions.find(item => item.at >= logicalTime)
        return <li key={point.id} data-state={state}>
          <section className={css.stageIdentity}>
            <div><b>{String(point.order).padStart(2, '0')}</b><span>{state === 'completed'
              ? '已完成' : state === 'current' ? '执行中' : state === 'overdue' ? '已逾期' : '待激活'}</span></div>
            <h2>{point.name}</h2><p>{point.summary}</p>
            {point.path !== undefined && <button type="button" onClick={() => {
              if (point.path !== undefined) void props.openPath(point.path)
            }}>编辑定义</button>}
          </section>
          <section className={css.timeControl}>
            <small>HARD TIME WINDOW</small><strong>{clockLabel(point.activateAt)} — {clockLabel(point.deadlineAt)}</strong>
            <span data-late={logicalTime > point.deadlineAt || undefined}>{remainingLabel(point.deadlineAt, logicalTime)}</span>
            <ul>{point.interventions.map(item => <li key={item.id} data-past={item.at <= logicalTime || undefined}>
              <time>{clockLabel(item.at)}</time><div><strong>{item.title}</strong><p>{item.description}</p></div>
            </li>)}</ul>
            {point.interventions.length === 0 && <em>缺少硬时间干预</em>}
            {nextIntervention !== undefined && <p className={css.nextGate}>下一门控：{remainingLabel(nextIntervention.at, logicalTime)}</p>}
          </section>
          <section className={css.evidenceControl}>
            <dl>
              <div><dt>进入条件</dt><dd>{point.entryCondition}</dd></div>
              <div><dt>完成证据</dt><dd>{point.completionCriteria}</dd></div>
              <div><dt>戏剧压力</dt><dd>{point.dramaticPressure}</dd></div>
            </dl>
            {state === 'current' && progress?.currentProgress !== undefined && <aside>
              <strong>本轮证据审计</strong><p>{progress.currentProgress.rationale}</p>
              <ul>{progress.currentProgress.evidence.map((item, index) => (
                <li key={String(index)}>{item}</li>
              ))}</ul>
            </aside>}
          </section>
          <section className={css.outcomeControl}><dl>
            <div><dt>成功后果</dt><dd>{point.successOutcome}</dd></div>
            <div><dt>失败后果</dt><dd>{point.failureOutcome}</dd></div>
            <div><dt>恢复路径</dt><dd>{point.recoveryHook}</dd></div>
          </dl></section>
        </li>
      })}</ol>
    </section>}
  </main>
}
