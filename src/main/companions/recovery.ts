import path from 'node:path';
import type { CompanionRecoveryCommand } from '../../shared/companion-recovery';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import type { CompanionWorkspaceSelection } from './workspace';
import { CompanionStorageClient } from './storage-client';

/** Runs without a CompanionService: no model, world timer or file discovery
 * may mutate the snapshot while the dedicated worker verifies and copies it.
 * The caller owns the exclusive workspace stop/restart boundary. */
export async function executeCompanionRecovery(workerPath: string, selection: CompanionWorkspaceSelection,
  command: CompanionRecoveryCommand): Promise<CompanionWorkspaceResponse> {
  const scope = { libraryPath: selection.libraryPath, libraryId: selection.libraryId };
  if (command.type !== 'recovery.package.inspect' && command.libraryId !== selection.libraryId) throw new Error('伙伴资产库已变化，请重新核对要备份或恢复的目标。');
  if (command.type === 'recovery.package.inspect') {
    const recovery = await CompanionStorageClient.inspectRecoveryPackage(workerPath, scope, command.packagePath);
    if (recovery.libraryId !== selection.libraryId) throw new Error('备份不属于当前选定的伙伴资产库。');
    return { ok: true, recovery };
  }
  if (command.type === 'recovery.restore' && command.mode === 'database') {
    return { ok: true, recovery: await CompanionStorageClient.recoverDatabase(workerPath, scope,
      { operationId: command.operationId, packagePath: command.packagePath, expectedManifestHash: command.expectedManifestHash }) };
  }
  const storage = new CompanionStorageClient(workerPath, path.join(selection.dataRoot, 'messages.sqlite'), undefined, undefined, { hostRetention: scope });
  try {
    await storage.start();
    const response = await storage.request(command);
    if (!response.ok || !response.recovery) throw new Error(response.error ?? '备份或准确文件恢复未能完成。');
    if (response.recovery.libraryId !== selection.libraryId) throw new Error('恢复凭据不属于当前选定的伙伴资产库。');
    return { ok: true, recovery: response.recovery };
  } finally { await storage.close(); }
}
