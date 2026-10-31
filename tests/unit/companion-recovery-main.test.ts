import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { executeCompanionRecovery } from '../../src/main/companions/recovery';

const mock = vi.hoisted(() => ({ construct: vi.fn(), start: vi.fn(), close: vi.fn(), request: vi.fn(), inspect: vi.fn(), restore: vi.fn() }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  constructor(...args: unknown[]) { mock.construct(...args); }
  start = mock.start; close = mock.close; request = mock.request;
  static inspectRecoveryPackage = mock.inspect;
  static recoverDatabase = mock.restore;
} }));
const scope = { libraryId: 'selected-library', displayName: '隔离库', libraryPath: path.resolve('isolated-library'),
  dataRoot: path.resolve('isolated-library/.worldlinebox/companions'), memoryRoot: path.resolve('isolated-library/伙伴记忆') };
const operationId = '9c1e8bf8-2215-40a7-8bbf-622a5ab36aa0';
const result = { operationId, libraryId: scope.libraryId, lineageId: 'cbfaec57-f835-40a6-bcdb-292858ce305a', generation: 7,
  packagePath: path.resolve('isolated-backup'), manifestHash: 'a'.repeat(64), files: 2, bytes: 72, mode: 'backup' as const };
beforeEach(() => {
  vi.resetAllMocks(); mock.start.mockResolvedValue(undefined); mock.close.mockResolvedValue(undefined);
  mock.request.mockResolvedValue({ ok: true, recovery: result }); mock.inspect.mockResolvedValue(result); mock.restore.mockResolvedValue({ ...result, mode: 'database', requiresReview: true });
});
it('inspects a package and restores a missing database without constructing a normal store or service', async () => {
  expect(await executeCompanionRecovery('worker.js', scope, { type: 'recovery.package.inspect', packagePath: result.packagePath })).toEqual({ ok: true, recovery: result });
  const restored = await executeCompanionRecovery('worker.js', scope, { type: 'recovery.restore', libraryId: scope.libraryId, operationId,
    packagePath: result.packagePath, expectedManifestHash: result.manifestHash, mode: 'database' });
  expect(restored.recovery).toMatchObject({ mode: 'database', requiresReview: true }); expect(mock.construct).not.toHaveBeenCalled(); expect(mock.start).not.toHaveBeenCalled();
  expect(mock.restore).toHaveBeenCalledWith('worker.js', { libraryId: scope.libraryId, libraryPath: scope.libraryPath },
    { operationId, packagePath: result.packagePath, expectedManifestHash: result.manifestHash });
});
it('uses one dedicated worker for a quiet backup and closes it after either success or failure', async () => {
  const command = { type: 'recovery.backup.create' as const, libraryId: scope.libraryId, operationId, destinationParent: path.resolve('backup-parent') };
  expect((await executeCompanionRecovery('worker.js', scope, command)).ok).toBe(true);
  expect(mock.construct).toHaveBeenCalledWith('worker.js', path.join(scope.dataRoot, 'messages.sqlite'), undefined, undefined,
    { hostRetention: { libraryId: scope.libraryId, libraryPath: scope.libraryPath } });
  expect(mock.close).toHaveBeenCalledOnce(); mock.request.mockResolvedValueOnce({ ok: false, error: '包校验失败，原数据保留。' });
  await expect(executeCompanionRecovery('worker.js', scope, command)).rejects.toThrow('原数据保留'); expect(mock.close).toHaveBeenCalledTimes(2);
});
it('refuses a changed target library before opening a worker and rejects a foreign inspected package', async () => {
  await expect(executeCompanionRecovery('worker.js', scope, { type: 'recovery.backup.create', libraryId: 'old-selection', operationId, destinationParent: path.resolve('backup-parent') })).rejects.toThrow('已变化');
  expect(mock.construct).not.toHaveBeenCalled(); mock.inspect.mockResolvedValueOnce({ ...result, libraryId: 'foreign' });
  await expect(executeCompanionRecovery('worker.js', scope, { type: 'recovery.package.inspect', packagePath: result.packagePath })).rejects.toThrow('不属于');
});
