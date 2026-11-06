import type { DshInstance } from '../../shared/dsh-launcher';

export interface CompanionEnvironmentOwner { id: string; name: string; enabled?: boolean }

/** Restore only explicit persistent connections, without a startup storm or fail-fast omissions. */
export async function restoreCompanionKeepAlive(owners: readonly CompanionEnvironmentOwner[], instances: readonly DshInstance[],
  start: (owner: CompanionEnvironmentOwner, instance: DshInstance) => Promise<void>, signal?: AbortSignal, isEnabled?: (id: string) => boolean): Promise<void> {
  signal?.throwIfAborted();
  const unique = new Map(owners.map(owner => [owner.id, owner]));
  const pending = [...unique.values()].flatMap(owner => {
    const instance = instances.find(value => value.companionId === owner.id && value.keepAlive && !value.isDefault);
    return owner.enabled !== false && isEnabled?.(owner.id) !== false && instance ? [{ owner, instance }] : [];
  });
  let next = 0; const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
    while (next < pending.length && !signal?.aborted) {
      const { owner, instance } = pending[next++]!;
      if (isEnabled?.(owner.id) === false) continue;
      try { await start(owner, instance); }
      catch (cause) { errors.push(new Error(`伙伴 ${owner.name} 的常驻能力环境启动失败（${instance.id}）。`, { cause })); }
    }
  }));
  signal?.throwIfAborted();
  if (errors.length) throw new AggregateError(errors, `${errors.length} 个伙伴常驻能力环境未能启动，其余环境已分别处理。`);
}
