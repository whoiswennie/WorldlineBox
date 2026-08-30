// Settled-node identity prevents stream-delta updates from rerendering this row.
// Mounted on 'conversation.composer.dock' so it sticks with the composer in the
// active conversation scrollport (see ConversationRoot data-conversation-scroll).

import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConversationSnapshot, PartialAssistant, UseProjection,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ContextBreakdownProjection, TokenUsageProjection,
} from '@deepseek-ai/dsh-token-meter/client'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { ComposerBarProps } from '../contract/slots.ts'
import { formatTokensPerSecond } from './message-chrome.ts'
import { assistantStepReading } from './turn-metrics.ts'
import css from './StatsLine.module.css'
import {
  billedInputTokens, cacheHitPercent, formatTokens,
} from '../contract/stats-format.ts'

export { billedInputTokens, cacheHitPercent, contextOccupancy, formatTokens } from '../contract/stats-format.ts'

interface WindowStats {
  turns: number
  steps: number
  /** Summed request wall time (step/start → assistant/message); 0 when no node carries timing. */
  llmMs: number
  /** Summed tool wall time (tool/call → tool/result); 0 when no pair is in-window. */
  toolMs: number
  /** Summed first-token latency over `ttftSteps`; 0 when no step records it. */
  ttftMs: number
  /** Steps carrying a recorded TTFT. */
  ttftSteps: number
  /** Summed decode wall time over steps that also report output tokens. */
  decodeMs: number
  /** Summed output tokens over the same decode-timed steps. */
  decodeTokens: number
}

const LIVE_TOKEN_BUCKET = 16

/**
 * Low-frequency estimate for the unfinished assistant step. Returning a
 * bucketed primitive lets the snapshot selector suppress most chunk frames;
 * provider usage replaces it as soon as the step reports exact accounting.
 */
export function estimatePartialOutput(partial: PartialAssistant | null | undefined): number {
  if (partial == null) return 0
  let tokens = 0
  for (const block of partial.blocks) {
    switch (block.kind) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / 4) + 4
        break
      case 'tool-call':
        tokens += Math.ceil((block.name.length + block.argsRaw.length) / 4) + 4
        break
      case 'image':
        tokens += 4
        break
      default:
        tokens += Math.ceil(JSON.stringify(block.block).length / 4) + 4
    }
  }
  return tokens === 0 ? 0 : Math.max(1, Math.round(tokens / LIVE_TOKEN_BUCKET) * LIVE_TOKEN_BUCKET)
}

function estimatedRequestInput(breakdown: ContextBreakdownProjection | undefined): number {
  if (breakdown === undefined) return 0
  return breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
}

function liveUsage(
  settled: TokenUsageProjection | undefined,
  breakdown: ContextBreakdownProjection | undefined,
  turn: number | null,
  step: number | null,
  outputTokens: number,
): { usage: TokenUsageProjection | undefined; estimated: boolean } {
  if (turn === null || step === null) return { usage: settled, estimated: false }
  const exact = settled?.lastReportedStep
  if (exact?.turn === turn && exact.step === step) return { usage: settled, estimated: false }
  const inputTokens = estimatedRequestInput(breakdown)
  if (inputTokens === 0 && outputTokens === 0) return { usage: settled, estimated: false }
  return {
    usage: {
      uncachedInputTokens: (settled?.uncachedInputTokens ?? 0) + inputTokens,
      outputTokens: (settled?.outputTokens ?? 0) + outputTokens,
      cacheReadTokens: settled?.cacheReadTokens ?? 0,
      cacheWriteTokens: settled?.cacheWriteTokens ?? 0,
    },
    estimated: true,
  }
}

/**
 * Fold assistant and tool-result nodes into window-scoped display totals —
 * the FALLBACK for assemblies without the `sessionStats` projection.
 *
 * Every displayed figure rides that durable whole-log projection (and token
 * accounting rides `tokenUsage`) because the window is paged and compaction
 * rewrites it; this fold answers "what is on screen" only when no projection
 * value is served. Its field names deliberately mirror the projection's so
 * the two swap wholesale.
 * @param nodes - snapshot nodes.
 * @returns fallback counts and summed wall times.
 */
export function deriveStats(nodes: ConversationSnapshot['nodes']): WindowStats {
  const turns = new Set<number>()
  let steps = 0
  let llmMs = 0
  let toolMs = 0
  let ttftMs = 0
  let ttftSteps = 0
  let decodeMs = 0
  let decodeTokens = 0
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    steps += 1
    if (node.timing !== undefined && node.timing.stepStartTime !== null) {
      llmMs += Math.max(0, node.timing.completedTime - node.timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      ttftMs += reading.ttftMs
      ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      decodeMs += reading.decodeMs
      decodeTokens += reading.outputTokens
    }
  }
  return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }
}

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits).
 * @param n - token count.
 * @returns display string.
 */
/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/**
 * Display-ready cache-hit share of prompt-side input over the whole durable log.
 * @param usage - the session's token-usage projection value.
 * @returns integer text when integer rounding stays below 100, otherwise the
 * minimum decimal precision that still rounds below 100; a full hit returns
 * 100, and no billed input returns null.
 */
