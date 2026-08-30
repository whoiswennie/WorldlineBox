// CodeBlock: one code surface for every consumer — markdown fences, the
// run_code program body, and the details panel's raw args/output — with
// shiki highlighting for the registered grammars and an identical-geometry
// plain fallback for everything else. Chrome (language banner + copy) matches
// deepsuite `@deepseek/md` code blocks; token colors stay on `--shiki-*`.

import { Fragment, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { writeClipboard } from '../clipboard.ts'
import {
  StreamingHighlightSession, grammarLoadCount, highlightToHtml, subscribeGrammarLoaded,
} from './highlight.ts'
import type { HighlightSpan } from './highlight.ts'
import css from './CodeBlock.module.css'

export interface CodeBlockProps {
  /** The source text, rendered verbatim (trailing newline trimmed for display). */
  code: string
  /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
  lang?: string | undefined
  /** Highlight a growing fence incrementally while preserving completed-line DOM. */
  streaming?: boolean | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
  /** Copy-button idle label; the owner passes localized copy (this package is cordis-free, so copy arrives via props). */
  copyLabel?: string | undefined
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel?: string | undefined
}

const SHIKI_PRE_PROPS = {
  className: 'shiki css-variables',
  style: { backgroundColor: 'var(--shiki-background)', color: 'var(--shiki-foreground)' },
  tabIndex: 0,
} as const

export function CodeBlock({
  code,
  lang,
  streaming,
  className,
  copyLabel = '复制',
  copiedLabel = '复制成功',
}: CodeBlockProps) {
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  // Re-render when a lazy grammar finishes loading, so a fence that showed plain
  // text while its language's grammar imported picks up highlighting. The
  // snapshot value is opaque; only its change across renders drives the memo.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const html = useMemo(
    () => (streaming === true ? undefined : highlightToHtml(trimmed, lang)),
    [streaming, trimmed, lang, loaded],
  )
  const sessionRef = useRef<StreamingHighlightSession | null>(null)
  const lineCacheRef = useRef<{ lines: readonly HighlightSpan[][]; elements: ReactNode[] } | null>(null)
  const streamedBody = useMemo(() => {
    if (streaming !== true) {
      sessionRef.current = null
      lineCacheRef.current = null
      return undefined
    }
    sessionRef.current ??= new StreamingHighlightSession()
    const lines = sessionRef.current.update(trimmed, lang)
    if (lines === undefined) {
      lineCacheRef.current = null
      return undefined
    }
    const previous = lineCacheRef.current
    const elements = lines.map((line, index) => previous !== null && previous.lines[index] === line
      ? previous.elements[index]
      : (
        <Fragment key={index}>
          {index > 0 && '\n'}
          <span className="line">
            {line.map((span, spanIndex) => <span key={spanIndex} style={span.style}>{span.text}</span>)}
          </span>
        </Fragment>
      ))
    lineCacheRef.current = { lines, elements }
    return <pre {...SHIKI_PRE_PROPS}><code>{elements}</code></pre>
  }, [streaming, trimmed, lang, loaded])
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(() => {
    if (copied) return
    /* v8 ignore next -- both arms always mount a <pre>; trimmed is the
       typed fallback if the DOM shape ever diverges. */
    const text = rootRef.current?.querySelector('pre')?.textContent ?? trimmed
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, trimmed])

  const body = streamedBody !== undefined
    ? streamedBody
    : html === undefined
      ? (
        <pre className={css.plain}><code>{trimmed}</code></pre>
      )
      : (
    // shiki's output is a static span tree it generated from `code` (no user
    // HTML passes through), the sanctioned innerHTML consumption path per
    // shiki's own docs.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )

  return (
    <div ref={rootRef} className={clsx(css.block, 'md-code-block', className)}>
      <div className={css.bannerWrap}>
        <div className={css.banner}>
          <div className={css.infostring}>{lang ?? ''}</div>
          <div className={css.action}>
            <button type="button" className={css.copyButton} onClick={onCopy}>
              {copied ? copiedLabel : copyLabel}
            </button>
          </div>
        </div>
      </div>
      {body}
    </div>
  )
}
