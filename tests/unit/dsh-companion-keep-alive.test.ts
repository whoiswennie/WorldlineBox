import { expect, it, vi } from 'vitest';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import { restoreCompanionKeepAlive, type CompanionEnvironmentOwner } from '../../src/main/dsh/companion-keep-alive';

const instance = (id: string, keepAlive = true): DshInstance => ({ id: `private-${id}`, name: id, companionId: id, keepAlive,
  runtimeId: 'runtime-a', profile: 'web', status: 'stopped', homePath: `/data/${id}/home`, agentsPath: `/data/${id}/agents`,
  workspacePath: `/data/${id}/workspace`, browserPartition: `persist:${id}`, isDefault: false, createdAt: '', updatedAt: '' });

it('restores only existing enabled private keep-alive environments', async () => {
  const start = vi.fn<(owner: CompanionEnvironmentOwner) => Promise<void>>(async () => undefined);
  await restoreCompanionKeepAlive(['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id, enabled: id !== 'b' })),
    [instance('a'), instance('b'), instance('c', false), { ...instance('d'), isDefault: true }], start);
  expect(start.mock.calls.map(call => call[0])).toEqual([{ id: 'a', name: 'a', enabled: true }]);
});
it('limits startup to two environments at a time and continues after an individual failure', async () => {
  const order: string[] = [], releases = new Map<string, () => void>(); let active = 0, maximum = 0;
  const pending = restoreCompanionKeepAlive(['a', 'b', 'c', 'd'].map(id => ({ id, name: id })), ['a', 'b', 'c', 'd'].map(id => instance(id)), async owner => {
    order.push(owner.id); active++; maximum = Math.max(active, maximum);
    try { await new Promise<void>(resolve => { releases.set(owner.id, resolve); }); if (owner.id === 'a') throw new Error('fixture start failed'); }
    finally { active--; }
  });
  const rejected = expect(pending).rejects.toThrow('1 个伙伴常驻能力环境');
  expect(order).toEqual(['a', 'b']); releases.get('a')!();
  await vi.waitFor(() => expect(order).toContain('c')); expect(maximum).toBe(2);
  releases.get('b')!(); await vi.waitFor(() => expect(order).toContain('d'));
  releases.get('c')!(); releases.get('d')!(); await rejected; expect(order).toEqual(['a', 'b', 'c', 'd']);
});
it('does not start queued environments after shutdown aborts startup', async () => {
  const controller = new AbortController(), started: string[] = [], reason = new Error('shutdown');
  const pending = restoreCompanionKeepAlive(['a', 'b', 'c'].map(id => ({ id, name: id })), ['a', 'b', 'c'].map(id => instance(id)), async owner => {
    started.push(owner.id); await new Promise<void>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  }, controller.signal);
  controller.abort(reason); await expect(pending).rejects.toBe(reason); expect(started).toEqual(['a', 'b']);
});
it('rechecks live enablement when a queued startup reaches the front after other environments were preparing', async () => {
  const enabled = new Set(['a', 'b', 'c']), started: string[] = [], releases = new Map<string, () => void>();
  const pending = restoreCompanionKeepAlive(['a', 'b', 'c'].map(id => ({ id, name: id })), ['a', 'b', 'c'].map(id => instance(id)), async owner => {
    started.push(owner.id); await new Promise<void>(resolve => { releases.set(owner.id, resolve); });
  }, undefined, id => enabled.has(id));
  expect(started).toEqual(['a', 'b']); enabled.delete('c'); releases.get('a')!(); releases.get('b')!();
  await pending; expect(started).toEqual(['a', 'b']);
});
