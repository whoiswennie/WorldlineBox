import { expect, it } from 'vitest';
import { parseCompanionActivityDecision } from '../../src/main/companions/activity-output-contract';

it('identifies the actual topic/wait conflict without quoting private arguments or normalizing the proposal', () => {
  const proposal = { status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'private_peer' },
    topic: { action: 'read', topicId: 'private_topic' }, summary: 'PRIVATE_PROPOSAL_BODY' };
  const before = JSON.stringify(proposal);
  let error: Error | undefined;
  try { parseCompanionActivityDecision(proposal); } catch (caught) { error = caught as Error; }
  expect(error?.message).toContain('"path":"topic","code":"topic_must_be_separate","conflicts":["wait"]');
  expect(error?.message).toContain('action与wait仍允许');
  expect(error?.message).not.toMatch(/private_peer|private_topic|PRIVATE_PROPOSAL_BODY/u);
  expect(JSON.stringify(proposal)).toBe(before);
});

it('keeps a legitimate action plus wait and rejects memory or terminal effects through the original rules', () => {
  const proposal = { status: 'continue', action: { action: 'query', category: 'contacts', limit: 5 },
    wait: { kind: 'delay', seconds: 30 }, summary: '真实查询后按原规则等待' };
  expect(parseCompanionActivityDecision(proposal)).toMatchObject(proposal);
  expect(() => parseCompanionActivityDecision({ ...proposal, memory: { operation: 'search', query: 'PRIVATE_QUERY' } }))
    .toThrow('COMPANION_MEMORY_AUTOMATIC_ONLY');
  expect(() => parseCompanionActivityDecision({ ...proposal, status: 'complete' })).toThrow('terminal_has_pending_effects');
  expect(() => parseCompanionActivityDecision({ status: 'continue', action: null, wait: null, summary: '空计划' }))
    .toThrow('continue_requires_operation');
});
