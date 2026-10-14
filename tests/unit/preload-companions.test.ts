import { ipcRenderer } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { companions } from '../../src/preload/bridge/companions';
import { COMPANION_REPLY_STREAM_CHANNEL } from '../../src/shared/companions';
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
it('validates reply stream frames and removes its exact IPC listener on unsubscribe', () => {
  const listener = vi.fn(), unsubscribe = companions.onReplyStream(listener);
  const handler = vi.mocked(ipcRenderer.on).mock.calls[0]![1];
  const frame = { conversationId: 'room', companionId: 'role', sourceMessageId: 'source', messageId: 'reply', step: 0, attemptId: 'attempt', text: '真实增量正文', phase: 'streaming' };
  handler({} as Electron.IpcRendererEvent, frame);
  handler({} as Electron.IpcRendererEvent, { ...frame, phase: 'unknown' });
  handler({} as Electron.IpcRendererEvent, { ...frame, arguments: '不要把工具参数混入正文' });
  handler({} as Electron.IpcRendererEvent, { ...frame, step: -1 });
  expect(listener).toHaveBeenCalledExactlyOnceWith(frame);
  expect(ipcRenderer.on).toHaveBeenCalledWith(COMPANION_REPLY_STREAM_CHANNEL, handler);
  unsubscribe(); expect(ipcRenderer.removeListener).toHaveBeenCalledWith(COMPANION_REPLY_STREAM_CHANNEL, handler);
});
