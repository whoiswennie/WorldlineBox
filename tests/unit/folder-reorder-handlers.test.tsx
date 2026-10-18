// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { LocaleProvider } from '../../src/renderer/i18n';
import {
  useFolderDragDropHandlers,
  type UseFolderDragDropHandlersParams,
} from '../../src/renderer/use-folder-drag-drop-handlers';

describe('non-blocking sidebar folder moves', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let handlers: ReturnType<typeof useFolderDragDropHandlers>;

  function Harness({ params }: { params: UseFolderDragDropHandlersParams }) {
    handlers = useFolderDragDropHandlers(params);
    return null;
  }

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  async function render(params: UseFolderDragDropHandlersParams) {
    if (!container) {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(createElement(LocaleProvider, null, createElement(Harness, { params })));
    });
  }

  function inputs(moveFolders: WorldlineBoxLibraryApi['moveFolders']) {
    return {
      api: { moveFolders } as WorldlineBoxLibraryApi,
      libraryId: 'library-a',
      assetScope: 'root',
      folders: [{
        folderId: 'child', parentFolderId: 'parent', name: 'Child',
        relativePath: 'Parent/Child', directAssetCount: 0, childFolderCount: 0,
      }],
      setNotice: vi.fn(),
      setError: vi.fn(),
      setUiState: vi.fn(),
      reloadCurrentContent: vi.fn(async () => undefined),
      onManagedFoldersTrashed: vi.fn(),
      onDeletedCurrentScope: vi.fn(async () => undefined),
    } satisfies UseFolderDragDropHandlersParams;
  }

  it('serializes pending moves and refreshes without opening the loading overlay', async () => {
    let finish: (result: Awaited<ReturnType<WorldlineBoxLibraryApi['moveFolders']>>) => void;
    const move = vi.fn<WorldlineBoxLibraryApi['moveFolders']>(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const params = inputs(move);
    await render(params);

    await act(async () => {
      handlers.handleFoldersDroppedOnFolder(null, ['child'], { blockingUi: false });
      handlers.handleFoldersDroppedOnFolder(null, ['child'], { blockingUi: false });
    });
    expect(move).toHaveBeenCalledTimes(1);
    expect(params.setUiState).not.toHaveBeenCalled();
    expect(params.reloadCurrentContent).not.toHaveBeenCalled();

    await act(async () => finish!({ ok: true, value: { movedCount: 1, skippedCount: 0, folders: params.folders } }));
    expect(params.reloadCurrentContent).toHaveBeenCalledTimes(1);
    expect(params.setNotice).toHaveBeenCalledTimes(1);
    expect(params.setError).not.toHaveBeenCalled();
    expect(params.setUiState).not.toHaveBeenCalled();

    await act(async () => handlers.handleFoldersDroppedOnFolder(null, ['child'], { blockingUi: false }));
    expect(move).toHaveBeenCalledTimes(2);
    await act(async () => finish!({ ok: true, value: { movedCount: 1, skippedCount: 0, folders: params.folders } }));
  });

  it('keeps ordinary moves blocking and releases the guard after an error', async () => {
    const move = vi.fn<WorldlineBoxLibraryApi['moveFolders']>().mockRejectedValue(new Error('Disk is unavailable'));
    const params = inputs(move);
    await render(params);
    await act(async () => handlers.handleFoldersDroppedOnFolder(null, ['child']));
    expect(params.setUiState.mock.calls).toEqual([['loading'], ['ready']]);
    expect(params.setError).toHaveBeenCalledTimes(1);
    expect(params.reloadCurrentContent).not.toHaveBeenCalled();
    await act(async () => handlers.handleFoldersDroppedOnFolder(null, ['child']));
    expect(move).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'] as const)('ignores a late %s after switching to another library', async (outcome) => {
    let finish: (result: Awaited<ReturnType<WorldlineBoxLibraryApi['moveFolders']>>) => void;
    let fail: (error: Error) => void;
    const move = vi.fn<WorldlineBoxLibraryApi['moveFolders']>(() => new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }));
    const params = inputs(move);
    await render(params);
    await act(async () => handlers.handleFoldersDroppedOnFolder(null, ['child'], { blockingUi: false }));
    await render({ ...params, libraryId: 'library-b' });

    await act(async () => {
      if (outcome === 'success') {
        finish!({ ok: true, value: { movedCount: 1, skippedCount: 0, folders: params.folders } });
      } else {
        fail!(new Error('Disk is unavailable'));
      }
    });
    expect(params.setNotice).not.toHaveBeenCalled();
    expect(params.setError).not.toHaveBeenCalled();
    expect(params.setUiState).not.toHaveBeenCalled();
    expect(params.reloadCurrentContent).not.toHaveBeenCalled();
  });
});
