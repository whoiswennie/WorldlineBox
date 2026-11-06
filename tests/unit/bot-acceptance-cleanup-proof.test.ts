import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { inspectAcceptanceRoot } from '../../scripts/bot-acceptance-cleanup-lib.mjs';

it('admits an explicit owned multi-instance fixture and rejects additional instances, path escapes, and missing ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-host-'));
  const trusted = [{ id: 'base', name: 'Bot native acceptance', runtimeId: 'runtime-bot-acceptance' },
    { id: 'private', name: '独立伙伴', runtimeId: 'runtime-native-upgrade-rc1' }];
  const records = trusted.map(record => ({ ...record, homePath: path.join(root, 'instances', record.id, 'home'),
    agentsPath: path.join(root, 'instances', record.id, 'agents'), workspacePath: path.join(root, 'instances', record.id, 'workspace') }));
  const marker = path.join(root, '.worldlinebox-acceptance.json'), manifest = path.join(root, 'native-instances.json');
  try {
    await writeFile(marker, JSON.stringify({ kind: 'native-host-fixture', ownerPid: process.pid }));
    await writeFile(manifest, JSON.stringify(records));
    await expect(inspectAcceptanceRoot(root, [], process.pid)).rejects.toThrow('ownership metadata differs');
    await expect(inspectAcceptanceRoot(root, [], process.pid, trusted)).resolves.toMatchObject({ owner: 'native-host-fixture', alivePids: [] });
    await expect(inspectAcceptanceRoot(root, [{ ProcessId: 424242, CommandLine: root }], process.pid, trusted)).resolves.toMatchObject({ alivePids: [424242] });
    await expect(inspectAcceptanceRoot(root, [], process.pid, trusted.slice(0, 1))).rejects.toThrow('ownership metadata differs');
    await writeFile(manifest, JSON.stringify(records.map(record => record.id === 'private' ? { ...record, homePath: os.tmpdir() } : record)));
    await expect(inspectAcceptanceRoot(root, [], process.pid, trusted)).rejects.toThrow('ownership metadata differs');
    await writeFile(manifest, JSON.stringify(records));
    await writeFile(marker, JSON.stringify({ kind: 'native-host-fixture', ownerPid: process.pid + 1 }));
    await expect(inspectAcceptanceRoot(root, [], process.pid, trusted)).rejects.toThrow('ownership is unavailable');
    await rm(marker); await expect(inspectAcceptanceRoot(root, [], process.pid, trusted)).rejects.toThrow('ownership is unavailable');
  } finally {
    // This test creates only marker/manifest ordinary files, no Host or links.
    // Check the fixed temporary parent and namespace before recursive cleanup.
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^worldlinebox-bot-host-/u);
    await mkdir(root, { recursive: true });
    expect(JSON.parse(await readFile(manifest, 'utf8'))).toEqual(records);
    await rm(root, { recursive: true, force: true });
  }
});
