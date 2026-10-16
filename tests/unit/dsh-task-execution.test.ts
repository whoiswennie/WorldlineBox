import { describe, expect, it } from 'vitest';
import { dshTaskInputSchema } from '../../src/shared/dsh-tasks';
import { dshCompanionTaskToolPatch, dshTaskExecutionPatch, snapshotDshTaskExecution, type DshTaskExecutionOptions } from '../../src/main/dsh/task-execution';

describe('DSH task controls independent of application models', () => {
  it('enables native task tools while leaving account, model and provider rows untouched', () => {
    expect(dshCompanionTaskToolPatch('win32')).toContainEqual({ id: 'tool-pwsh', disabled: false });
    expect(dshCompanionTaskToolPatch('linux')).toContainEqual({ id: 'tool-bash', disabled: false });
    expect(dshCompanionTaskToolPatch('win32')).not.toContainEqual({ id: 'modules', disabled: false });
    expect(dshTaskExecutionPatch({ toolkit: true })).toEqual([...dshCompanionTaskToolPatch(), { id: 'tools', config: { mode: 'native' } }]);
    expect(dshTaskExecutionPatch({ toolkit: true, interactive: true })).toEqual([{ id: 'tools', config: { mode: 'native' } }]);
    expect(dshTaskExecutionPatch({})).toEqual([]);
  });
  it('captures task permissions without accepting any model or credential injection at either boundary', () => {
    const source = { mode: 'workspace-write' as const };
    const execution = snapshotDshTaskExecution({ toolkit: true, access: source });
    Object.assign(source, { mode: 'danger-full-access' });
    expect(Object.isFrozen(execution.access)).toBe(true);
    expect(dshTaskExecutionPatch(execution, process.cwd())).toContainEqual({ id: 'sandbox-policy', disabled: false, config: { mode: 'workspace-write', workspaceRoot: process.cwd() } });
    expect(() => dshTaskExecutionPatch(execution)).toThrow('absolute path');
    for (const injected of [{ model: 'foreign-model' }, { apiKey: 'private-fixture-key' }, { connection: { apiKey: 'private-fixture-key' } }, { provider: 'foreign-provider' }]) {
      expect(() => snapshotDshTaskExecution(injected as DshTaskExecutionOptions)).toThrow('overrides are not supported');
      expect(dshTaskInputSchema.safeParse({ prompt: 'task', ...injected }).success).toBe(false);
    }
  });
});
