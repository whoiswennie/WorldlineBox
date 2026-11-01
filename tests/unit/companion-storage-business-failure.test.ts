import { expect, it } from 'vitest';
import { companionStorageBusinessFailure } from '../../src/shared/companion-storage-failure';
import { companionStorageReplySchema } from '../../src/shared/companion-storage';

it.each(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_IOERR_READ', 'EXECUTION_VALIDATION_UNAVAILABLE'])(
  'preserves coded %s availability outside the ordinary domain response', code => {
    const failure = Object.assign(new Error('actual host reader unavailable'), { code });
    const result = companionStorageBusinessFailure(new Error('wrapped reader unavailable', { cause: failure }));
    expect(result).toEqual({ response: { ok: false, error: 'wrapped reader unavailable' }, storageFailure: { kind: 'unavailable' } });
    expect(companionStorageReplySchema.parse({ requestId: 'actual_request', ...result }).storageFailure).toEqual({ kind: 'unavailable' });
  });

it('does not derive availability from prose, constraints or ordinary authorization and missing-object denials', () => {
  for (const error of [new Error('SQLITE_BUSY is part of source prose'), new Error('行动不存在。'), new Error('来源已撤回。'),
    Object.assign(new Error('constraint denied'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })]) {
    expect(companionStorageBusinessFailure(error)).toEqual({ response: { ok: false, error: error.message } });
  }
  const cycle = new Error('ordinary failure'); cycle.cause = cycle;
  expect(companionStorageBusinessFailure(cycle).storageFailure).toBeUndefined();
  expect(companionStorageReplySchema.safeParse({ requestId: 'actual_request', response: { ok: true }, storageFailure: { kind: 'unavailable' } }).success).toBe(false);
  expect(companionStorageReplySchema.parse({ requestId: 'legacy_request', response: { ok: false, error: 'ordinary denial' } })).toEqual({ requestId: 'legacy_request', response: { ok: false, error: 'ordinary denial' } });
});
