import { describe, expect, it } from 'vitest';
import { assertDshResumeScope } from '../../src/main/dsh/task-scope';

const scope = { actionId: '00000000-0000-4000-8000-000000000000', companionId: 'alice', conversationId: 'private_alice',
  sourceMessageId: 'actual_request', executionReadsetDigest: 'a'.repeat(64) };
describe('native resume proof retains its exact derived dependency set', () => {
  it('requires the original host proof for a typed readset even without a legacy sourceDigest', () => {
    expect(() => assertDshResumeScope(scope, scope)).toThrow('revalidated');
    expect(() => assertDshResumeScope(scope, scope, scope)).not.toThrow();
    expect(() => assertDshResumeScope(scope, scope, { ...scope, executionReadsetDigest: 'b'.repeat(64) })).toThrow('revalidated');
  });
  it('rejects dependency replacement or removal before native session history can replay', () => {
    expect(() => assertDshResumeScope(scope, { ...scope, executionReadsetDigest: 'b'.repeat(64) }, scope)).toThrow('source dependencies');
    expect(() => assertDshResumeScope(scope, { ...scope, executionReadsetDigest: undefined }, scope)).toThrow('source dependencies');
  });
  it('allows a separate authorized action to add inputs after Main proves the original closure, without weakening same-action retries', () => {
    const next = { ...scope, actionId: '00000000-0000-4000-8000-000000000001', sourceMessageId: 'new_user_request', executionReadsetDigest: 'b'.repeat(64) };
    expect(() => assertDshResumeScope(scope, next, scope)).not.toThrow();
    expect(() => assertDshResumeScope(scope, next)).toThrow('revalidated');
    expect(() => assertDshResumeScope(scope, next, { ...scope, executionReadsetDigest: next.executionReadsetDigest })).toThrow('revalidated');
    expect(() => assertDshResumeScope(scope, { ...next, executionReadsetDigest: undefined }, scope)).toThrow('source dependencies');
  });
});
