import { expect, it, vi } from 'vitest';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import type { BotStore } from '../../src/main/companion-bot/store';
import { selectBotWorkerInstance } from '../../src/main/companion-bot/worker-host-selection';

it('routes new work to its owner equipment while keeping an existing task on its original native environment', async () => {
  let binding = '', equipment = 'private-a';
  const store = { getMetadata: () => binding, getTask: (id: string) => id === 'task-a' ? { companionId: 'actor-a' } : undefined,
    getCompanion: () => ({ id: 'actor-a', name: 'A' }) } as unknown as BotStore;
  const launcher = {
    resolveBotInstance: vi.fn(async (id?: string) => ({ id: id ?? 'default', companionId: 'actor-a' }) as DshInstance),
    resolveCompanionInstance: vi.fn(async () => ({ id: equipment }) as DshInstance),
  };
  expect((await selectBotWorkerInstance(launcher, store, 'worker-task-a')).id).toBe('private-a');
  expect(launcher.resolveCompanionInstance).toHaveBeenCalledWith('actor-a', 'A');
  binding = 'private-a'; equipment = 'private-new';
  expect((await selectBotWorkerInstance(launcher, store, 'worker-task-a')).id).toBe('private-a');
  expect(launcher.resolveCompanionInstance).toHaveBeenCalledTimes(1);
  await expect(selectBotWorkerInstance(launcher, store, 'worker-task-a', 'private-new')).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
  await expect(selectBotWorkerInstance(launcher, undefined)).rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
});

it('blocks a persisted shared or foreign Host instead of silently replaying the original task', async () => {
  const store = { getMetadata: () => 'old-default', getTask: () => ({ companionId: 'actor-a' }),
    getCompanion: () => ({ id: 'actor-a', name: 'A' }) } as unknown as BotStore;
  const launcher = { resolveBotInstance: vi.fn(async () => ({ id: 'old-default' }) as DshInstance),
    resolveCompanionInstance: vi.fn(async () => ({ id: 'new-private', companionId: 'actor-a' }) as DshInstance) };
  await expect(selectBotWorkerInstance(launcher, store, 'worker-task-a')).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
  launcher.resolveBotInstance.mockResolvedValueOnce({ id: 'foreign', companionId: 'actor-b' } as DshInstance);
  await expect(selectBotWorkerInstance(launcher, store, 'worker-task-a')).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
  expect(launcher.resolveCompanionInstance).not.toHaveBeenCalled();
});

it('resolves native legacy lane owners and propagates an unbound companion error without selecting a default', async () => {
  const store = { getMetadata: () => undefined, getTask: () => undefined,
    getLane: (id: string) => id === 'lane-a' ? { companionId: 'actor-a' } : undefined,
    getCompanion: () => ({ id: 'actor-a', name: 'A' }) } as unknown as BotStore;
  const launcher = { resolveBotInstance: vi.fn(), resolveCompanionInstance: vi.fn(async () => {
    throw Object.assign(new Error('Bind a private instance first.'), { code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  }) };
  await expect(selectBotWorkerInstance(launcher, store, 'lane-a-epoch-2')).rejects.toMatchObject({ code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  expect(launcher.resolveCompanionInstance).toHaveBeenCalledWith('actor-a', 'A');
  expect(launcher.resolveBotInstance).not.toHaveBeenCalled();
});
