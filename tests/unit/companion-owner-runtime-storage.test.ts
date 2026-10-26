import { mkdtemp, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { ColdKnowledgeService } from '../../src/main/vcp-memory/cold-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { companionOwnerRuntimeStorage } from '../../src/main/companions/owner-runtime-storage';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

it('rejects another owner before a bound cold service creates directories or launches native work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-owner-cold-bound-')), launch = vi.fn();
  const directory = path.join(root, 'alice', '.认知索引', 'cold');
  const service = new ColdKnowledgeService({ dataRoot: directory, boundOwnerId: 'alice', vendorRoot: 'unused', workerPath: 'unused', launch,
    embedding: { baseUrl: 'http://127.0.0.1', model: 'fixture', dimension: 4, apiKey: 'fixture' }, authorize: async () => true });
  try {
    await expect(service.status('bob')).rejects.toThrow('another owner');
    await expect(service.reset('bob')).rejects.toThrow('another owner');
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' }); expect(launch).not.toHaveBeenCalled();
  } finally { await service.close(); await removeOwnedDirectory(root); }
});

it('accepts only the exact canonical owner subtree supplied by the host resolver', () => {
  const workspaceRoot = path.resolve('synthetic-owner-assets'), ownerRoot = path.join(workspaceRoot, 'alice');
  const storage = { ownerId: 'alice', workspaceRoot, ownerRoot, indexRoot: path.join(ownerRoot, '.认知索引'), ownerPrompts: { aimemoTemplate: 'live owner text', timelineTemplate: 'live timeline', summaryTemplate: 'live summary' } };
  expect(companionOwnerRuntimeStorage('alice', storage)).toEqual(storage);
  expect(() => companionOwnerRuntimeStorage('bob', storage)).toThrow('可信伙伴');
  expect(() => companionOwnerRuntimeStorage('alice', { ...storage, indexRoot: path.join(workspaceRoot, '.global-cache') })).toThrow('当前伙伴');
});
