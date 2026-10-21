import { describe, expect, it, vi } from 'vitest';
import { windowsSnapshotPixels, type WindowsSnapshotApi } from '../../src/main/capture-tools/windows-snapshot';

function fixture() {
  const api: WindowsSnapshotApi = {
    getDC: vi.fn(() => 10), releaseDC: vi.fn(() => 1), createDC: vi.fn(() => 20), deleteDC: vi.fn(() => 1),
    createBitmap: vi.fn(() => 30), deleteObject: vi.fn(() => 1), selectObject: vi.fn(() => 40),
    bitBlt: vi.fn(() => 1), getDIBits: vi.fn((_dc, _bitmap, _start, lines, pixels) => { pixels.fill(127); return lines; }),
    setDpi: vi.fn(() => -3), flush: vi.fn(() => 0),
  };
  return api;
}
const bounds = { x: -1920, y: 20, width: 640, height: 480 };
describe('on-demand native monitor snapshots', () => {
  it('copies physical pixels in top-down order and releases all handles before returning', () => {
    const api = fixture(); const pixels = windowsSnapshotPixels(bounds, api)!;
    expect(pixels).toHaveLength(640 * 480 * 4); expect(pixels[0]).toBe(127);
    expect(api.bitBlt).toHaveBeenCalledWith(20, 0, 0, 640, 480, 10, -1920, 20, 0x40cc0020);
    const info = vi.mocked(api.getDIBits).mock.calls[0]![5];
    expect(info.readInt32LE(8)).toBe(-480); expect(info.readUInt16LE(14)).toBe(32);
    expect(api.selectObject).toHaveBeenNthCalledWith(2, 20, 40);
    expect(vi.mocked(api.selectObject).mock.invocationCallOrder[1]!).toBeLessThan(vi.mocked(api.getDIBits).mock.invocationCallOrder[0]!);
    expect(api.deleteObject).toHaveBeenCalledWith(30); expect(api.deleteDC).toHaveBeenCalledWith(20);
    expect(api.releaseDC).toHaveBeenCalledWith(0, 10); expect(api.setDpi).toHaveBeenLastCalledWith(-3);
  });
  it.each(['getDC', 'createDC', 'createBitmap', 'selectObject', 'bitBlt', 'getDIBits'] as const)('cleans up partial failure at %s so repeated use cannot leak GDI handles', stage => {
    const api = fixture(); vi.mocked(api[stage]).mockReturnValueOnce(0);
    expect(windowsSnapshotPixels(bounds, api)).toBeUndefined();
    if (stage !== 'getDC') expect(api.releaseDC).toHaveBeenCalledWith(0, 10);
    if (!['getDC', 'createDC'].includes(stage)) expect(api.deleteDC).toHaveBeenCalledWith(20);
    if (!['getDC', 'createDC', 'createBitmap'].includes(stage)) expect(api.deleteObject).toHaveBeenCalledWith(30);
    expect(api.setDpi).toHaveBeenLastCalledWith(-3);
  });
  it('bounds native allocation and leaves unsupported platforms to the standard capture path', () => {
    const api = fixture();
    for (const rect of [{ ...bounds, width: 0 }, { ...bounds, x: NaN }, { ...bounds, height: 1.5 }, { ...bounds, width: 32769 }, { ...bounds, width: 10000, height: 10000 }]) expect(windowsSnapshotPixels(rect, api)).toBeUndefined();
    expect(api.getDC).not.toHaveBeenCalled(); expect(windowsSnapshotPixels(bounds, null)).toBeUndefined();
  });
});
