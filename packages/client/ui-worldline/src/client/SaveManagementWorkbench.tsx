import { useCallback, useEffect, useState } from 'react'
import type { CheckpointView, RunSummary, RunView } from '@deepseek-ai/dsh-worldline-runtime/types'
import type { EntityId, RunId } from '@deepseek-ai/dsh-worldline-standard/types'
import { WORLDLINE_PROJECT_LAYOUT } from '@deepseek-ai/dsh-worldline-standard/project-layout'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import { characterEntityIds, gameCalendar, snapshotEntities, worldlineLabel } from './presentation.ts'
import type { RunsClient } from './types.ts'
import css from './WorldlineStudio.module.css'

interface ManagedRun {
  readonly summary: RunSummary
  readonly view?: RunView
  readonly checkpoints: readonly CheckpointView[]
  readonly error?: string
}

export interface SaveManagementWorkbenchProps {
  readonly project: ProjectSummary
  readonly runs: RunsClient
  readonly revision: number
  readonly onChanged: () => void
  readonly onImport: () => void
  readonly onExport: (runId: RunId) => void
  readonly onContinue: (runId?: RunId, actorId?: EntityId) => void
}

function updatedLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

export function SaveManagementWorkbench(props: SaveManagementWorkbenchProps) {
  const [items, setItems] = useState<readonly ManagedRun[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const summaries = (await props.runs.list())
        .filter(item => item.projectId === props.project.manifest.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      const next = await Promise.all(summaries.map(async (summary): Promise<ManagedRun> => {
        try {
          const [view, checkpoints] = await Promise.all([
            props.runs.view({ runId: summary.runId }),
            props.runs.checkpoints({ runId: summary.runId }),
          ])
          return { summary, view, checkpoints: [...checkpoints].reverse() }
        } catch (cause) {
          return {
            summary,
            checkpoints: [],
            error: cause instanceof Error ? cause.message : String(cause),
          }
        }
      }))
      setItems(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [props.project.manifest.id, props.runs])

  useEffect(() => { void load() }, [load, props.revision])

  const mutate = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError(undefined)
    try {
      await action()
      props.onChanged()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(undefined)
    }
  }

  return <main className={css.saveManager}>
    <header className={css.saveManagerHero}>
      <div>
        <small>WORLDLINE SAVE VAULT</small>
        <h1>存档管理</h1>
        <p>世界线、检查点与分支都来自同一份权威运行快照。正典 Markdown 不会被存档改写；恢复与分支也不会覆盖原进度。</p>
        <section className={css.saveStorageContract}>
          <span><strong>运行快照</strong><code>{WORLDLINE_PROJECT_LAYOUT.control.runs}/</code></span>
          <span><strong>版本历史</strong><code>{WORLDLINE_PROJECT_LAYOUT.control.history}/</code></span>
          <span><strong>正文档案</strong><code>始终独立、可迁移</code></span>
        </section>
      </div>
      <section><button type="button" onClick={props.onImport}>导入世界线</button><button type="button" onClick={() => { void load() }}>刷新存档</button></section>
    </header>
    {error !== undefined && <button type="button" className={css.saveManagerError} onClick={() => { setError(undefined) }}>读取或操作失败：{error} · 点击关闭</button>}
    {loading && items.length === 0 ? <div className={css.saveManagerEmpty}><span>◌</span><h2>正在整理世界线存档…</h2></div>
      : items.length === 0 ? <div className={css.saveManagerEmpty}><span>⌁</span><h2>还没有世界线存档</h2><p>进入视觉演绎开启世界后，这里会集中管理自动保存的运行进度与手动检查点。</p><button type="button" onClick={() => { props.onContinue() }}>进入视觉演绎</button></div>
        : <section className={css.saveRunList}>{items.map((item, index) => {
          const calendar = item.view === undefined ? undefined : gameCalendar(item.view.snapshot)
          const actors = item.view === undefined ? [] : characterEntityIds(snapshotEntities(item.view.snapshot))
          const runKey = String(item.summary.runId)
          const active = item.summary.status === 'running' || item.summary.status === 'starting'
          return <article className={css.saveRunCard} key={runKey}>
            <header><div><small>世界线 {String(items.length - index).padStart(2, '0')}</small><h2>{calendar?.fullLabel ?? `逻辑时间 ${String(item.summary.logicalTime)}`}</h2><p>{item.summary.parentRunId === undefined ? '原始世界线' : `分支自 ${String(item.summary.parentRunId).slice(-8)} · 序列 ${String(item.summary.forkSequence ?? 0)}`}</p></div><span data-status={item.summary.status}>{worldlineLabel(item.summary.status)}</span></header>
            <dl>
              <div><dt>最近更新</dt><dd>{updatedLabel(item.summary.updatedAt)}</dd></div>
              <div><dt>事件序列</dt><dd>{item.summary.sequence}</dd></div>
              <div><dt>存档点</dt><dd>{item.checkpoints.length}</dd></div>
              <div><dt>世界线 ID</dt><dd>{runKey.slice(-10)}</dd></div>
            </dl>
            {item.error !== undefined && <p className={css.saveRunError}>这条世界线暂时无法读取：{item.error}</p>}
            <div className={css.saveRunActions}>
              <button type="button" data-primary disabled={item.view === undefined} onClick={() => { props.onContinue(item.summary.runId, actors[0]) }}>继续故事</button>
              <button type="button" disabled={busy !== undefined || item.view === undefined || item.summary.status === 'stopped' || item.summary.status === 'failed'} onClick={() => {
                void mutate(`flow:${runKey}`, async () => { if (active) await props.runs.pause({ runId: item.summary.runId }); else await props.runs.resume({ runId: item.summary.runId }) })
              }}>{active ? '暂停世界' : '恢复世界'}</button>
              <button type="button" disabled={busy !== undefined || calendar === undefined} onClick={() => {
                if (calendar === undefined) return
                void mutate(`checkpoint:${runKey}`, async () => { await props.runs.checkpoint({ runId: item.summary.runId, label: calendar.fullLabel }) })
              }}>保存此刻</button>
              <button type="button" onClick={() => { props.onExport(item.summary.runId) }}>导出存档</button>
            </div>
            <section className={css.saveCheckpoints}><header><strong>时间锚点</strong><small>{item.checkpoints.length === 0 ? '尚无手动存档' : '从存档点创建分支不会覆盖原世界线'}</small></header>{item.checkpoints.length === 0 ? <p>故事运行时会持续保存当前世界；需要明确回溯点时，点击“保存此刻”。</p> : <ol>{item.checkpoints.map(checkpoint => <li key={checkpoint.checkpoint.id}><div><strong>{checkpoint.label}</strong><small>{updatedLabel(checkpoint.createdAt)} · {String(checkpoint.checkpoint.id).slice(-8)}</small></div><button type="button" disabled={busy !== undefined} onClick={() => {
              void mutate(`branch:${String(checkpoint.checkpoint.id)}`, async () => {
                const branch = await props.runs.branch({ runId: item.summary.runId, checkpointId: checkpoint.checkpoint.id })
                props.onContinue(branch.summary.runId, actors[0])
              })
            }}>从这里另开世界线</button></li>)}</ol>}</section>
          </article>
        })}</section>}
  </main>
}
