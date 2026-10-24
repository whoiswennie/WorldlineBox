import { z } from 'zod';

export const COMPANION_SUBMIT_RESULT_TOOL = 'companion_submit_result';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const companionFinalProposalSchema = z.strictObject({ callId: z.string().min(1).max(200), schemaDigest: digest });
export type CompanionFinalProposal = z.infer<typeof companionFinalProposalSchema>;
export interface CompanionFinalProposalTurn {
  rawText: string;
  calls: readonly { id: string; name: string; arguments: string; thoughtSignature?: string }[];
  finalProposal?: CompanionFinalProposal;
  results?: readonly { callId: string; content: string }[];
}

/** Only the host adds this marker after offering the actual final schema. */
export function isCompanionFinalTurn(turn: Pick<CompanionFinalProposalTurn, 'calls' | 'finalProposal'>): boolean {
  return turn.calls.length === 0 || turn.finalProposal !== undefined;
}
/** Preserve legacy hashes and bind every original native call, including a
 * rejected mixed turn. Never substitute arguments for assistant body bytes. */
export function companionFinalProposalBytes(turn: CompanionFinalProposalTurn): string {
  return turn.finalProposal ? JSON.stringify([turn.finalProposal, turn.rawText, turn.calls]) : turn.rawText;
}

/** The original proposal payload, shared by validation and later domain reads.
 * This does not rewrite provider body bytes or turn submission into execution. */
export function companionFinalProposalJsonText(turn: CompanionFinalProposalTurn): string {
  if (!turn.finalProposal) return turn.rawText.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim();
  if (turn.calls.length !== 1 || turn.calls[0]?.id !== turn.finalProposal.callId || turn.calls[0].name !== COMPANION_SUBMIT_RESULT_TOOL)
    throw new Error('最终提案必须单独调用一次，不能与其他能力或多次提交混在同一轮；本轮所有调用均未执行。');
  return turn.calls[0].arguments;
}

export const companionFinalProposalReceiptSchema = z.strictObject({
  schema: z.literal('worldlinebox.companion-final-proposal-receipt-v1'),
  status: z.enum(['accepted_for_domain_commit', 'rejected_before_execution']),
  proposalChecksum: digest, callId: z.string().min(1).max(200), finalCallId: z.string().min(1).max(200), schemaDigest: digest,
  reason: z.string().min(1).max(2000).optional(),
}).superRefine((receipt, context) => {
  if (receipt.status === 'rejected_before_execution' && !receipt.reason)
    context.addIssue({ code: 'custom', path: ['reason'], message: '被拒提案必须保留宿主校验原因。' });
  if (receipt.status === 'accepted_for_domain_commit' && receipt.reason !== undefined)
    context.addIssue({ code: 'custom', path: ['reason'], message: '待领域提交的有效提案不能带拒绝原因。' });
});
export type CompanionFinalProposalReceipt = z.infer<typeof companionFinalProposalReceiptSchema>;
export type CompanionFinalProposalReceiptStatus = CompanionFinalProposalReceipt['status'];

export function companionFinalProposalResults(turn: CompanionFinalProposalTurn, proposalChecksum: string,
  status: CompanionFinalProposalReceiptStatus, reason?: string): Array<{ callId: string; content: string }> {
  if (!turn.finalProposal || !turn.calls.some(call => call.id === turn.finalProposal!.callId && call.name === COMPANION_SUBMIT_RESULT_TOOL)
    || new Set(turn.calls.map(call => call.id)).size !== turn.calls.length
    || status === 'accepted_for_domain_commit' && turn.calls.length !== 1) throw new Error('最终提案回执必须对应真实、独立的宿主最终调用。');
  return turn.calls.map(call => ({ callId: call.id, content: JSON.stringify(companionFinalProposalReceiptSchema.parse({
    schema: 'worldlinebox.companion-final-proposal-receipt-v1', status, proposalChecksum, callId: call.id,
    finalCallId: turn.finalProposal!.callId, schemaDigest: turn.finalProposal!.schemaDigest, ...(reason !== undefined ? { reason } : {}),
  })) }));
}
export function companionFinalProposalReceipt(turn: CompanionFinalProposalTurn, status: CompanionFinalProposalReceiptStatus,
  proposalChecksum: string, reason?: string): Array<{ callId: string; content: string }> {
  return companionFinalProposalResults(turn, proposalChecksum, status, reason);
}

/** A validation receipt is protocol pairing, never a dispatched capability or
 * proof that the proposed domain action has actually committed. */
export function companionFinalProposalReceiptStatus(turn: CompanionFinalProposalTurn): CompanionFinalProposalReceiptStatus | undefined {
  if (!turn.finalProposal || !turn.results || turn.results.length !== turn.calls.length
    || !turn.calls.length || new Set(turn.calls.map(call => call.id)).size !== turn.calls.length
    || !turn.calls.some(call => call.id === turn.finalProposal!.callId && call.name === COMPANION_SUBMIT_RESULT_TOOL)
    || new Set(turn.results.map(result => result.callId)).size !== turn.results.length) return;
  let first: CompanionFinalProposalReceipt | undefined;
  for (const call of turn.calls) {
    const result = turn.results.find(result => result.callId === call.id);
    let receipt: CompanionFinalProposalReceipt;
    try { receipt = companionFinalProposalReceiptSchema.parse(JSON.parse(result?.content ?? '')); } catch { return; }
    if (receipt.callId !== call.id || receipt.finalCallId !== turn.finalProposal.callId || receipt.schemaDigest !== turn.finalProposal.schemaDigest
      || first && (receipt.status !== first.status || receipt.proposalChecksum !== first.proposalChecksum || receipt.reason !== first.reason)) return;
    first ??= receipt;
  }
  if (first?.status === 'accepted_for_domain_commit' && turn.calls.length !== 1) return;
  return first?.status;
}
