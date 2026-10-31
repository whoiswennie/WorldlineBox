import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { COGNITION_EVENT_SCALE_STAGES, cognitionHttpWireInput, cognitionScaleOriginalEvent } from '../fixtures/cognition-event-scale';

it('pre-registers independent raw-event stages without claiming that every raw event is an encoded memory', () => {
  expect(COGNITION_EVENT_SCALE_STAGES).toEqual([1000, 10000, 100000]);
  expect(cognitionScaleOriginalEvent(0)).not.toBe(cognitionScaleOriginalEvent(99999));
  expect(cognitionScaleOriginalEvent(99999)).toContain('不代表已经编码成日记、知识或本人认识');
});
it('observes exact incoming provider bytes even when HTTP chunks split multibyte Chinese and emoji', () => {
  const text = JSON.stringify({ messages: [{ role: 'user', content: '原始中文🎣不会因HTTP分块变化。'.repeat(10000) }] }), bytes = Buffer.from(text);
  const cuts = [bytes.indexOf(Buffer.from('中')) + 1, bytes.indexOf(Buffer.from('🎣')) + 2, 65536];
  const chunks: Buffer[] = []; let offset = 0;
  for (const cut of cuts) { chunks.push(bytes.subarray(offset, cut)); offset = cut; } chunks.push(bytes.subarray(offset));
  expect(chunks.map(chunk => chunk.toString()).join('')).not.toBe(text);
  expect(cognitionHttpWireInput(chunks)).toEqual({ text, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
});
