import { ipcRenderer } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { companions } from '../../src/preload/bridge/companions';
import { COMPANIONS_CHANNEL, COMPANIONS_CHANGED_CHANNEL, COMPANION_REPLY_STREAM_CHANNEL } from '../../src/shared/companions';
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
it('accepts only the exact progress notification and preserves full refreshes for legacy or unknown changes', () => {
  const listener = vi.fn(), unsubscribe = companions.onChanged(listener);
  const handler = vi.mocked(ipcRenderer.on).mock.calls[0]![1];
  for (const payload of [{ kind: 'progress' }, undefined, { kind: 'content' }, { kind: 'progress', sourceRevoked: true }, null]) handler({} as Electron.IpcRendererEvent, payload);
  expect(listener.mock.calls).toEqual([[{ kind: 'progress' }], [undefined], [undefined], [undefined], [undefined]]);
  expect(ipcRenderer.on).toHaveBeenCalledWith(COMPANIONS_CHANGED_CHANNEL, handler);
  unsubscribe(); expect(ipcRenderer.removeListener).toHaveBeenCalledWith(COMPANIONS_CHANGED_CHANNEL, handler);
});
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
it('preserves a validated world snapshot through the public bridge and rejects direct client position mutations', async () => {
  const world = { settings: { revision: 2, mode: 'compressed', dayDurationMinutes: 20, timeZone: 'Asia/Shanghai' }, clock: { realNow: '2026-10-14T08:00:00Z', virtualNow: '2026-10-14T08:00:00Z', speed: 72, day: 1, hour: 16, daylight: true }, environment: { weather: 'clear', light: 1, outdoorTemperature: 22, indoorTemperature: 21 }, scenes: [], residents: [], actors: [], visits: [], events: [], relationships: [], works: [], lastEventSequence: 0, backlog: false };
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ ok: true, world });
  expect(await companions.request({ type: 'world.snapshot' })).toEqual({ ok: true, world });
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(COMPANIONS_CHANNEL, { type: 'world.snapshot' });
  const result = await companions.request({ type: 'world.snapshot', position: { x: 0, y: 0 } } as never);
  expect(result.ok).toBe(false); expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
});
