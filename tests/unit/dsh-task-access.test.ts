import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { dshExecutionAccessSettingsSchema } from '../../src/shared/dsh-access';
import { DshTaskAccessStore, dshTaskAccessPatch, snapshotDshTaskAccess } from '../../src/main/dsh/task-access';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function temporaryStore(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-access-'));
  directories.push(directory);
  return directory;
}

describe('DSH task execution access snapshot', () => {
  it('defaults to the requested full access and captures settings independently', () => {
    expect(snapshotDshTaskAccess()).toEqual({ mode: 'danger-full-access' });
    const source = { mode: 'workspace-write' as const };
    const snapshot = snapshotDshTaskAccess(source);
    expect(snapshot).not.toBe(source);
    expect(Object.isFrozen(snapshot)).toBe(true);
    Object.assign(source, { mode: 'read-only' });
    expect(snapshot.mode).toBe('workspace-write');
  });

  it('changes enforcing native services and seeds the exact permission bundle', () => {
    const workspaceRoot = process.cwd();
    for (const mode of ['danger-full-access', 'workspace-write', 'read-only'] as const) {
      const rows = dshTaskAccessPatch({ mode }, workspaceRoot, 'win32');
      expect(rows).toContainEqual({ id: 'sandbox-policy', disabled: false, config: { mode, workspaceRoot } });
      expect(rows).toContainEqual({ id: 'fs-sandbox', disabled: false });
      expect(rows).toContainEqual({ id: 'pwsh-sandbox', disabled: false });
      expect(rows).toContainEqual({ id: 'approval', disabled: false, config: { policy: 'never' } });
      const permission = rows.find(row => row.id === 'permission');
      expect(permission?.config).toMatchObject({ defaultPreset: mode, presets: { [mode]: { sandbox: mode, approval: 'never' } } });
      expect(rows.some(row => row.id === 'bash-sandbox')).toBe(false);
      expect(JSON.stringify(rows)).not.toContain('defaultPresetId');
    }
    expect(dshTaskAccessPatch({ mode: 'danger-full-access' }, workspaceRoot, 'linux'))
      .toContainEqual({ id: 'bash-sandbox', disabled: false });
  });

  it('rejects unsupported modes and relative workspace boundaries', () => {
    expect(dshExecutionAccessSettingsSchema.safeParse({ mode: 'full' }).success).toBe(false);
    expect(dshExecutionAccessSettingsSchema.safeParse({ mode: 'danger-full-access', workspaceRoot: 'injected' }).success).toBe(false);
    expect(() => snapshotDshTaskAccess({ mode: 'other' } as never)).toThrow('access policy is invalid');
    for (const root of ['', '.', '../outside', 'path\0suffix']) {
      expect(() => dshTaskAccessPatch({ mode: 'workspace-write' }, root)).toThrow('absolute path');
    }
  });

  it('persists serialized launcher changes and recovers the last saved preference', async () => {
    const directory = await temporaryStore();
    const store = new DshTaskAccessStore(directory);
    await store.load();
    expect(store.state()).toEqual({ mode: 'danger-full-access' });
    const snapshot = snapshotDshTaskAccess(store.state());
    await Promise.all([store.save('read-only'), store.save('workspace-write')]);
    expect(store.state()).toEqual({ mode: 'workspace-write' });
    expect(snapshot.mode).toBe('danger-full-access');
    const restarted = new DshTaskAccessStore(directory);
    await restarted.load();
    expect(restarted.state()).toEqual({ mode: 'workspace-write' });
    expect(JSON.parse(await readFile(path.join(directory, 'execution-access.json'), 'utf8')))
      .toEqual({ format: 'worldlinebox-dsh-task-access-v1', mode: 'workspace-write' });
  });

  it('preserves malformed or oversized existing settings instead of overwriting them', async () => {
    for (const original of ['{broken', JSON.stringify({ format: 'unknown', mode: 'read-only' }), 'x'.repeat(8193)]) {
      const directory = await temporaryStore();
      const file = path.join(directory, 'execution-access.json');
      await writeFile(file, original, 'utf8');
      const store = new DshTaskAccessStore(directory);
      await expect(store.load()).rejects.toThrow('original file was preserved');
      await expect(store.save('danger-full-access')).rejects.toThrow('original file was preserved');
      expect(await readFile(file, 'utf8')).toBe(original);
    }
  });
});
