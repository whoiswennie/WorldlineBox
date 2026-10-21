import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionWorkspaceStore } from '../../src/main/companions/workspace';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-workspace-')); roots.push(root);
  const userData = path.join(root, 'profile'), libraryPath = path.join(root, 'library');
  await mkdir(path.join(libraryPath, '.worldlinebox'), { recursive: true });
  await writeFile(path.join(libraryPath, '.worldlinebox', 'library.db'), 'library-fixture');
  return { root, userData, library: { libraryId: 'library-id', displayName: '伙伴的家', libraryPath }, store: new CompanionWorkspaceStore(userData) };
}
it('requires an explicit library, and keeps only the locator in the device profile', async () => {
  const f = await fixture(); expect(await f.store.current()).toBeUndefined();
  const selected = await f.store.select(f.library);
  expect(selected.dataRoot).toBe(path.join(f.library.libraryPath, '.worldlinebox', 'companions'));
  expect(selected.memoryRoot).toBe(path.join(f.library.libraryPath, '伙伴记忆'));
  expect(await new CompanionWorkspaceStore(f.userData).current()).toEqual(selected);
  await expect(access(path.join(f.userData, 'companions'))).rejects.toThrow();
  expect(JSON.parse(await readFile(path.join(f.userData, 'companion-library.json'), 'utf8'))).toEqual(f.library);
});
it('moves verified legacy chat, attachments and credentials to the chosen library before removing the old copy', async () => {
  const f = await fixture(), legacy = path.join(f.userData, 'companions');
  await mkdir(path.join(legacy, 'attachments'), { recursive: true });
  await writeFile(path.join(legacy, 'messages.sqlite'), 'actual-chat-ledger');
  await writeFile(path.join(legacy, 'attachments', 'portrait.png'), 'portrait');
  await writeFile(path.join(legacy, 'credentials.json'), 'encrypted-local-key');
  await mkdir(path.join(legacy, 'vcp'), { recursive: true });
  await writeFile(path.join(legacy, 'vcp', 'derived.db'), 'can-be-rebuilt');
  const selected = await f.store.select(f.library);
  expect(await readFile(path.join(selected.dataRoot, 'messages.sqlite'), 'utf8')).toBe('actual-chat-ledger');
  expect(await readFile(path.join(selected.dataRoot, 'attachments', 'portrait.png'), 'utf8')).toBe('portrait');
  expect(await readFile(path.join(selected.dataRoot, 'credentials.json'), 'utf8')).toBe('encrypted-local-key');
  await expect(access(path.join(selected.dataRoot, 'vcp'))).rejects.toThrow();
  await expect(access(legacy)).rejects.toThrow();
});
it('retains old data and refuses to publish the binding on a conflicting interrupted migration', async () => {
  const f = await fixture(), legacy = path.join(f.userData, 'companions'), destination = path.join(f.library.libraryPath, '.worldlinebox', 'companions');
  await mkdir(legacy, { recursive: true }); await writeFile(path.join(legacy, 'messages.sqlite'), 'newest');
  await mkdir(destination); await writeFile(path.join(destination, 'messages.sqlite'), 'partial-conflict');
  await writeFile(path.join(destination, 'migration.pending.json'), '{}');
  await expect(f.store.select(f.library)).rejects.toThrow('校验');
  expect(await readFile(path.join(legacy, 'messages.sqlite'), 'utf8')).toBe('newest');
  expect(await f.store.current()).toBeUndefined();
});
it('rejects an ordinary folder without creating companion data there', async () => {
  const f = await fixture();
  await expect(f.store.select({ ...f.library, libraryPath: f.root })).rejects.toThrow();
  expect(await f.store.current()).toBeUndefined();
});
