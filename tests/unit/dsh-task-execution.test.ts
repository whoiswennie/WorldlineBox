import { describe, expect, it } from 'vitest';
import { dshTaskInputSchema } from '../../src/shared/dsh-tasks';
import { snapshotDshTaskExecution, type DshTaskExecutionOptions } from '../../src/main/dsh/task-execution';
import { dshTaskSpecSchema } from '../../src/shared/dsh-task-spec';

describe('DSH task controls independent of application models', () => {
  it('captures task permissions without accepting any model or credential injection at either boundary', () => {
    const source = { mode: 'workspace-write' as const };
    const execution = snapshotDshTaskExecution({ toolkit: true, access: source });
    Object.assign(source, { mode: 'danger-full-access' });
    expect(Object.isFrozen(execution.access)).toBe(true);
    expect(() => snapshotDshTaskExecution({ companionName: '伪造的伙伴' })).toThrow('trusted owner');
    expect(dshTaskSpecSchema.safeParse({ companionName: '伪造的伙伴' }).success).toBe(false);
    for (const injected of [{ model: 'foreign-model' }, { apiKey: 'private-fixture-key' }, { connection: { apiKey: 'private-fixture-key' } }, { provider: 'foreign-provider' }]) {
      expect(() => snapshotDshTaskExecution(injected as DshTaskExecutionOptions)).toThrow('overrides are not supported');
      expect(dshTaskInputSchema.safeParse({ prompt: 'task', ...injected }).success).toBe(false);
    }
  });
});
