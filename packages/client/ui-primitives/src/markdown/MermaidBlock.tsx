import { useEffect, useRef, useState } from 'react'
import type { RenderResult } from 'mermaid'
import { CodeBlock } from './CodeBlock.tsx'
import type { MarkdownCodeLabels } from './render.tsx'
import css from './MarkdownText.module.css'

interface MermaidRenderState {
  source: string
  result?: RenderResult | undefined
  error?: string | undefined
}

let mermaidModule: Promise<(typeof import('mermaid'))['default']> | undefined
let diagramSequence = 0

function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  mermaidModule ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      htmlLabels: false,
    })
    return mermaid
  })
  return mermaidModule
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Settled Mermaid fence rendered lazily so ordinary Markdown does not load the diagram engine. */
export function MermaidBlock({ source, codeLabels }: {
  source: string
  codeLabels?: MarkdownCodeLabels | undefined
}) {
  const id = useRef<string | null>(null)
  id.current ??= `worldline-mermaid-${++diagramSequence}`
  const root = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<MermaidRenderState>({ source })

  useEffect(() => {
    let current = true
    setState({ source })
    void loadMermaid()
      .then(mermaid => mermaid.render(id.current ?? 'worldline-mermaid', source))
      .then(
        (result) => { if (current) setState({ source, result }) },
        (reason: unknown) => { if (current) setState({ source, error: errorMessage(reason) }) },
      )
    return () => { current = false }
  }, [source])

  useEffect(() => {
    if (state.source !== source || state.result === undefined || root.current === null) return
    try {
      state.result.bindFunctions?.(root.current)
    } catch (reason) {
      setState({ source, error: errorMessage(reason) })
    }
  }, [source, state])

  if (state.source !== source || (state.result === undefined && state.error === undefined)) {
    return <div className={css.mermaidStatus} role="status">正在渲染 Mermaid 图表…</div>
  }
  if (state.error !== undefined) {
    return <div className={css.mermaidError} role="alert">
      <strong>Mermaid 图表渲染失败</strong>
      <span>{state.error}</span>
      <CodeBlock
        code={`${source}\n`}
        lang="mermaid"
        copyLabel={codeLabels?.copyLabel}
        copiedLabel={codeLabels?.copiedLabel}
      />
    </div>
  }
  return (
    <figure className={css.mermaidFigure} aria-label="Mermaid 图表">
      <div
        ref={root}
        className={css.mermaidSvg}
        // Mermaid owns this SVG string and runs with strict security; authored
        // raw HTML never reaches this path or the surrounding Markdown DOM.
        dangerouslySetInnerHTML={{ __html: state.result?.svg ?? '' }}
      />
    </figure>
  )
}
