// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { companionGazePointer } from '../../src/main/companion-gaze-pointer';
import { parseCompanionGazeResult } from '../../src/shared/companion-gaze';
import { normalizeCallPointer, trackCallGaze } from '../../src/renderer/companion-bot/call-gaze';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
function fixture() {
  const host = document.createElement('div'); document.body.append(host);
  host.getBoundingClientRect = () => ({ left: 100, top: 100, width: 400, height: 500 } as DOMRect);
  return { host, target: { point: vi.fn(), leave: vi.fn() } };
}
it('maps desktop DIP across a negative-origin monitor and page zoom without a screen-scale multiplication', () => {
  expect(companionGazePointer({ cursor: { x: -1700, y: 900 }, contentBounds: { x: -2100, y: 150 }, zoomFactor: 1.25 }))
    .toEqual({ ok: true, point: { x: 320, y: 600 } });
  expect(companionGazePointer({ cursor: { x: 1, y: 2 }, contentBounds: { x: 0, y: 0 }, zoomFactor: 0 })).toEqual({ ok: false });
  expect(parseCompanionGazeResult({ ok: true, point: { x: NaN, y: 1 } })).toEqual({ ok: false });
});
it('clamps a cursor outside the application and rejects zero-size layout', () => {
  expect(normalizeCallPointer({ x: -400, y: 1200 }, { left: 100, top: 100, width: 400, height: 500 })).toEqual({ x: -1, y: -1 });
  expect(normalizeCallPointer({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 })).toBeUndefined();
});
it('uses one native stream through controls/window leave and stops polling when disabled or unmounted', async () => {
  vi.useFakeTimers(); const f = fixture();
  const read = vi.fn(async () => ({ ok: true as const, point: { x: 1000, y: 800 } }));
  const tracking = trackCallGaze(f.host, f.target, read);
  await vi.advanceTimersByTimeAsync(110);
  expect(read.mock.calls.length).toBe(4); expect(f.target.point).toHaveBeenLastCalledWith(1, -1);
  const input = document.createElement('textarea'); document.body.append(input);
  input.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }));
  f.host.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
  window.dispatchEvent(new Event('blur'));
  expect(f.target.leave).not.toHaveBeenCalled(); expect(f.target.point).toHaveBeenLastCalledWith(1, -1);
  tracking.enabled(false); const count = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(count);
  tracking.enabled(true); await vi.advanceTimersByTimeAsync(40); expect(read.mock.calls.length).toBeGreaterThan(count);
  tracking.stop(); const ended = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(ended);
});
it('discards pending samples after disable and never has concurrent IPC samples', async () => {
  vi.useFakeTimers(); const f = fixture(); let release!: (value: { ok: true; point: { x: number; y: number } }) => void;
  const read = vi.fn(() => new Promise<{ ok: true; point: { x: number; y: number } }>(resolve => { release = resolve; }));
  const tracking = trackCallGaze(f.host, f.target, read);
  await vi.advanceTimersByTimeAsync(500); expect(read).toHaveBeenCalledTimes(1);
  tracking.enabled(false); release({ ok: true, point: { x: 1000, y: 800 } });
  await vi.advanceTimersByTimeAsync(100); expect(f.target.point).not.toHaveBeenCalled();
  tracking.stop();
});
it('fallback captures pointer moves over an input without resetting when the canvas loses the pointer', () => {
  const f = fixture(), tracking = trackCallGaze(f.host, f.target, undefined);
  const input = document.createElement('textarea'); document.body.append(input);
  input.dispatchEvent(new PointerEvent('pointermove', { clientX: 500, clientY: 600, bubbles: true }));
  expect(f.target.point).toHaveBeenLastCalledWith(1, -1);
  f.host.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true })); expect(f.target.leave).not.toHaveBeenCalled();
  tracking.stop();
});
