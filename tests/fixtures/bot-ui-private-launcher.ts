import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';

/** Explicit private bindings for UI tests which exercise chat rather than setup. */
export function botUiPrivateLauncher(companionIds: readonly string[]): WorldlineBoxDshLauncherApi {
  const runtime = { id: 'ui-runtime', version: '0.2.2-rc.1', nodeVersion: '24', platform: 'win32-x64' as const, adapter: 'node-cli-web-v1' as const, source: '', sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: '', fileCount: 1, byteLength: 1 };
  const state: DshLauncherState = { supported: true, rootPath: 'fixture', runtimes: [runtime], instances: companionIds.map(companionId => ({ id: `ui-${companionId}`, companionId, name: companionId, runtimeId: runtime.id, profile: 'web', status: 'stopped', isDefault: false, homePath: '', agentsPath: '', workspacePath: '', browserPartition: companionId, createdAt: '', updatedAt: '' })), snapshots: [], packs: [], operations: [] };
  return { request: async input => input.type === 'state' ? { ok: true, state } : { ok: false, error: `Unexpected UI fixture mutation: ${input.type}` }, onChanged: () => () => undefined };
}
