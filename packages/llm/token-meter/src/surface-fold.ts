/** Route-repriceable positional surface fold. */

import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { estimateMessage, estimateStructuralBlock } from './estimate.ts'

/** One priced surface node with the image occurrences route pricing replaces. */
export interface MeterSurfaceNode {
  readonly seq: number
  readonly heuristicTokens: number
  readonly imageFreeTokens: number
  readonly images: readonly ImageAttachmentRef[]
}

/** One validated surface transition that has not mutated the priced surface yet. */
export interface SurfaceTokenPlan {
  readonly tokens: number
  readonly deltaTokens: number
  readonly node: MeterSurfaceNode
  readonly target: 'append' | { readonly startIdx: number; readonly endIdx: number }
}

function collectImages(blocks: readonly ContentBlock[], images: ImageAttachmentRef[]): number {
  let structuralTokens = 0
  for (const block of blocks) {
    if (block.type === 'image') {
      images.push(block.attachment)
      structuralTokens += estimateStructuralBlock(block)
    } else if (block.type === 'tool-result') {
      structuralTokens += collectImages(block.content, images)
    }
  }
  return structuralTokens
}

function analyzeNode(seq: number, message: Message | null): MeterSurfaceNode {
  if (message === null) return { seq, heuristicTokens: 0, imageFreeTokens: 0, images: [] }
  const heuristicTokens = estimateMessage(message)
  const images: ImageAttachmentRef[] = []
  const imageStructuralTokens = collectImages(message.content, images)
  return {
    seq,
    heuristicTokens,
    imageFreeTokens: heuristicTokens - imageStructuralTokens,
    images,
  }
}

/**
* Validate and price one surface event without mutating the surface.
* @param nodes - the priced surface preceding this event, in model-visible order.
* @param event - the surface event to place.
* @returns the plan for {@link commitSurfaceTokens}.
* @throws when a replacement names a range absent from `nodes` — committed
*   logs are surface-validated at append time, so an unresolvable range is log
*   corruption and must fail loud rather than skip the event.
*/
export function planSurfaceTokens(
  nodes: readonly MeterSurfaceNode[],
  event: SurfaceEvent,
): SurfaceTokenPlan {
  const node = analyzeNode(event.seq, deriveEventMessage(event))
  const tokens = node.heuristicTokens
  const op = event.surfaceOp
  if (op === 'append') return { tokens, deltaTokens: tokens, node, target: 'append' }
  const startIdx = nodes.findIndex(candidate => candidate.seq === op.start)
  const endIdx = nodes.findIndex(candidate => candidate.seq === op.end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(
      `token surface: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`,
    )
  }
  const removed = nodes.slice(startIdx, endIdx + 1)
    .reduce((total, candidate) => total + candidate.heuristicTokens, 0)
  return { tokens, deltaTokens: tokens - removed, node, target: { startIdx, endIdx } }
}

/**
* Apply one validated plan to the priced surface in place; infallible, so it
* cannot leave a half-applied surface behind.
* @param nodes - the exact priced surface the plan was built against.
* @param plan - the transition returned by {@link planSurfaceTokens}.
*/
export function commitSurfaceTokens(nodes: MeterSurfaceNode[], plan: SurfaceTokenPlan): void {
  if (plan.target === 'append') {
    nodes.push(plan.node)
    return
  }
  nodes.splice(plan.target.startIdx, plan.target.endIdx - plan.target.startIdx + 1, plan.node)
}
