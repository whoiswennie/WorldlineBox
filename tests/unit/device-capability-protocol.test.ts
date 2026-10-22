import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }, webUtils: { getPathForFile: vi.fn() } }));
vi.mock('../../src/preload/transport', () => ({ request: vi.fn(), failure: vi.fn((result: { error: unknown }) => ({ ok: false, error: result.error })), importRequest: vi.fn() }));
import { rendererRequestSchema } from '../../src/shared/protocol/requests';
import { rendererResultSchema } from '../../src/shared/protocol/responses';
import { request } from '../../src/preload/transport';
import { library } from '../../src/preload/bridge/library';

const capability = { version: 1, benchmarkVersion: 'embeddinggemma2-device-v1', state: 'unchecked', stage: '', message: 'Not checked.', retryable: true, cacheUsed: false,
  budgets: { minimumAvailableMemoryBytes: 1, textMedianMs: 1, imageMs: 1, startupMs: 1, totalMs: 1 } } as const;

describe('local device capability IPC contracts', () => {
  it('accepts only explicit bounded device operations without paths or executable overrides', () => {
    for (const type of ['embedding.device.status.request', 'embedding.device.cancel.request', 'device.hardware.status.request']) {
      expect(rendererRequestSchema.safeParse({ type }).success).toBe(true);
      expect(rendererRequestSchema.safeParse({ type, runtimePath: 'C:/other.exe' }).success).toBe(false);
    }
    expect(rendererRequestSchema.safeParse({ type: 'embedding.device.test.request', force: true }).success).toBe(true);
    expect(rendererRequestSchema.safeParse({ type: 'embedding.device.test.request', force: 'yes' }).success).toBe(false);
    expect(rendererRequestSchema.safeParse({ type: 'embedding.device.test.request', totalMemoryBytes: Infinity }).success).toBe(false);
    expect(rendererResultSchema.safeParse({ ok: true, type: 'embedding.device.status', capability }).success).toBe(true);
    expect(rendererResultSchema.safeParse({ ok: true, type: 'device.hardware.status', totalMemoryBytes: -1, availableMemoryBytes: 4 }).success).toBe(false);
  });
  it('maps status, force test and cancel to the narrow preload operations', async () => {
    vi.mocked(request).mockResolvedValue({ ok: true, type: 'embedding.device.status', capability });
    await expect(library.embeddingDeviceStatus()).resolves.toEqual({ ok: true, value: capability });
    expect(request).toHaveBeenLastCalledWith({ type: 'embedding.device.status.request' });
    await expect(library.embeddingDeviceTest({ force: true })).resolves.toEqual({ ok: true, value: capability });
    expect(request).toHaveBeenLastCalledWith({ type: 'embedding.device.test.request', force: true });
    await library.embeddingDeviceCancel(); expect(request).toHaveBeenLastCalledWith({ type: 'embedding.device.cancel.request' });
    vi.mocked(request).mockResolvedValue({ ok: true, type: 'device.hardware.status', totalMemoryBytes: 16_000, availableMemoryBytes: 8_000 });
    await expect(library.deviceHardwareStatus()).resolves.toEqual({ ok: true, value: { totalMemoryBytes: 16_000, availableMemoryBytes: 8_000 } });
    expect(request).toHaveBeenLastCalledWith({ type: 'device.hardware.status.request' });
  });
});
