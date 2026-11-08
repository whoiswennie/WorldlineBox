import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';

/** One configured shared executor for UI tests which exercise chat rather than setup. */
export function botUiSharedLauncher(): WorldlineBoxDshLauncherApi {
  const runtime = { id: 'ui-runtime', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64' as const, adapter: 'node-cli-web-v1' as const, source: '', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 1, byteLength: 1 };
  const state: DshLauncherState = { supported: true, rootPath: 'fixture', runtimes: [runtime], instances: [{ id: 'ui-shared', name: '共享 DSH', runtimeId: runtime.id, profile: 'web', status: 'stopped', isDefault: true, homePath: '', agentsPath: '', workspacePath: '', browserPartition: 'ui-shared', createdAt: '', updatedAt: '' }], snapshots: [], packs: [], operations: [] };
  return { request: async input => input.type === 'state' ? { ok: true, state } : { ok: false, error: `Unexpected UI fixture mutation: ${input.type}` }, onChanged: () => () => undefined };
}
