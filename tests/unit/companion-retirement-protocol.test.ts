import { expect, it } from 'vitest';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionResetSchema } from '../../src/shared/companion-reset';

it('accepts explicit identity retirement and rejects the removed same-identity reset wire protocol', () => {
  expect(companionsRequestSchema.safeParse({ type: 'companion.retire', id: 'alice', scope: 'all', expectedRevision: 1 }).success).toBe(true);
  expect(companionsRequestSchema.safeParse({ type: 'companion.reset', id: 'alice', scope: 'all' }).success).toBe(false);
  const job = { id: 'job', companionId: 'alice', scope: 'all', status: 'running', phase: 'stopping', processed: 0, startedAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' };
  expect(companionResetSchema.safeParse(job).success).toBe(false);
  expect(companionResetSchema.safeParse({ ...job, operation: 'retire_identity' }).success).toBe(true);
});
