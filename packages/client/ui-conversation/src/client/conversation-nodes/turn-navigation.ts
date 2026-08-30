import type {
  ChatLocationNodeIndex, ChatNodeStore, TurnNavigationItem,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '../contract/chat-nodes.ts'

const PREVIEW_LIMIT = 160

function preview(parts: Iterable<string>): string {
  let text = ''
  for (const part of parts) {
    text += text === '' ? part : ` ${part}`
    if (text.length >= PREVIEW_LIMIT) break
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LIMIT)
}

function promptText(node: ChatNode): string {
  if (node.kind !== 'user') return ''
  return preview(node.data.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

function responseText(node: ChatNode): string {
  if (node.kind !== 'assistant-step') return ''
  return preview(node.data.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []))
}

/**
 * Same turn navigation item.
 * @param left - left value.
 * @param right - right value.
 * @returns The resulting value.
 */
export function sameTurnNavigationItem(
  left: TurnNavigationItem | undefined,
  right: TurnNavigationItem | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.turn === right.turn && left.anchorKey === right.anchorKey
    && left.prompt === right.prompt && left.response === right.response
}

/**
 *  Derive one bounded navigation preview from the already-indexed loaded turn.
 * @param turn - turn value.
 * @param locations - locations value.
 * @param nodes - nodes value.
 * @returns The resulting value.
 */
export function turnNavigationItem(
  turn: number,
  locations: ChatLocationNodeIndex,
  nodes: ChatNodeStore,
): TurnNavigationItem | undefined {
  const loaded = locations.getTurn(turn)
    .map(key => nodes.get(key) as ChatNode | undefined)
    .filter((node): node is ChatNode => node !== undefined && node.visibility === 'visible')
  const user = loaded.find(node => node.kind === 'user')
  const anchor = user ?? loaded[0]
  if (anchor === undefined) return undefined
  const response = loaded.findLast(node => responseText(node) !== '')
  return {
    turn,
    anchorKey: anchor.key,
    prompt: user === undefined ? '' : promptText(user),
    response: response === undefined ? '' : responseText(response),
  }
}
