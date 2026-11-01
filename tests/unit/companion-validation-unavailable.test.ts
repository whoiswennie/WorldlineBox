import { expect, it, vi } from 'vitest';
import { CompanionValidationUnavailableError, companionHostValidationUnavailable, companionValidationUnavailable } from '../../src/main/companions/validation-unavailable';
import { CompanionMemoryFilesPending } from '../../src/main/companions/memory-files-pending';
import { CompanionKnowledgeService } from '../../src/main/companions/knowledge-service';

it('separates pending, lifecycle, cancellation and transport availability from proven missing/changed files', () => {
  for (const error of [new CompanionValidationUnavailableError('Closed.'), new DOMException('Stopped.', 'AbortError'),
    new CompanionMemoryFilesPending(), Object.assign(new Error('Busy.'), { code: 'SQLITE_BUSY' }),
    Object.assign(new Error('Cannot read now.'), { code: 'EACCES' })]) {
    expect(companionValidationUnavailable(error)).toBe(true);
    expect(companionValidationUnavailable(new Error('Wrapped file validation.', { cause: error }))).toBe(true);
  }
  expect(companionValidationUnavailable(Object.assign(new Error('Committed file missing.'), { code: 'ENOENT' }))).toBe(false);
  expect(companionValidationUnavailable(Object.assign(new Error('Actual bytes changed.'), { code: 'MEMORY_FILE_CHANGED' }))).toBe(false);
});

it('defers paid capture only for trusted host infrastructure availability, including its wrapped cause', () => {
  const unavailable = new CompanionValidationUnavailableError('Host transport closed.');
  expect(companionHostValidationUnavailable(unavailable)).toBe(true);
  expect(companionHostValidationUnavailable(new Error('Wrapped host operation.', { cause: unavailable }))).toBe(true);
  for (const code of ['NETWORK', 'TIMEOUT', 'RATE_LIMIT', 'CANCELLED'])
    expect(companionHostValidationUnavailable(Object.assign(new Error('Provider refusal.'), { code }))).toBe(false);
});

it.each([true, false])('does not describe an unavailable or paused knowledge read as source revocation (paused=%s)', async paused => {
  const service = new CompanionKnowledgeService({ request: vi.fn(), blocked: () => paused });
  await expect(service.execute({ type: 'memory.knowledge', operation: 'read', companionId: 'alice', conversationId: 'room',
    id: 'cold_message_' + 'a'.repeat(48), version: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'EXECUTION_VALIDATION_UNAVAILABLE' });
});
