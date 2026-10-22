import type { DshLauncher } from '../../src/main/dsh/launcher';
import type { createNativeAcceptanceBroker } from './companion-dsh-native-broker';

/** Only the app transport is local; task execution uses the production native broker. */
export function nativeAcceptanceLauncher(native: Awaited<ReturnType<typeof createNativeAcceptanceBroker>>) {
  const operations = new Map<string, { id: string; status: string; error?: string }>();
  const jobs = new Set<Promise<void>>(), at = new Date().toISOString();
  const dsh = { state: () => ({ tasks: native.broker.state(), operations: [...operations.values()],
    cli: { selectedInstanceId: 'acceptance' }, instances: [{ id: 'acceptance', runtimeId: 'runtime-acceptance', updatedAt: at }],
    runtimes: [{ id: 'runtime-acceptance', version: '0.2.1-rc.2' }], taskAccess: { mode: 'workspace-write' } }),
  taskCapabilities: (instanceId?: string, _execution?: unknown, query?: Parameters<DshLauncher['taskCapabilities']>[2]) => native.broker.discover(instanceId, { ...native.execution, capabilityQuery: query }),
  taskRecordScope: async (recordId: string) => (await native.broker.recordMetadata(recordId)).scope,
  readTaskRecord: (query: Parameters<DshLauncher['readTaskRecord']>[0]) => native.broker.readRecord(query), removeCompanionTaskRecords: async () => undefined,
  requestTask: async (request: Parameters<DshLauncher['requestTask']>[0], execution?: Parameters<DshLauncher['requestTask']>[1]) => {
    if (request.type === 'task.run') {
      const operation = native.operation(); operations.set(operation.id, { id: operation.id, status: 'running' });
      const job = native.broker.execute({ prompt: request.prompt, title: request.title, instanceId: request.instanceId,
        sessionId: request.sessionId, timeoutMs: 240000 }, operation, { ...native.execution, ...execution,
        access: execution?.resume ? execution.access : native.execution.access }).then(() => { operations.get(operation.id)!.status = 'succeeded'; }, error => {
        operations.get(operation.id)!.status = 'failed'; operations.get(operation.id)!.error = error instanceof Error ? error.message : 'DSH failed';
      }).finally(() => { jobs.delete(job); }); jobs.add(job);
      return { ok: true, operationId: operation.id };
    }
    if (request.type === 'task.result') return { ok: true, taskResult: native.broker.result(request.taskId) };
    if (request.type === 'task.events') return { ok: true, taskEvents: native.broker.events(request.taskId, request.after) };
    if (request.type === 'task.record') return { ok: true, taskRecord: await native.broker.readRecord(request.query) };
    if (request.type === 'task.message') await native.broker.sendInput(request.taskId, request.content, request.mode, request.messageId);
    if (request.type === 'task.cancel') native.broker.cancel(request.taskId);
    if (request.type === 'task.terminate') await native.broker.terminate(request.taskId);
    return { ok: true };
  } } as unknown as DshLauncher;
  return { dsh, settle: () => Promise.allSettled([...jobs]) };
}
