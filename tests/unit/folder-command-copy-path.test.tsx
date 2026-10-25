// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { useFolderCommandShortcuts } from '../../src/renderer/use-folder-command-shortcuts';

test('a focused sidebar folder owns copy-path even when assets remain selected', async () => {
  const copyFolderPath = vi.fn();
  function Harness() {
    useFolderCommandShortcuts({
      enabled: true, platform: 'windows', previewOpen: false,
      browseManagedFolderId: null, selectedFolderCardIds: [], selectedAssetCount: 2,
      resolveManagedFolderName: () => 'Folder', copyFolderPath,
      openFolderInFileManager: vi.fn(), createSubfolder: vi.fn(), copyFolder: vi.fn(),
      pasteIntoFolder: vi.fn(), renameFolder: vi.fn(), trashManagedFolder: vi.fn(),
      deleteFolderFromDisk: vi.fn(),
    });
    return createElement('button', {
      'data-nav-folder-id': 'focused-folder', 'data-nav-folder-kind': 'managed',
    }, 'Folder');
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Harness)));
    host.querySelector('button')!.focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    });
    expect(copyFolderPath).toHaveBeenCalledExactlyOnceWith('focused-folder');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
