import { describe, expect, it, vi } from 'vitest';

import { createWorldlineBoxGuestApi } from '../../src/scripting/worldlinebox-guest-api';

describe('WorldlineBox Guest API library scopes', () => {
  it('creates an immutable forLibrary scope without changing ambient calls', async () => {
    const executeCommand = vi.fn(async () => ({ items: [] }));
    const worldlinebox = createWorldlineBoxGuestApi({ executeCommand });

    await worldlinebox.assets!.list!();
    const scoped = worldlinebox.forLibrary('library-2');
    await scoped.assets!.list!();
    await worldlinebox.assets!.list!();

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'asset.list', {}, undefined);
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'asset.list', {}, {
      targetLibraryId: 'library-2',
    });
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'asset.list', {}, undefined);
    expect(() => worldlinebox.forLibrary('../outside')).toThrow('Invalid target library id.');
    expect(() => worldlinebox.forLibrary('library/other')).toThrow('Invalid target library id.');
  });

  it('does not expose a mutable target on the scoped command API', () => {
    const worldlinebox = createWorldlineBoxGuestApi({ executeCommand: async () => undefined });
    const scoped = worldlinebox.forLibrary('library-2');

    expect(scoped).not.toHaveProperty('forLibrary');
    expect(Object.isFrozen(scoped)).toBe(false);
  });

  it('maps ui.openDialog onto ui.dialog and unwraps the completion payload', async () => {
    const executeCommand = vi.fn(async () => ({ result: { crf: 23 } }));
    const worldlinebox = createWorldlineBoxGuestApi({ executeCommand });

    await expect(worldlinebox.ui!.openDialog!({
      dialogId: 'converter',
      payload: { kind: 'convert' },
    })).resolves.toEqual({ crf: 23 });
    expect(executeCommand).toHaveBeenCalledWith('ui.dialog', {
      dialogId: 'converter',
      payload: { kind: 'convert' },
    }, undefined);
  });

  it('projects guest asset pages onto the documented script asset shape', async () => {
    const executeCommand = vi.fn(async () => ({
      items: [{
        assetId: 'asset-nested',
        displayName: 'shot.mp4',
        rating: 2,
        favorite: false,
        locationKind: 'managed',
        managedFolderId: 'folder-1',
        currentRevisionId: 'rev-9',
        mimeType: 'video/mp4',
        mediaType: 'video',
        byteSize: 2048,
        relativeFilePath: '项目/shot.mp4',
      }],
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: false,
    }));
    const worldlinebox = createWorldlineBoxGuestApi({ executeCommand });
    await expect(worldlinebox.assets!.list!({ recursive: true, limit: 200, offset: 0 })).resolves.toEqual({
      items: [{
        id: 'asset-nested',
        name: 'shot.mp4',
        rating: 2,
        favorite: false,
        locationKind: 'managed',
        folderId: 'folder-1',
        currentRevisionId: 'rev-9',
        mimeType: 'video/mp4',
        mediaType: 'video',
        byteSize: 2048,
        relativeFilePath: '项目/shot.mp4',
      }],
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: false,
    });
    expect(executeCommand).toHaveBeenCalledWith('asset.list', {
      recursive: true,
      limit: 200,
      offset: 0,
    }, undefined);
  });

  it('does not leak absolute paths through guest asset pages', async () => {
    const executeCommand = vi.fn(async () => ({
      items: [{
        assetId: 'asset-a',
        displayName: 'first.png',
        relativeFilePath: '/must-not-reach-script/first.png',
        rating: 4,
        favorite: true,
        locationKind: 'managed',
        managedFolderId: 'folder-a',
      }],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    }));
    const worldlinebox = createWorldlineBoxGuestApi({ executeCommand });
    await expect(worldlinebox.assets!.list!()).resolves.toMatchObject({
      items: [{
        id: 'asset-a',
        relativeFilePath: '',
      }],
    });
  });

  it('forwards a complete file name through assets.renameFile', async () => {
    const executeCommand = vi.fn(async () => ({ assetId: 'asset-1', name: 'clip.webm' }));
    const worldlinebox = createWorldlineBoxGuestApi({ executeCommand });
    await worldlinebox.assets!.renameFile!('asset-1', 'clip', { fileName: 'clip.webm' });
    expect(executeCommand).toHaveBeenCalledWith('asset.rename-file', {
      assetId: 'asset-1',
      newFileName: 'clip.webm',
    }, undefined);
    await worldlinebox.assets!.renameFile!('asset-1', 'clip');
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'asset.rename-file', {
      assetId: 'asset-1',
      newBaseName: 'clip',
    }, undefined);
  });

  it('maps media.getBinaryPaths onto media.binaries.get', async () => {
    const executeCommand = vi.fn(async () => ({
      ffmpegPath: '/host/ffmpeg',
      ffprobePath: '/host/ffprobe',
    }));
    const worldlinebox = createWorldlineBoxGuestApi({ executeCommand });

    await expect(worldlinebox.media!.getBinaryPaths!()).resolves.toEqual({
      ffmpegPath: '/host/ffmpeg',
      ffprobePath: '/host/ffprobe',
    });
    expect(executeCommand).toHaveBeenCalledWith('media.binaries.get', {}, undefined);
  });
});
