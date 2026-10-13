import type { DshLauncherRequest, DshOperation } from '../../shared/dsh-launcher';

export interface OperationNotifications {
  readonly initialized: boolean;
  readonly seen: Readonly<Record<string, DshOperation['status']>>;
  readonly failures: readonly DshOperation[];
}

export const initialOperationNotifications: OperationNotifications = { initialized: false, seen: {}, failures: [] };

export type OperationNotificationAction =
  | { type: 'observe'; operations: readonly DshOperation[] }
  | { type: 'dismiss'; operationId: string }
  | { type: 'request'; request: DshLauncherRequest };

function sameOperation(a: Pick<DshOperation, 'kind' | 'instanceId' | 'retryRequest'>, b: Pick<DshOperation, 'kind' | 'instanceId' | 'retryRequest'>): boolean {
  return a.kind === b.kind && a.instanceId === b.instanceId
    && (!a.retryRequest || !b.retryRequest || JSON.stringify(a.retryRequest) === JSON.stringify(b.retryRequest));
}

/** Persistent journals are history. Only failures observed after the first snapshot become notifications. */
export function operationNotificationsReducer(previous: OperationNotifications, action: OperationNotificationAction): OperationNotifications {
  if (action.type === 'dismiss') return { ...previous, failures: previous.failures.filter(operation => operation.id !== action.operationId) };
  if (action.type === 'request') {
    if (action.request.type === 'operation.retry') {
      const operationId = action.request.operationId;
      return { ...previous, failures: previous.failures.filter(operation => operation.id !== operationId) };
    }
    const request = action.request;
    const attempt = { kind: request.type, instanceId: 'instanceId' in request ? request.instanceId : undefined,
      retryRequest: request.type === 'runtime.install' || request.type === 'runtime.download' || request.type === 'pack.import-url' ? request : undefined };
    return { ...previous, failures: previous.failures.filter(operation => !sameOperation(operation, attempt)) };
  }
  const seen = { ...previous.seen };
  for (const operation of action.operations) seen[operation.id] = operation.status;
  if (!previous.initialized) return { initialized: true, seen, failures: [] };
  const visible = new Set(previous.failures.map(operation => operation.id));
  const failures = action.operations.filter((operation, index, operations) => {
    if (operation.status !== 'failed' && operation.status !== 'interrupted') return false;
    if (!visible.has(operation.id) && previous.seen[operation.id] === operation.status) return false;
    // The newest-first journal includes retries started outside this renderer, too.
    return !operations.slice(0, index).some(newer => sameOperation(operation, newer));
  });
  return { initialized: true, seen, failures };
}
