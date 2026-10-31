import { createHash } from 'node:crypto';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface CognitionEventAppendReceipt {
  index: number; dispatchOrdinal: number; completionOrdinal: number; requestHash: string; elapsedMs: number;
  outcome: 'committed' | 'unconfirmed'; messageId?: string; sequence?: number; revision?: number; responseHash?: string; error?: string;
}
export interface CognitionEventProducerSummary {
  concurrency: 8 | 16; dispatched: number; committed: number; unconfirmed: number; receiptFailures: number; peakInFlight: number; receiptHash: string;
}
export class CognitionEventProducerFailure extends Error {
  constructor(readonly summary: CognitionEventProducerSummary) { super('An actual event append was not confirmed; no automatic retry or new dispatch follows.'); }
}

/** Prepared QA producer only. Every event still crosses the ordinary Main
 * message.append port; no batch API, SQL write or product quota is introduced. */
export async function appendCognitionEvents(input: {
  start: number; end: number; concurrency: 8 | 16; conversationId: string; content(index: number): string;
  request(command: Extract<CompanionStorageCommand, { type: 'message.append' }>): Promise<CompanionStorageResponse>;
  record(receipt: CognitionEventAppendReceipt): Promise<void>;
}): Promise<CognitionEventProducerSummary> {
  if (!Number.isSafeInteger(input.start) || input.start < 0 || !Number.isSafeInteger(input.end) || input.end < input.start || ![8, 16].includes(input.concurrency)) throw new Error('Invalid bounded QA append range');
  const summary: CognitionEventProducerSummary = { concurrency: input.concurrency, dispatched: 0, committed: 0, unconfirmed: 0, receiptFailures: 0, peakInFlight: 0, receiptHash: '' };
  const receipts = createHash('sha256'); let next = input.start, active = 0, completionOrdinal = 0, failed = false;
  await Promise.all(Array.from({ length: input.concurrency }, async () => {
    while (!failed && next < input.end) {
      const index = next++, dispatchOrdinal = ++summary.dispatched, content = input.content(index), started = performance.now();
      const command = { type: 'message.append' as const, message: { conversationId: input.conversationId, authorId: 'user', content, clientId: `event-scale-${index}`, replyDirective: 'none' as const } };
      const receipt: CognitionEventAppendReceipt = { index, dispatchOrdinal, completionOrdinal: 0, requestHash: hash(command), elapsedMs: 0, outcome: 'unconfirmed' };
      active++; summary.peakInFlight = Math.max(summary.peakInFlight, active);
      try {
        const response = await input.request(command), message = response.message;
        if (!response.ok || !response.inserted || !message?.revision || message.conversationId !== input.conversationId || message.authorId !== 'user'
          || message.content !== content || !Number.isSafeInteger(message.sequence)) throw new Error(response.error ?? 'Actual new source event receipt does not match its dispatched input');
        Object.assign(receipt, { outcome: 'committed', messageId: message.id, sequence: message.sequence, revision: message.revision,
          responseHash: hash([message.id, message.sequence, message.revision, message.conversationId, message.authorId, message.content]) }); summary.committed++;
      } catch (error) { failed = true; summary.unconfirmed++; receipt.error = String(error).slice(0, 1000); }
      finally { active--; receipt.completionOrdinal = ++completionOrdinal; receipt.elapsedMs = performance.now() - started; }
      // Serial writes belong to the caller's bounded append-only receipt sink.
      // All already dispatched requests settle even after one fails.
      try { await input.record(receipt); receipts.update(JSON.stringify(receipt)); }
      catch { failed = true; summary.receiptFailures++; }
    }
  }));
  summary.receiptHash = receipts.digest('hex');
  if (failed) throw new CognitionEventProducerFailure(summary);
  return summary;
}
