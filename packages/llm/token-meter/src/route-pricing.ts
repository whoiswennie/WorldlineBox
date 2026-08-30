/** Price a replay surface under an exact model route's image policy. */

import type { LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { estimateContent } from './estimate.ts'
import type { MeterSurfaceNode } from './surface-fold.ts'
import type { TokenSurfaceNode } from './types.ts'

/** One surface priced for a request route: public nodes plus their total. */
export interface PricedSurface {
  readonly nodes: TokenSurfaceNode[]
  readonly surfaceTokens: number
}

/**
* Price one ordered surface under a route's request-image pricing.
* @param nodes - the fold's current or snapshotted surface, in model-visible order.
* @param pricing - the routed model's image pricing, or undefined to keep the fixed heuristic.
* @returns detached public nodes and their route-priced total.
* @throws when the pricing answers a different occurrence count than it was
*   asked — misalignment would silently misprice nodes, so it must fail loud.
*/
export function priceSurface(
  nodes: readonly MeterSurfaceNode[],
  pricing: LlmImageRequestPricing | undefined,
): PricedSurface {
  const images = pricing === undefined ? [] : nodes.flatMap(node => node.images)
  if (pricing === undefined || images.length === 0) {
    let surfaceTokens = 0
    const publicNodes = nodes.map((node) => {
      surfaceTokens += node.heuristicTokens
      return { seq: node.seq, tokens: node.heuristicTokens, heuristicTokens: node.heuristicTokens }
    })
    return { nodes: publicNodes, surfaceTokens }
  }
  const prices = pricing.priceImages(images)
  if (prices.length !== images.length) {
    throw new Error(
      `token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`,
    )
  }
  let cursor = 0
  let surfaceTokens = 0
  const publicNodes = nodes.map((node) => {
    let tokens = node.heuristicTokens
    if (node.images.length > 0) {
      tokens = node.imageFreeTokens
      for (let occurrence = 0; occurrence < node.images.length; occurrence += 1) {
        const price = prices[cursor]
        if (price === undefined) throw new Error('token meter: missing route image price')
        cursor += 1
        tokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }])
      }
    }
    surfaceTokens += tokens
    return { seq: node.seq, tokens, heuristicTokens: node.heuristicTokens }
  })
  return { nodes: publicNodes, surfaceTokens }
}