/**
 * Approximate context occupancy, using the TUI's integer rounding and upper
 * clamp. The numerator is `projectedTokens` — the provider sample carried
 * forward over the surface's movement since — so compaction shows immediately
 * instead of waiting for the next request to report usage; it falls back to the
 * bare sample only for a log whose projection predates that field. Numerator
 * and capacity remain independent last-wins projection fields, so this is a
 * reference figure rather than an exact measurement of one request (see the
 * token-meter README).
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy with its numerator and denominator, or null until both values are known.
 */
/** Props: the conversation-snapshot selector plus the projection read seat. */
export interface StatsLineProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
  /** The owning dock's locale seat. */
  t: ComposerBarProps['t']
  /** Topbar presentation moves the same durable facts out of the composer dock. */
  placement?: 'composer' | 'topbar'
}

export const StatsLine = memo(function StatsLine({ useSession, useProjection, t, placement = 'composer' }: StatsLineProps) {
  const settledNodes = useSession(s => s.chat.legacy.nodes)
  const usage = useProjection('tokenUsage')
  const breakdown = useProjection('contextBreakdown')
  const activeTurn = useSession(s => s.partial?.turn ?? null)
  const activeStep = useSession(s => s.partial?.step ?? null)
  const liveOutputTokens = useSession(s => estimatePartialOutput(s.partial))
  const accounting = liveUsage(usage, breakdown, activeTurn, activeStep, liveOutputTokens)
  // Every figure rides the durable sessionStats projection, so paging and
  // compaction cannot change any of them; an assembly without the unit falls
  // back to the window-scoped fold wholesale (same field names), paid only
  // while no projection value is served.
  const projected = useProjection('sessionStats')
  const stats = useMemo(() => projected ?? deriveStats(settledNodes), [projected, settledNodes])
  // Topbar facts are separate compact indicators. The composer fallback keeps
  // its historical grouped sentence, but the header must be able to drop
  // lower-priority indicators atomically instead of clipping half a label.
  const metrics: Array<{ key: string; label: string }> = []
  const groups: string[] = []
  if (stats.steps > 0) {
    const counts = t('stats.counts', { turns: stats.turns, steps: stats.steps })
    groups.push(counts)
    metrics.push({ key: 'counts', label: counts })
    const durations: string[] = []
    if (stats.llmMs > 0) {
      const llm = t('stats.llm', { duration: formatDuration(stats.llmMs) })
      durations.push(llm)
      metrics.push({ key: 'llm', label: llm })
    }
    if (stats.toolMs > 0) {
      const tool = t('stats.toolCall', { duration: formatDuration(stats.toolMs) })
      durations.push(tool)
      metrics.push({ key: 'tool', label: tool })
    }
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) {
      const ttft = t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) })
      speeds.push(ttft)
      metrics.push({ key: 'ttft', label: ttft })
    }
    if (stats.decodeMs > 0) {
      const throughput = t('stats.tokensPerSecond', {
        throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
      })
      speeds.push(throughput)
      metrics.push({ key: 'throughput', label: throughput })
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  // Context occupancy deliberately lives on the composer's ContextMeter ring,
  // not here — one home per fact.
  // Billing rides the durable projection, so these survive paging and
  // compaction. Gated on actual token activity: a session whose steps all
  // settled without billing (e.g. every request failed) shows its counts
  // without a zero-token group.
  if (accounting.usage !== undefined
    && (billedInputTokens(accounting.usage) > 0 || accounting.usage.outputTokens > 0)) {
    const cacheHit = usage === undefined ? null : cacheHitPercent(usage)
    if (cacheHit !== null) {
      const cache = t('stats.cacheHit', { percent: cacheHit })
      groups.push(cache)
      metrics.push({ key: 'cache', label: cache })
    }
    const tokens = t(accounting.estimated ? 'stats.tokensEstimated' : 'stats.tokens', {
      input: formatTokens(billedInputTokens(accounting.usage)),
      output: formatTokens(accounting.usage.outputTokens),
    })
    groups.push(tokens)
    metrics.push({ key: 'tokens', label: tokens })
  }
  const line = groups.join(' | ')
  const tooltipLine = line
  // The row elides with ellipsis when overlong; a delayed hover tooltip carries
  // the full line, enabled only while content is actually clipped.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null) return
    const measure = () => { setTruncated(el.scrollWidth > el.clientWidth) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [line])
  if (groups.length === 0) return null
  return (
    <Tooltip label={tooltipLine} side="top" delayMs={500} disabled={!truncated}>
      <div ref={rootRef} className={clsx(css.root, placement === 'topbar' && css.topbar)}>
        {placement === 'topbar' ? metrics.map(metric => (
          <span key={metric.key} className={css.metric} data-metric={metric.key}>{metric.label}</span>
        )) : groups.map((group, i) => (
          <Fragment key={group}>
            {i > 0 && <><span className={css.sep} aria-hidden>|</span>{' '}</>}
            <span>{group}</span>
          </Fragment>
        ))}
      </div>
    </Tooltip>
  )
})

/** The topbar owns presentation only; metric derivation remains the same component. */
export function TopbarStatsLine(props: StatsLineProps) {
  return <StatsLine {...props} placement="topbar" />
}
