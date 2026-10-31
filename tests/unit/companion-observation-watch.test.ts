import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { CompanionAgendaObservation } from '../../src/main/companions/agenda-observation';
import type { CompanionObservationRecording, CompanionObservationWatchDriver } from '../../src/main/companions/observation-watch';
import { companionObserveArgumentsSchema, COMPANION_OBSERVE_TOOL } from '../../src/shared/companion-observe-tool';
import { boundaryGrant } from './companion-agenda-boundary-fixtures';

async function fixture() {
  const pixels = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const binding = { id: 'window:1:0', title: '编辑器', displayId: 'display-1' }, grant = boundaryGrant();
  const state = { locked: false, grant, sources: [binding] };
  // The controlled driver uses synthetic container bytes. This is a host
  // contract test; it does not claim to exercise native recording/encoding.
  const recorded: CompanionObservationRecording = { bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), mime: 'video/webm',
    width: 1280, height: 720, startedAt: '2026-10-29T10:00:00.000Z', endedAt: '2026-10-29T10:00:06.020Z', durationMs: 6020,
    frames: Array.from({ length: 6 }, (_, index) => ({ bytes: pixels, offsetMs: index * 1200 })) };
  const driver = vi.fn<CompanionObservationWatchDriver>(async input => { await input.verify(); return recorded; });
  const observer = new CompanionAgendaObservation({ locked: () => state.locked, sources: async () => state.sources,
    currentGrant: async () => state.grant, capture: vi.fn(), watch: driver });
  return { observer, state, driver, recorded, input: { companionId: 'alice', grantId: 'grant', sourceId: binding.id, binding } };
}

it('returns distinct real-media roles and a timestamped pixel storyboard from the controlled recording driver', async () => {
  const f = await fixture(), result = await f.observer.watch(f.input);
  expect(f.driver).toHaveBeenCalledOnce(); expect(f.driver.mock.calls[0]![0]).toMatchObject({ companionId: 'alice', seconds: 6, frameCount: 6, source: f.input.binding });
  expect(result.clip).toMatchObject({ mime: 'video/webm', durationMs: 6020, width: 1280, height: 720 });
  expect(result.frames.map(frame => frame.offsetMs)).toEqual([0, 1200, 2400, 3600, 4800, 6000]);
  expect(result.frames.at(-1)!.observedAt).toBe('2026-10-29T10:00:06.000Z');
  expect(await sharp(result.storyboard.bytes).metadata()).toMatchObject({ width: 1080, height: 488, format: 'png' });
  expect(result.grantRevision).toBe(1); expect(result.source.id).toBe(f.input.sourceId);
});

it.each(['locked', 'revoked', 'revision', 'window', 'aborted'] as const)('withholds every clip/frame when %s changes during continuous observation', async change => {
  const f = await fixture(), controller = new AbortController();
  f.driver.mockImplementationOnce(async input => {
    await input.verify();
    if (change === 'locked') f.state.locked = true;
    if (change === 'revoked') f.state.grant.status = 'revoked';
    if (change === 'revision') f.state.grant.revision++;
    if (change === 'window') f.state.sources = [{ ...f.input.binding, title: '句柄已复用的其他窗口' }];
    if (change === 'aborted') controller.abort();
    return f.recorded;
  });
  await expect(f.observer.watch({ ...f.input, signal: controller.signal })).rejects.toThrow();
});

it('rejects a still PNG, missing frame samples and fabricated timestamps instead of calling them a clip', async () => {
  const f = await fixture(); f.driver.mockResolvedValueOnce({ ...f.recorded, bytes: f.recorded.frames[0]!.bytes });
  await expect(f.observer.watch(f.input)).rejects.toThrow('截图冒充视频');
  f.driver.mockResolvedValueOnce({ ...f.recorded, frames: f.recorded.frames.slice(0, 1) });
  await expect(f.observer.watch(f.input)).rejects.toThrow('截图冒充视频');
  f.driver.mockResolvedValueOnce({ ...f.recorded, endedAt: '2026-10-29T10:03:00.000Z' });
  await expect(f.observer.watch(f.input)).rejects.toThrow('起止时间');
});

it('admits independent partner recordings concurrently without the interactive CaptureTools singleton', async () => {
  const f = await fixture(); let entered = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const driver: CompanionObservationWatchDriver = async input => { entered++; if (entered === 2) release(); await gate; await input.verify(); return f.recorded; };
  const observer = new CompanionAgendaObservation({ sources: async () => f.state.sources, capture: vi.fn(), locked: () => false,
    currentGrant: async owner => ({ ...f.state.grant, companionId: owner }), watch: driver });
  const results = await Promise.all(['alice', 'bob'].map(companionId => observer.watch({ ...f.input, companionId })));
  expect(entered).toBe(2); expect(results).toHaveLength(2);
});

it('preserves inspect/capture and exports watch defaults without a provider root union', async () => {
  expect(companionObserveArgumentsSchema.parse({ action: 'inspect' })).toEqual({ action: 'inspect' });
  expect(companionObserveArgumentsSchema.parse({ action: 'capture', sourceId: 'window:1:0' })).toEqual({ action: 'capture', sourceId: 'window:1:0' });
  expect(companionObserveArgumentsSchema.parse({ action: 'watch', sourceId: 'window:1:0' })).toMatchObject({ seconds: 6, frameCount: 6 });
  expect(companionObserveArgumentsSchema.safeParse({ action: 'watch', sourceId: 'window:1:0', seconds: 3600 }).success).toBe(false);
  expect(COMPANION_OBSERVE_TOOL.parameters).not.toHaveProperty('oneOf'); expect(COMPANION_OBSERVE_TOOL.parameters).not.toHaveProperty('anyOf');
  const f = await fixture(); f.state.locked = true; await expect(f.observer.watch(f.input)).rejects.toThrow('锁定'); expect(f.driver).not.toHaveBeenCalled();
});
