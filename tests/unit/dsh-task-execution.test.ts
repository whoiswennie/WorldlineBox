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
  it('pins full access only for new host-owned companion execution and retains explicit and resumed policy', () => {
    const recordScope = { actionId: '12345678-1234-4123-8123-123456789abc', companionId: 'fish', conversationId: 'room', sourceMessageId: 'actual-source' };
    expect(snapshotDshTaskExecution({ recordScope }).access).toEqual({ mode: 'danger-full-access' });
    expect(snapshotDshTaskExecution({ recordScope, access: { mode: 'workspace-write' } }).access).toEqual({ mode: 'workspace-write' });
    expect(snapshotDshTaskExecution({ recordScope, task: { session: { mode: 'resume', taskId: '12345678-1234-4123-8123-123456789abc' } } }).access).toBeUndefined();
    expect(snapshotDshTaskExecution({}).access).toBeUndefined();
    const thought = snapshotDshTaskExecution({ recordScope, cognitiveOnly: true, workspaceRootPath: 'fixture-root' });
    expect(thought.access).toEqual({ mode: 'read-only' });
    expect(thought.task?.tools).toEqual([]);
  });
});
