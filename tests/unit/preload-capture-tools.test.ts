import { ipcRenderer } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { captureTools } from '../../src/preload/bridge/capture-tools';
import { CAPTURE_TOOLS_ANSWER_PROGRESS } from '../../src/shared/capture-answer';

vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
it('validates bounded UTF-8 snapshots and removes the exact progress listener on unsubscribe', () => {
  const listener = vi.fn(); const unsubscribe = captureTools.onAnswerProgress!(listener);
  expect(ipcRenderer.on).toHaveBeenCalledWith(CAPTURE_TOOLS_ANSWER_PROGRESS, expect.any(Function));
  const handler = vi.mocked(ipcRenderer.on).mock.calls[0]![1];
  const valid = { id: 'request', sequence: 1, text: '正文', reasoning: '公开思考' };
  handler({} as Electron.IpcRendererEvent, valid); expect(listener).toHaveBeenCalledExactlyOnceWith(valid);
  for (const invalid of [{ ...valid, sequence: 0 }, { ...valid, text: '中'.repeat(6000) }, { ...valid, reasoning: '中'.repeat(11000) }, { ...valid, secret: 'extra' }, { ...valid, id: '' }]) handler({} as Electron.IpcRendererEvent, invalid);
  expect(listener).toHaveBeenCalledTimes(1); unsubscribe();
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(CAPTURE_TOOLS_ANSWER_PROGRESS, handler);
});
