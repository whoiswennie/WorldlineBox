import { expect, it } from 'vitest';
import { messageSchema } from '../../src/shared/companions';
import { appendCognitionEvents, CognitionEventProducerFailure, type CognitionEventAppendReceipt } from '../fixtures/cognition-event-producer';

it('bounds eight actual-port calls and keeps dispatch/return identities through out-of-order completion', async () => {
  const receipts: CognitionEventAppendReceipt[] = []; let active = 0, peak = 0, sequence = 0;
  const summary = await appendCognitionEvents({ start: 0, end: 24, concurrency: 8, conversationId: 'private-alice', content: index => `event_${index}`,
    request: async command => {
      active++; peak = Math.max(peak, active); const current = ++sequence;
      await new Promise(resolve => setTimeout(resolve, current % 8 === 1 ? 20 : 0)); active--;
      return { ok: true, inserted: true, message: messageSchema.parse({ id: `message_${current}`, conversationId: command.message.conversationId,
        authorId: command.message.authorId, content: command.message.content, kind: 'text', status: 'sent',
        createdAt: '2026-10-29T00:00:00Z', revision: 1, sequence: current, attachments: [] }) };
    }, record: async receipt => { receipts.push(receipt); } });
  expect(summary).toMatchObject({ dispatched: 24, committed: 24, unconfirmed: 0, peakInFlight: 8 }); expect(peak).toBe(8);
  expect(receipts.map(receipt => receipt.index).toSorted((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, index) => index));
  expect(receipts.every(receipt => receipt.sequence === receipt.dispatchOrdinal && receipt.index + 1 === receipt.dispatchOrdinal && receipt.revision === 1)).toBe(true);
  expect(receipts[0]!.completionOrdinal).toBe(1); expect(receipts[0]!.dispatchOrdinal).not.toBe(1); expect(summary.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
});

it('stops dispatch after a failed append while draining and recording all eight already dispatched results', async () => {
  const receipts: CognitionEventAppendReceipt[] = []; let calls = 0;
  const running = appendCognitionEvents({ start: 0, end: 1000, concurrency: 8, conversationId: 'private-alice', content: index => `event_${index}`,
    request: async command => {
      const current = ++calls; await new Promise(resolve => setTimeout(resolve, current === 1 ? 0 : 15));
      if (current === 1) throw new Error('Actual port outcome unavailable');
      return { ok: true, inserted: true, message: messageSchema.parse({ id: `message_${current}`, conversationId: command.message.conversationId,
        authorId: command.message.authorId, content: command.message.content, kind: 'text', status: 'sent',
        createdAt: '2026-10-29T00:00:00Z', revision: 1, sequence: current, attachments: [] }) };
    }, record: async receipt => { receipts.push(receipt); } });
  await expect(running).rejects.toBeInstanceOf(CognitionEventProducerFailure);
  expect(calls).toBe(8); expect(receipts).toHaveLength(8); expect(receipts.filter(receipt => receipt.outcome === 'committed')).toHaveLength(7);
  expect(receipts.filter(receipt => receipt.outcome === 'unconfirmed')).toHaveLength(1);
});
