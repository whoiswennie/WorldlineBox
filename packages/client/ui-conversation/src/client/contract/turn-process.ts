import type { ChatNode } from './chat-nodes.ts'

/**
 * Type contract for turn process signature.
 * @returns The resulting value.
 */
export type TurnProcessSignature = string
/**
 * Type contract for turn process generation.
 * @returns The resulting value.
 */
export type TurnProcessGeneration = string

/**
 * Contract for turn process spec.
 */
export interface TurnProcessSpec {
  readonly turn: number
  readonly controlAnchorSeq: number
  readonly processStartSeq: number
  readonly answerAnchorSeq: number | null
  readonly answerStep: number | null
  readonly inlineReasoning: boolean
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
}

const independentKinds: readonly string[] = [
  'user', 'steering', 'turn-process', 'turn-error', 'turn-max-tokens', 'turn-tail',
  // Worldline room speech and references are answer-plane content even when an independent
  // companion emits them while the coordinator's dispatch tool is still open.
  'companion-stream', 'companion-reference', 'companion-membership',
]

/**
 * Turn process independent kinds.
 * @returns The resulting value.
 */
export const TURN_PROCESS_INDEPENDENT_KINDS: ReadonlySet<string> = new Set(independentKinds)

/**
 * Test whether a node is answer-plane content that must remain outside the process disclosure.
 * Reference delivery is represented by the `express` tool's result card for ordinary Agents, so
 * that one tool root is independent while diagnostic and implementation tools remain foldable.
 * @param node - Projected chat node being classified.
 * @returns Whether the node must remain visible outside the process disclosure.
 */
export function isTurnProcessIndependentNode(node: ChatNode): boolean {
  if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) return true
  if (node.kind !== 'tool-call') return false
  const root = node.data.root
  const name = 'kind' in root ? root.call?.name : root.name
  return name === 'express'
}

/**
 * Turn process generation.
 * @param spec - spec value.
 * @returns The resulting value.
 */
export function turnProcessGeneration(spec: TurnProcessSpec): TurnProcessGeneration {
  return `${String(spec.turn)}|${spec.answerStep === null ? '' : String(spec.answerStep)}`
}

/**
 * Encode turn process.
 * @param spec - spec value.
 * @returns The resulting value.
 */
export function encodeTurnProcess(spec: TurnProcessSpec): TurnProcessSignature {
  return [
    spec.turn,
    spec.controlAnchorSeq,
    spec.processStartSeq,
    spec.answerAnchorSeq ?? '',
    spec.answerStep ?? '',
    spec.inlineReasoning ? 1 : 0,
    spec.messageCount,
    spec.toolCallCount,
    spec.subagentCount,
  ].join('|')
}

/**
 * Decode turn process.
 * @param signature - signature value.
 * @returns The resulting value.
 */
export function decodeTurnProcess(signature: TurnProcessSignature): TurnProcessSpec {
  const [
    turn, controlAnchorSeq, processStartSeq, answerAnchorSeq, answerStep, inlineReasoning,
    messageCount, toolCallCount, subagentCount,
  ] = signature.split('|')
  return {
    turn: Number(turn),
    controlAnchorSeq: Number(controlAnchorSeq),
    processStartSeq: Number(processStartSeq),
    answerAnchorSeq: answerAnchorSeq === '' ? null : Number(answerAnchorSeq),
    answerStep: answerStep === '' ? null : Number(answerStep),
    inlineReasoning: inlineReasoning === '1',
    messageCount: Number(messageCount),
    toolCallCount: Number(toolCallCount),
    subagentCount: Number(subagentCount),
  }
}

/**
 * Is subagent delegation tool.
 * @param name - name value.
 * @returns The resulting value.
 */
export function isSubagentDelegationTool(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}
