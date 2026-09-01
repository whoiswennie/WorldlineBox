/* oxlint-disable @stylistic/max-len -- JSX keeps each compact diagnostic row structurally visible. */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BuildPreview, CompilerState, SemanticsExplanation } from '@deepseek-ai/dsh-worldline-compiler/types'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { CompilerClient } from './types.ts'
import css from './BuildWorkbench.module.css'

interface BuildWorkbenchProps extends PropsLocale<'worldlineStudio'> {
  readonly project: ProjectSummary
  readonly compiler: CompilerClient
  readonly onFrozen: () => void
}

function percent(value: number): string { return `${String(Math.round(value * 100))}%` }

export function BuildWorkbench(props: BuildWorkbenchProps) {
  const [preview, setPreview] = useState<BuildPreview>()
  const [state, setState] = useState<CompilerState>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [explanation, setExplanation] = useState<SemanticsExplanation>()
  const projectId = props.project.manifest.id

  useEffect(() => {
    let current = true
    void props.compiler.state(projectId).then((value) => { if (current) setState(value) }).catch(() => {})
    return () => { current = false }
  }, [projectId, props.compiler])

  const run = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(key); setError(undefined)
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(undefined) }
  }

  const compile = (): void => { void run('compile', async () => { setPreview(await props.compiler.compile({ projectId })) }) }
  const answer = (questionId: string): void => {
    const value = answers[questionId]?.trim()
    if (value === undefined || value === '') return
    void run(`question:${questionId}`, async () => {
      const next = await props.compiler.answerQuestion({
        projectId,
        questionId,
        answer: value,
        ...(state?.revision === undefined ? {} : { expectedStateRevision: state.revision }),
      })
      setState(next)
      setPreview(await props.compiler.compile({ projectId }))
    })
  }
  const review = (proposalId: string, decision: 'approved' | 'rejected'): void => {
    void run(`proposal:${proposalId}`, async () => {
      const next = await props.compiler.reviewProposal({
        projectId,
        proposalId,
        decision,
        reviewedBy: 'local-author',
        ...(state?.revision === undefined ? {} : { expectedStateRevision: state.revision }),
      })
      setState(next)
      setPreview(await props.compiler.compile({ projectId }))
    })
  }

  const questions = preview?.questions ?? state?.questions ?? []
  const proposals = preview?.proposals ?? state?.proposals ?? []
  return <div className={css.page}>
    <header className={css.hero}>
      <div><span>CANON → BLUEPRINT</span><h2>{props.t('build')}</h2><p>{props.t('noBuild')}</p></div>
      <div className={css.heroActions}>
        <button type="button" disabled={busy !== undefined} onClick={compile}>{busy === 'compile' ? props.t('loading') : props.t('compile')}</button>
        <button type="button" data-primary disabled={preview?.canFreeze !== true || busy !== undefined} onClick={() => {
          if (preview === undefined) return
          void run('freeze', async () => {
            await props.compiler.freeze({ projectId, expectedSourceDigest: preview.sourceDigest })
            setPreview(await props.compiler.compile({ projectId }))
            props.onFrozen()
          })
        }}>{props.t('freeze')}</button>
      </div>
    </header>
    {error !== undefined && <div className={css.error} role="alert">{props.t('error')}: {error}</div>}
    {preview === undefined ? <div className={css.empty}><span>⌁</span><p>{props.t('noBuild')}</p><button type="button" onClick={compile}>{props.t('compile')}</button></div> : <>
      <section className={css.metrics}>
        <div><small>{props.t('sourceCoverage')}</small><strong>{percent(preview.sourceCoverage)}</strong><i><span style={{ width: percent(preview.sourceCoverage) }} /></i></div>
        <div><small>Canon</small><strong>{preview.canon.length}</strong><span>{preview.phase}</span></div>
        <div><small>Executable</small><strong>{Object.values(preview.executableCounts).reduce((sum, value) => sum + value, 0)}</strong><span>{Object.entries(preview.executableCounts).map(([key, value]) => `${key} ${String(value)}`).join(' · ')}</span></div>
        <div data-ready={preview.canFreeze || undefined}><small>Closure</small><strong>{preview.canFreeze ? 'READY' : 'BLOCKED'}</strong><span>{preview.canFreeze ? props.t('freezeReady') : props.t('freezeBlocked')}</span></div>
      </section>
      <div className={css.columns}>
        <section className={css.panel}>
          <header><h3>{props.t('diagnostics')}</h3><span>{preview.diagnostics.length}</span></header>
          <ul>{preview.diagnostics.map(item => <li key={`${item.code}:${item.path ?? ''}:${item.objectId ?? ''}`} data-severity={item.severity}>
            <div><strong>{item.code}</strong><small>{item.path}</small></div><p>{item.message}</p>{item.remediation !== undefined && <em>{item.remediation}</em>}
          </li>)}</ul>
        </section>
        <section className={css.panel}>
          <header><h3>{props.t('questions')}</h3><span>{questions.filter(item => item.status === 'open').length}</span></header>
          <ul>{questions.map(question => <li key={question.id} data-resolved={question.status !== 'open' || undefined}>
            <div><strong>{question.prompt}</strong><small>{question.impact} · {question.status}</small></div><p>{question.rationale}</p>
            {question.status === 'open' && <div className={css.answer}><textarea value={answers[question.id] ?? ''} onChange={(event) => { setAnswers(current => ({ ...current, [question.id]: event.target.value })) }} /><button type="button" disabled={busy !== undefined} onClick={() => { answer(question.id) }}>{props.t('answer')}</button></div>}
            {question.answer !== undefined && <blockquote>{question.answer}</blockquote>}
          </li>)}</ul>
        </section>
        <section className={css.panel}>
          <header><h3>{props.t('proposals')}</h3><span>{proposals.filter(item => item.status === 'pending').length}</span></header>
          <ul>{proposals.map(proposal => <li key={proposal.id} data-resolved={proposal.status !== 'pending' || undefined}>
            <div><strong>{proposal.title}</strong><small>{proposal.target} · {proposal.risk} · {proposal.status}</small></div><p>{proposal.rationale}</p>
            <details><summary>Payload</summary><pre>{JSON.stringify(proposal.payload, null, 2)}</pre></details>
            {proposal.status === 'pending' && <div className={css.rowActions}><button type="button" onClick={() => { review(proposal.id, 'approved') }}>{props.t('approve')}</button><button type="button" onClick={() => { review(proposal.id, 'rejected') }}>{props.t('reject')}</button></div>}
          </li>)}</ul>
        </section>
        <section className={css.panel}>
          <header><h3>{props.t('certificate')}</h3><span>{preview.certificate.results.filter(item => item.status === 'pass').length}/{preview.certificate.results.length}</span></header>
          <ul>{preview.certificate.results.map(result => <li key={result.category} data-severity={result.status}>
            <div><strong>{result.category}</strong><small>{result.status}</small></div><p>{result.summary}</p><details><summary>Evidence</summary><ul>{result.evidence.map(value => <li key={value}>{value}</li>)}</ul></details>
          </li>)}</ul>
        </section>
      </div>
      <section className={css.canonTable}>
        <header><h3>Canon & provenance</h3><span>{preview.canon.length}</span></header>
        {preview.canon.map(item => <button type="button" key={item.id} onClick={() => { void run(`explain:${item.id}`, async () => { setExplanation(await props.compiler.explain({ projectId, objectId: item.id })) }) }}>
          <span>{item.kind}</span><strong>{item.title}</strong><small>{item.provenance.flatMap(value => value.anchors).length} anchors</small>
        </button>)}
      </section>
    </>}
    {explanation !== undefined && <div className={css.explain} role="dialog" aria-modal="true" aria-label={props.t('explain')}>
      <div><header><h3>{props.t('explain')}</h3><button type="button" onClick={() => { setExplanation(undefined) }}>×</button></header><p>{explanation.summary}</p><ul>{explanation.anchors.map(anchor => <li key={anchor.id}><strong>{anchor.heading ?? anchor.documentId}</strong><small>{anchor.startOffset}–{anchor.endOffset} · {anchor.excerptHash.slice(0, 12)}</small></li>)}</ul></div>
    </div>}
  </div>
}
