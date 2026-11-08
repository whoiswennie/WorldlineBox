import type { DshInstance } from '../../shared/dsh-launcher';

export interface CompanionEnvironmentOwner { id: string; name: string; enabled?: boolean }

/** Restore one shared connection, never one native process per character. */
export async function restoreCompanionKeepAlive(owners: readonly CompanionEnvironmentOwner[], instances: readonly DshInstance[],
  start: (owner: CompanionEnvironmentOwner, instance: DshInstance) => Promise<void>, signal?: AbortSignal, isEnabled?: (id: string) => boolean): Promise<void> {
  signal?.throwIfAborted();
  const selected = instances.find(instance => instance.isDefault && instance.keepAlive);
  const owner = owners.find(value => value.enabled !== false && isEnabled?.(value.id) !== false);
  if (!selected || !owner) return;
  await start(owner, selected);
  signal?.throwIfAborted();
}
