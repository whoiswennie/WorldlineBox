import { expect, it, vi } from 'vitest';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import type { BotStore } from '../../src/main/companion-bot/store';
import { selectBotWorkerInstance } from '../../src/main/companion-bot/worker-host-selection';

function fixture() {
  const bindings = new Map<string, string>(); let selected = 'shared';
  const store = { getMetadata: (key: string) => bindings.get(key), getEvent: (id: string) => /^event-[ab]$/.test(id) ? { companionId: `actor-${id.slice(-1)}` } : undefined,
    getLane: (id: string) => id === 'lane-a' ? { companionId: 'actor-a' } : undefined,
    getCompanion: (id: string) => /^actor-[ab]$/.test(id) ? { id, name: id } : undefined } as unknown as BotStore;
  const launcher = { resolveBotInstance: vi.fn(async (id?: string) => ({ id: id ?? selected }) as DshInstance) };
  return { store, launcher, bindings, select: (id: string) => { selected = id; } };
}

it('routes new work from different companions to the same selected Host without allocating environments', async () => {
  const f = fixture();
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a')).id).toBe('shared');
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-b')).id).toBe('shared');
  expect(f.launcher.resolveBotInstance.mock.calls).toEqual([[], []]);
  f.select('new-shared');
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a')).id).toBe('new-shared');
});

it('keeps old private and shared work on their pinned native Hosts across global selection changes', async () => {
  const f = fixture();
  f.bindings.set('native-host:turn-event-a', 'old-private-a');
  f.bindings.set('native-host:turn-event-b', 'old-shared');
  f.select('new-shared');
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a')).id).toBe('old-private-a');
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-b')).id).toBe('old-shared');
  await expect(selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a', 'new-shared')).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
  expect(f.launcher.resolveBotInstance).toHaveBeenCalledTimes(2);
});

it('never substitutes a different Host when the original is absent or the resolver returns a fallback', async () => {
  const f = fixture(); f.bindings.set('native-host:turn-event-a', 'missing-original');
  f.launcher.resolveBotInstance.mockRejectedValueOnce(new Error('Original instance removed'));
  await expect(selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a')).rejects.toThrow('Original instance removed');
  f.launcher.resolveBotInstance.mockResolvedValueOnce({ id: 'fallback', companionId: 'actor-a' } as DshInstance);
  await expect(selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a')).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
});

it('preserves identity validation and resolves legacy native lane epochs through the shared selection', async () => {
  const f = fixture();
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'lane-a-epoch-2')).id).toBe('shared');
  await expect(selectBotWorkerInstance(f.launcher, undefined)).rejects.toMatchObject({ code: 'BOT_WORKER_IDENTITY_REQUIRED' });
  await expect(selectBotWorkerInstance(f.launcher, f.store, 'worker-missing')).rejects.toMatchObject({ code: 'BOT_WORKER_IDENTITY_REQUIRED' });
  expect(f.launcher.resolveBotInstance).toHaveBeenCalledTimes(1);
});

it('resolves each fresh chat turn by its event owner and keeps retries on the pinned Host', async () => {
  const f = fixture();
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a')).id).toBe('shared');
  f.bindings.set('native-host:turn-event-a', 'original'); f.select('new');
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a')).id).toBe('original');
  expect((await selectBotWorkerInstance(f.launcher, f.store, 'turn-event-b')).id).toBe('new');
  await expect(selectBotWorkerInstance(f.launcher, f.store, 'turn-event-a', 'new')).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
  await expect(selectBotWorkerInstance(f.launcher, f.store, 'turn-missing')).rejects.toMatchObject({ code: 'BOT_WORKER_IDENTITY_REQUIRED' });
});
