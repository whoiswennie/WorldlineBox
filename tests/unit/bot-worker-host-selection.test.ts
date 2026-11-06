import { expect, it, vi } from 'vitest';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import type { BotStore } from '../../src/main/companion-bot/store';
import { selectBotWorkerInstance } from '../../src/main/companion-bot/worker-host-selection';

it('routes new work to its owner equipment while keeping an existing task on its original native environment', async () => {
  let binding = '', equipment = 'private-a';
  const store = { getMetadata: () => binding, getTask: (id: string) => id === 'task-a' ? { companionId: 'actor-a' } : undefined,
    getCompanion: () => ({ id: 'actor-a', name: 'A' }) } as unknown as BotStore;
  const launcher = {
    resolveBotInstance: vi.fn(async (id?: string) => ({ id: id ?? 'default' }) as DshInstance),
    resolveCompanionInstance: vi.fn(async () => ({ id: equipment }) as DshInstance),
  };
  expect((await selectBotWorkerInstance(launcher, store, 'worker-task-a')).id).toBe('private-a');
  expect(launcher.resolveCompanionInstance).toHaveBeenCalledWith('actor-a', 'A');
  binding = 'private-a'; equipment = 'private-new';
  expect((await selectBotWorkerInstance(launcher, store, 'worker-task-a')).id).toBe('private-a');
  expect(launcher.resolveCompanionInstance).toHaveBeenCalledTimes(1);
  await expect(selectBotWorkerInstance(launcher, store, 'worker-task-a', 'private-new')).rejects.toMatchObject({ code: 'BOT_HOST_MIGRATION_BLOCKED' });
  expect((await selectBotWorkerInstance(launcher, undefined)).id).toBe('default');
});
