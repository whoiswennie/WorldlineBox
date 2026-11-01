import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionPublicProfiles } from '../../src/main/companions/public-profiles';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: {}, ipcMain: {}, protocol: {}, shell: {}, safeStorage: {} }));

it('keeps Main source withdrawal fences while omitting whole-directory profile hydration for the private metadata port', async () => {
  const f = managedMemoryFiles();
  try {
    let withdrawal = false;
    const raw = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => ({ ...f.store.request(command),
      ...(withdrawal ? { memoryInvalidatedCompanionIds: ['alice'], memoryInvalidatedScopeIds: ['original_scope'] } : {}) }));
    const forbidden = vi.fn(() => { throw new Error('Metadata must not hydrate canonical profiles or historical bodies.'); });
    const invalidate = vi.fn(async () => undefined), libraryInvalidated = vi.fn(async () => undefined), retract = vi.fn(async () => undefined),
      drain = vi.fn(async () => undefined), redact = vi.fn(async () => undefined), wake = vi.fn();
    const service = Object.assign(Object.create(CompanionService.prototype), {
      storage: { request: raw }, resettingCompanions: new Set<string>(), sourceValidationRevision: 0, evidenceRevision: 0,
      assetProfiles: { bootstrapProfile: forbidden }, options: { report: forbidden, window: () => undefined },
      memory: { invalidate, schedule: vi.fn(), changed: vi.fn() }, memoryLibrary: { invalidate: libraryInvalidated },
      memoryManagement: { invalidate: vi.fn(async () => undefined) }, contextSnapshots: { redactStale: redact },
      wakeMemoryFiles: wake, flushRetractedMemoryFiles: retract, drainRevokedCognition: drain,
    }) as { call(command: CompanionStorageCommand, signal: undefined, origin: 'profile-metadata'): Promise<CompanionStorageResponse> };
    const command: CompanionStorageCommand = { type: 'state', includeHidden: true };
    expect((await service.call(command, undefined, 'profile-metadata')).state).toEqual(f.store.request(command).state);
    expect(raw.mock.calls.map(([value]) => value)).toEqual([command]);
    withdrawal = true; await service.call(command, undefined, 'profile-metadata');
    expect(invalidate).toHaveBeenCalledWith('alice', ['original_scope'], { preserveIndexes: false });
    expect(libraryInvalidated).toHaveBeenCalledWith('alice'); expect(wake).toHaveBeenCalledWith('alice');
    expect(retract).toHaveBeenCalledWith('alice'); expect(drain).toHaveBeenCalledWith('alice'); expect(redact).toHaveBeenCalledWith('alice');
    expect(forbidden).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('admits only actual room members from live metadata and still rejects changed canonical bytes on the next preparation', async () => {
  const f = managedMemoryFiles();
  try {
    const owners = f.store.state().companions;
    for (const owner of owners) f.store.updateCompanion(owner.id, { ...owner, avatar: 'custom' });
    const profiles = new CompanionAssetProfileStore(f.directory, { registryStorage: { request: f.request } });
    const readStateMetadata = vi.fn(async () => f.store.request({ type: 'state', includeHidden: true }).state);
    const request = vi.fn(async (command: CompanionStorageCommand) => {
      if (command.type === 'state') throw new Error('The ordinary state path would duplicate canonical admission.');
      return f.request(command);
    });
    const loader = new CompanionPublicProfiles({ root: f.root, appPath: f.root, profileStore: profiles, request, readStateMetadata });
    const hydrate = vi.spyOn(profiles, 'bootstrapProfile');
    const input = { companionId: 'alice', conversation: f.store.openPrivate('alice') };
    const result = await loader.prepare(input);
    expect(result.publicProfiles.filter(profile => profile.kind === 'companion').map(profile => profile.id)).toEqual(['alice']);
    expect(hydrate.mock.calls.map(([owner]) => owner.id)).toEqual(['alice']);
    expect(readStateMetadata).toHaveBeenCalledTimes(1);
    // Membership remains live: stale caller room metadata cannot restore access.
    await expect(loader.prepare({ ...input, conversation: f.store.openPrivate('bob') })).rejects.toThrow('真实成员入口');
    expect(hydrate).toHaveBeenCalledTimes(1);
    await writeFile(path.join(f.directory, 'alice', 'profile.md'), 'externally replaced canonical identity', 'utf8');
    await expect(loader.prepare(input)).rejects.toMatchObject({ code: 'CHANGED' });
    expect(readStateMetadata).toHaveBeenCalledTimes(3);
  } finally { await f.close(); }
});

it('reads current SQL image selections without duplicate profile hydration and keeps canonical member admission strict', async () => {
  const f = managedMemoryFiles();
  try {
    const owner = f.store.state().companions.find(owner => owner.id === 'alice')!;
    const profiles = new CompanionAssetProfileStore(f.directory, { registryStorage: { request: f.request } });
    await profiles.bootstrap(owner);
    const imageDirectory = path.join(f.directory, owner.id, '形象');
    await mkdir(imageDirectory, { recursive: true });
    const pixels = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#345678' } }).png().toBuffer();
    await writeFile(path.join(imageDirectory, 'avatar.png'), pixels);
    await writeFile(path.join(imageDirectory, '.avatar-initialized.json'), JSON.stringify({ companionId: owner.id, role: 'avatar', path: 'avatar.png' }));
    const readRuntimeSelection = vi.fn(async (ownerId: string) => {
      const response = await f.request({ type: 'companion.assets.initialized', companionId: ownerId });
      const current = response.companion;
      if (!response.ok || !current || current.id !== ownerId) throw new Error('Missing exact owner.');
      return { id: current.id, avatar: current.avatar, templateId: current.templateId,
        avatarAttachmentId: current.avatarAttachmentId, appearanceAttachmentId: current.appearanceAttachmentId };
    });
    const request = vi.fn(async (command: CompanionStorageCommand) => {
      if (command.type === 'companion.assets.initialized') throw new Error('Image metadata must not enter Main profile hydration.');
      return f.request(command);
    });
    const loader = new CompanionPublicProfiles({ root: f.root, appPath: f.root, profileStore: profiles, request, readRuntimeSelection,
      readStateMetadata: async () => f.store.request({ type: 'state', includeHidden: true }).state });
    const hydrate = vi.spyOn(profiles, 'bootstrapProfile'), strictRead = vi.spyOn(profiles, 'loadProfile');
    expect((await loader.readOwnerImage(owner.id, 'avatar'))?.bytes).toEqual(pixels);
    expect(readRuntimeSelection).toHaveBeenCalledTimes(2);
    expect(strictRead).toHaveBeenCalledTimes(2);
    expect(hydrate).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([command]) => command.type === 'companion.assets.initialized')).toBe(false);
    // Image choices have always remained current SQL fields: profile hydration
    // replaces name/description/persona, never resurrects an old image choice.
    f.store.updateCompanion(owner.id, { ...owner, avatar: 'custom' });
    expect((await profiles.loadProfile(owner.id)).profile.avatar).toBe('sister');
    expect(await loader.readOwnerImage(owner.id, 'avatar')).toBeUndefined();
    const input = { companionId: owner.id, conversation: f.store.openPrivate(owner.id) };
    await loader.prepare(input);
    expect(hydrate.mock.calls.map(([member]) => member.id)).toEqual(['alice']);
    await writeFile(path.join(f.directory, owner.id, 'profile.md'), 'unregistered replacement', 'utf8');
    await expect(loader.prepare(input)).rejects.toMatchObject({ code: 'CHANGED' });
  } finally { await f.close(); }
});

it('rejects a metadata selection callback returning a different owner', async () => {
  const f = managedMemoryFiles();
  try {
    const owner = f.store.state().companions.find(owner => owner.id === 'alice')!;
    const profiles = new CompanionAssetProfileStore(f.directory, { registryStorage: { request: f.request } });
    await profiles.bootstrap(owner);
    const loader = new CompanionPublicProfiles({ root: f.root, appPath: f.root, profileStore: profiles, request: f.request,
      readRuntimeSelection: async () => ({ id: 'bob', avatar: 'sister' }) });
    await expect(loader.readOwnerImage(owner.id, 'avatar')).rejects.toThrow('伙伴当前运行形象选择不可核验');
  } finally { await f.close(); }
});
