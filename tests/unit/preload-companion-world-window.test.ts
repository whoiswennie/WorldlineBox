import { ipcRenderer } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { companionWorld } from '../../src/preload/bridge/companion-world-window';
import { COMPANION_WORLD_WINDOW_CHANNEL, COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL } from '../../src/shared/companion-world-window';
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
it('validates the narrow observer API without exposing mutation, conversation, model or execution bridges', async () => {
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ ok: true });
  await companionWorld.open({ sceneId: 'park' }); expect(ipcRenderer.invoke).toHaveBeenCalledWith(COMPANION_WORLD_WINDOW_CHANNEL, { type: 'open', sceneId: 'park' });
  await expect(companionWorld.request({ type: 'message.send', content: 'unauthorized' } as never)).rejects.toThrow();
  expect(() => companionWorld.open({ sceneId: '../private' })).toThrow();
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  expect(Object.keys(companionWorld).sort()).toEqual(['context', 'control', 'onChanged', 'onVisibility', 'open', 'request']);
});
it('validates visibility counts and removes its exact listener', () => {
  const listener = vi.fn(), unsubscribe = companionWorld.onVisibility(listener), handler = vi.mocked(ipcRenderer.on).mock.calls[0]![1];
  handler({} as Electron.IpcRendererEvent, { visible: false, visibleWindowCount: 2 });
  handler({} as Electron.IpcRendererEvent, { visible: true, visibleWindowCount: -1 });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ visible: false, visibleWindowCount: 2 });
  unsubscribe(); expect(ipcRenderer.removeListener).toHaveBeenCalledWith(COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, handler);
});
