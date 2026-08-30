import type { AssistantBlock } from '@deepseek-ai/dsh-client-runtime/client'

/**
 *  True when Assistant blocks contain user-facing reply content.
 * @param blocks - blocks value.
 * @returns The resulting value.
 */
export function hasAssistantReplyContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'reasoning' || block.kind === 'tool-call') return false
    if (block.kind === 'text') return block.text.trim() !== ''
    return true
  })
}
