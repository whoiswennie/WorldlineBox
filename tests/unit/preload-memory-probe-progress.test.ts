import { ipcRenderer } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { companions } from '../../src/preload/bridge/companions';
import { COMPANIONS_CHANNEL } from '../../src/shared/companions';
import { COMPANION_MEMORY_PROBE_PROGRESS_CHANNEL } from '../../src/shared/companion-memory-probe-progress';

vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

it('validates probe progress receipts and unsubscribes the exact IPC listener', () => {
  const listener = vi.fn(), unsubscribe = companions.onMemoryProbeProgress!(listener);
  const handler = vi.mocked(ipcRenderer.on).mock.calls[0]![1];
  expect(ipcRenderer.on).toHaveBeenCalledExactlyOnceWith(COMPANION_MEMORY_PROBE_PROGRESS_CHANNEL, handler);
  const stage = { id: 'focus', label: '原版聚焦', elapsedMs: 120 };
  const event = { requestId: 'probe-1', companionId: 'alice', mode: 'passive', state: 'running', sequence: 1,
    stageId: 'focus', label: '原版聚焦', elapsedMs: 200, stageElapsedMs: 120, stages: [stage] };
  handler({} as Electron.IpcRendererEvent, event);
  expect(listener).toHaveBeenCalledExactlyOnceWith(event);
  for (const invalid of [
    { ...event, requestId: '' }, { ...event, companionId: 'bad/id' }, { ...event, mode: 'unknown' }, { ...event, state: 'unknown' },
    { ...event, sequence: 0 }, { ...event, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...event, elapsedMs: -1 }, { ...event, elapsedMs: Infinity },
    { ...event, stageElapsedMs: NaN }, { ...event, stageId: 'embedding' }, { ...event, stages: [stage, stage] },
    { ...event, stages: [{ ...stage, elapsedMs: -1 }] }, { ...event, secrets: 'unexpected raw payload' },
  ]) handler({} as Electron.IpcRendererEvent, invalid);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe(); expect(ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith(COMPANION_MEMORY_PROBE_PROGRESS_CHANNEL, handler);
});

it('passes a validated request id through the public request bridge and accepts both timed and legacy results', async () => {
  const command = { type: 'memory.recall.test' as const, companionId: 'alice', mode: 'active' as const, query: '固定合成查询', requestId: 'probe-1' };
  const probe = { companionId: 'alice', mode: 'active', query: command.query, observedAt: '2026-10-26T00:00:00Z', contextText: '', memories: [],
    pending: false, degraded: false, explanation: '合成测试', corpusStamp: 'stable' };
  const timing = { totalMs: 200, stages: [{ id: 'focus', label: '原版片段整理', elapsedMs: 120 }] };
  vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce({ ok: true, memoryProbe: { ...probe, timing } }).mockResolvedValueOnce({ ok: true, memoryProbe: probe });
  expect(await companions.request(command)).toEqual({ ok: true, memoryProbe: { ...probe, timing } });
  expect(ipcRenderer.invoke).toHaveBeenCalledWith(COMPANIONS_CHANNEL, command);
  expect((await companions.request(command)).memoryProbe).toEqual(probe);
  const calls = vi.mocked(ipcRenderer.invoke).mock.calls.length;
  expect((await companions.request({ ...command, requestId: '' })).ok).toBe(false);
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(calls);
});
