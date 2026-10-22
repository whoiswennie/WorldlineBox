// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingDeviceCapability } from '../../src/shared/embedding/device-capability';
import type { WorldGraphicsCapability } from '../../src/shared/world-graphics-capability';
import { DeviceCapabilitySettings, type DeviceCapabilitySettingsApi } from '../../src/renderer/DeviceCapabilitySettings';
import { LocaleProvider } from '../../src/renderer/i18n';

const graphics = vi.hoisted(() => ({ report: undefined as WorldGraphicsCapability | undefined, listeners: new Set<() => void>(), check: vi.fn() }));
vi.mock('../../src/renderer/device-capabilities/world-graphics-probe', () => ({
  getWorldGraphicsCapability: () => graphics.report,
  subscribeWorldGraphicsCapability: (listener: () => void) => { graphics.listeners.add(listener); return () => graphics.listeners.delete(listener); },
  checkWorldGraphicsCapability: (options: unknown) => {
    graphics.check(options);
    graphics.report = { status: 'available', checkedAt: '2026-10-22T02:00:00Z', webgl2: true, minimumMemoryGiB: 4 };
    graphics.listeners.forEach(listener => listener());
    return graphics.report;
  },
}));

const budgets = { minimumAvailableMemoryBytes: 1_024 ** 3, textMedianMs: 2_000, imageMs: 5_000, startupMs: 10_000, totalMs: 30_000 };
function capability(patch: Partial<EmbeddingDeviceCapability> = {}): EmbeddingDeviceCapability {
  return { version: 1, benchmarkVersion: 'embeddinggemma2-device-v1', state: 'unchecked', stage: '', message: '当前尚未检测设备。', retryable: true, cacheUsed: false, budgets, ...patch };
}
function fixture(value = capability()) {
  let current = value;
  return {
    embeddingDeviceStatus: vi.fn(async () => ({ ok: true as const, value: current })),
    embeddingDeviceTest: vi.fn(async () => ({ ok: true as const, value: current = capability({ state: 'supported', backend: 'cpu', message: '本机 CPU 通过轻量运行检测。', testedAt: '2026-10-22T01:00:00Z' }) })),
    embeddingDeviceCancel: vi.fn(async () => ({ ok: true as const, value: current = capability({ state: 'unchecked', reason: 'cancelled', message: '设备检测已取消。' }) })),
    deviceHardwareStatus: vi.fn(async () => ({ ok: true as const, value: { totalMemoryBytes: 16 * 1_024 ** 3, availableMemoryBytes: 8 * 1_024 ** 3 } })),
  } satisfies DeviceCapabilitySettingsApi;
}
let root: Root | undefined, container: HTMLDivElement | undefined;
const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => { graphics.report = undefined; graphics.check.mockClear(); reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; graphics.listeners.clear(); vi.useRealTimers(); vi.restoreAllMocks(); reactEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });
async function mount(content: ReactNode) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<LocaleProvider initialPreference="zh-CN">{content}</LocaleProvider>); });
}
function region(label: string) { return container!.querySelector<HTMLElement>(`article[aria-label="${label}"]`)!; }
function button(parent: HTMLElement, text: string) { return [...parent.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text))!; }

describe('independent device checks in global model settings', () => {
  it('reads cached evidence without starting inference or a 3D probe; unchecked never appears available', async () => {
    const api = fixture(); await mount(<DeviceCapabilitySettings api={api} />);
    expect(api.embeddingDeviceStatus).toHaveBeenCalledOnce();
    expect(api.embeddingDeviceTest).not.toHaveBeenCalled(); expect(api.deviceHardwareStatus).not.toHaveBeenCalled(); expect(graphics.check).not.toHaveBeenCalled();
    expect(region('本地向量设备检测').querySelector('[role="status"]')?.textContent).toBe('未检测');
    expect(region('3D 世界设备检测').querySelector('[role="status"]')?.textContent).toBe('未检测');
    expect(container!.textContent).not.toContain('可以使用');
  });
  it('shows real supported backend and saved test timestamp after an explicit test', async () => {
    const api = fixture(); await mount(<DeviceCapabilitySettings api={api} />);
    await act(() => button(region('本地向量设备检测'), '检测设备').click());
    expect(api.embeddingDeviceTest).toHaveBeenCalledWith({ force: true });
    expect(region('本地向量设备检测').textContent).toContain('可以使用');
    expect(region('本地向量设备检测').textContent).toContain('检测于');
    expect(button(region('本地向量设备检测'), '重新检测')).toBeDefined();
    expect(graphics.check).not.toHaveBeenCalled();
  });
  it('explains unsupported vectors while keeping 3D independent and document access clear', async () => {
    const api = fixture(capability({ state: 'unsupported', message: '当前可用内存不足。', reason: 'memory_pressure', testedAt: '2026-10-22T01:00:00Z' }));
    await mount(<DeviceCapabilitySettings api={api} />);
    expect(region('本地向量设备检测').textContent).toContain('当前可用内存不足');
    expect(region('本地向量设备检测').textContent).toContain('普通资产全文搜索和已有文档查阅仍可使用');
    await act(() => button(region('3D 世界设备检测'), '检测设备').click());
    expect(api.deviceHardwareStatus).toHaveBeenCalledOnce();
    expect(graphics.check).toHaveBeenCalledWith({ totalMemoryBytes: 16 * 1_024 ** 3 });
    expect(region('3D 世界设备检测').querySelector('[role="status"]')?.textContent).toBe('可以使用');
    expect(region('本地向量设备检测').querySelector('[role="status"]')?.textContent).toBe('设备受限');
    expect(api.embeddingDeviceTest).not.toHaveBeenCalled();
  });
  it('polls only a running benchmark and can cancel it without reporting success', async () => {
    vi.useFakeTimers();
    const api = fixture(capability({ state: 'testing', stage: '验证图片向量', message: '正在进行短时检测。' }));
    await mount(<DeviceCapabilitySettings api={api} />);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(api.embeddingDeviceStatus.mock.calls.length).toBeGreaterThan(1);
    await act(() => button(region('本地向量设备检测'), '取消').click());
    expect(api.embeddingDeviceCancel).toHaveBeenCalledOnce();
    expect(region('本地向量设备检测').querySelector('[role="status"]')?.textContent).toBe('未检测');
    const count = api.embeddingDeviceStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(api.embeddingDeviceStatus).toHaveBeenCalledTimes(count);
    expect(container!.textContent).not.toContain('可以使用');
  });
  it('reports a failed check without leaking backend error text', async () => {
    const api = fixture(); api.embeddingDeviceTest.mockRejectedValueOnce(new Error('PRIVATE_DEVICE_FILE_PATH'));
    await mount(<DeviceCapabilitySettings api={api} />);
    await act(() => button(region('本地向量设备检测'), '检测设备').click());
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('设备检测未完成');
    expect(container!.textContent).not.toContain('PRIVATE_DEVICE_FILE_PATH');
    expect(region('本地向量设备检测').querySelector('[role="status"]')?.textContent).toBe('未检测');
  });
});
