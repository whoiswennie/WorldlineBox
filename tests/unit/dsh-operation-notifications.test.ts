import { describe, expect, it } from 'vitest';
import type { DshOperation } from '../../src/shared/dsh-launcher';
import { initialOperationNotifications, operationNotificationsReducer as reduce } from '../../src/renderer/launcher/operation-notifications';

function operation(id: string, status: DshOperation['status'], kind = 'runtime.download', instanceId?: string): DshOperation {
  return { id, kind, instanceId, status, label: id, phase: status, startedAt: '2026-10-12T00:00:00Z', error: status === 'failed' ? id : undefined };
}

describe('DSH current operation notifications', () => {
  it('uses startup records as history and observes an already-running task when it later fails', () => {
    const history = operation('old-invalid-url', 'failed');
    const pending = operation('pending', 'running');
    const baseline = reduce(initialOperationNotifications, { type: 'observe', operations: [pending, history] });
    expect(baseline.failures).toEqual([]);
    const failed = reduce(baseline, { type: 'observe', operations: [{ ...pending, status: 'failed', error: 'new failure' }, history] });
    expect(failed.failures.map(item => item.id)).toEqual(['pending']);
  });

  it('keeps dismissed failures quiet across refresh and module resubscriptions', () => {
    const baseline = reduce(initialOperationNotifications, { type: 'observe', operations: [] });
    const failure = operation('new-failure', 'failed');
    const live = reduce(baseline, { type: 'observe', operations: [failure] });
    const dismissed = reduce(live, { type: 'dismiss', operationId: failure.id });
    expect(reduce(dismissed, { type: 'observe', operations: [failure] }).failures).toEqual([]);
    expect(reduce(dismissed, { type: 'observe', operations: [] }).seen[failure.id]).toBe('failed');
  });

  it('replaces errors for retries but preserves failures from different instances', () => {
    const baseline = reduce(initialOperationNotifications, { type: 'observe', operations: [] });
    const a = operation('a-failed', 'failed', 'instance.start', 'instance-a');
    const b = operation('b-failed', 'failed', 'instance.start', 'instance-b');
    const live = reduce(baseline, { type: 'observe', operations: [a, b] });
    const retry = reduce(live, { type: 'request', request: { type: 'instance.start', instanceId: 'instance-a' } });
    expect(retry.failures.map(item => item.id)).toEqual(['b-failed']);
    const refreshed = reduce(retry, { type: 'observe', operations: [a, b] });
    expect(refreshed.failures.map(item => item.id)).toEqual(['b-failed']);
    const newest = operation('a-retry-failed', 'failed', 'instance.start', 'instance-a');
    const failedRetry = reduce(live, { type: 'observe', operations: [newest, a, b] });
    expect(failedRetry.failures.map(item => item.id)).toEqual(['a-retry-failed', 'b-failed']);
  });

  it('dismisses previous errors when an external retry is running or has succeeded, and when history is cleared', () => {
    const baseline = reduce(initialOperationNotifications, { type: 'observe', operations: [] });
    const old = operation('old-failure', 'failed');
    const live = reduce(baseline, { type: 'observe', operations: [old] });
    for (const status of ['running', 'succeeded'] as const) {
      expect(reduce(live, { type: 'observe', operations: [operation('retry', status), old] }).failures).toEqual([]);
    }
    expect(reduce(live, { type: 'observe', operations: [] }).failures).toEqual([]);
  });
});
