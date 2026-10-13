import { describe, expect, it } from 'vitest';

import { dshTaskInputSchema } from '../../src/shared/dsh-tasks';
import { clearDshTaskConnectionEnvironment, DSH_TASK_API_KEY_REF, dshTaskConnectionEnvironment,
  dshTaskConnectionPatch, dshCompanionTaskToolPatch, dshTaskExecutionPatch, redactDshTaskConnection, snapshotDshTaskConnection, snapshotDshTaskExecution,
  type DshTaskExecutionConnection } from '../../src/main/dsh/task-connection';

const connection: DshTaskExecutionConnection = { provider: 'deepseek-official', model: 'deepseek-flash',
  baseURL: 'https://api.deepseek.com/anthropic', apiKey: 'opaque-main-only-connection-fixture' };

describe('Main-only DSH task connection', () => {
  it('enables only existing first-party task tools without depending on a global model connection', () => {
    const windows = dshCompanionTaskToolPatch('win32');
    expect(windows).toContainEqual({ id: 'tool-pwsh', disabled: false });
    expect(windows).toContainEqual({ id: 'tool-fs', disabled: false });
    expect(windows).toContainEqual({ id: 'tool-fs-search', disabled: false });
    expect(windows).not.toContainEqual({ id: 'modules', disabled: false });
    expect(windows).not.toContainEqual({ id: 'tool-bash', disabled: false });
    expect(dshCompanionTaskToolPatch('linux')).toContainEqual({ id: 'tool-bash', disabled: false });
    expect(dshTaskExecutionPatch({ toolkit: true })).toEqual(dshCompanionTaskToolPatch());
    expect(dshTaskExecutionPatch({})).toEqual([]);
  });

  it('captures an immutable access snapshot and uses the pinned workspace boundary in its private patch', () => {
    const source = { mode: 'workspace-write' as const };
    const execution = snapshotDshTaskExecution({ toolkit: true, access: source });
    expect(execution.access).toEqual({ mode: 'workspace-write' });
    expect(Object.isFrozen(execution.access)).toBe(true);
    Object.assign(source, { mode: 'danger-full-access' });
    const patch = dshTaskExecutionPatch(execution, process.cwd());
    expect(patch).toContainEqual({ id: 'sandbox-policy', disabled: false, config: { mode: 'workspace-write', workspaceRoot: process.cwd() } });
    expect(patch).toContainEqual({ id: 'approval', disabled: false, config: { policy: 'never' } });
    expect(() => dshTaskExecutionPatch(execution)).toThrow('absolute path');
  });
  it('projects only transient credential-reference and route metadata without replacing the native catalog', () => {
    expect(dshTaskConnectionPatch(connection)).toEqual([
      { id: 'llm-deepseek', config: { baseURL: connection.baseURL, apiKeyEnv: DSH_TASK_API_KEY_REF } },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    ]);
    expect(JSON.stringify(dshTaskConnectionPatch(connection))).not.toContain(connection.apiKey);
    const captured = snapshotDshTaskConnection(connection);
    expect(captured).toEqual(connection);
    expect(captured).not.toBe(connection);
    expect(dshTaskInputSchema.safeParse({ prompt: 'task', apiKey: connection.apiKey }).success).toBe(false);
    expect(dshTaskInputSchema.safeParse({ prompt: 'task', connection }).success).toBe(false);
  });

  it('copies and clears only the spawn-local environment, including stale case variants', () => {
    const base = { PATH: 'native-path', HOME: 'native-home', [DSH_TASK_API_KEY_REF.toLowerCase()]: 'stale-private-key' };
    const before = { ...base };
    const env = dshTaskConnectionEnvironment(base, connection);
    expect(env[DSH_TASK_API_KEY_REF]).toBe(connection.apiKey);
    expect(env[DSH_TASK_API_KEY_REF.toLowerCase()]).toBeUndefined();
    expect(base).toEqual(before);
    clearDshTaskConnectionEnvironment(env);
    expect(env).toEqual({ PATH: 'native-path', HOME: 'native-home' });
    expect(dshTaskConnectionEnvironment(base)).toEqual({ PATH: 'native-path', HOME: 'native-home' });
  });

  it('refuses malformed routes and never exposes invalid connection values in errors', () => {
    for (const baseURL of ['file:///secret', 'https://user:password@example.com', 'https://example.com?key=hidden', 'https://example.com#secret']) {
      expect(() => snapshotDshTaskConnection({ ...connection, baseURL })).toThrow('endpoint is invalid');
    }
    expect(() => snapshotDshTaskConnection({ ...connection, baseURL: `https://example.com/${connection.apiKey}` })).toThrow('mixes secret');
    expect(() => snapshotDshTaskConnection({ ...connection, model: connection.apiKey })).toThrow('mixes secret');
    expect(() => snapshotDshTaskConnection({ ...connection, apiKey: 'private\ninvalid' })).toThrow('connection is invalid');
  });

  it('redacts exact opaque keys repeatedly while keeping unrelated execution text', () => {
    expect(redactDshTaskConnection(`first ${connection.apiKey}, next ${connection.apiKey}`, connection)).toBe('first [redacted], next [redacted]');
    expect(redactDshTaskConnection('ordinary result', connection)).toBe('ordinary result');
    expect(redactDshTaskConnection('native result')).toBe('native result');
  });
});
