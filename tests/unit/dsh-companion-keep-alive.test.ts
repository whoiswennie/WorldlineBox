import { expect, it, vi } from 'vitest';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import { restoreCompanionKeepAlive } from '../../src/main/dsh/companion-keep-alive';

const instance = (id: string, shared = false): DshInstance => ({ id, name: id, companionId: shared ? undefined : id, keepAlive: true,
  runtimeId: 'runtime-a', profile: 'web', status: 'stopped', homePath: `/data/${id}/home`, agentsPath: `/data/${id}/agents`,
  workspacePath: `/data/${id}/workspace`, browserPartition: `persist:${id}`, isDefault: shared, createdAt: '', updatedAt: '' });
const owners = Array.from({ length: 100 }, (_, index) => ({ id: `owner-${index}`, name: `Owner ${index}` }));
it('restores one shared keep-alive Host for one hundred actors and never restarts legacy private Hosts', async () => {
  const start = vi.fn(async () => undefined), shared = instance('shared', true);
  await restoreCompanionKeepAlive(owners, [instance('legacy-a'), shared, instance('legacy-b')], start);
  expect(start).toHaveBeenCalledExactlyOnceWith(owners[0], shared);
});
it('does not start when there is no enabled actor or no selected keep-alive connection', async () => {
  const start = vi.fn(async () => undefined);
  await restoreCompanionKeepAlive(owners.map(owner => ({ ...owner, enabled: false })), [instance('shared', true)], start);
  await restoreCompanionKeepAlive(owners, [instance('legacy')], start);
  await restoreCompanionKeepAlive(owners, [{ ...instance('shared', true), keepAlive: false }], start);
  expect(start).not.toHaveBeenCalled();
});
it('honors live enablement and propagates shutdown or startup failure without trying another Host', async () => {
  const start = vi.fn(async () => undefined), shared = instance('shared', true);
  await restoreCompanionKeepAlive(owners, [shared], start, undefined, id => id === owners[2]!.id);
  expect(start).toHaveBeenCalledExactlyOnceWith(owners[2], shared);
  const controller = new AbortController(), reason = new Error('shutdown'); controller.abort(reason);
  await expect(restoreCompanionKeepAlive(owners, [shared], start, controller.signal)).rejects.toBe(reason);
  const failure = new Error('real host unavailable'), failed = vi.fn(async () => { throw failure; });
  await expect(restoreCompanionKeepAlive(owners, [shared, instance('other')], failed)).rejects.toBe(failure);
  expect(failed).toHaveBeenCalledOnce();
});
