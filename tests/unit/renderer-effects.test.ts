import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { bindRendererEffects, rendererEffectsMode } from '../../src/main/renderer-effects';

it('retains full effects only when both actual rasterization and compositing are accelerated', () => {
  expect(rendererEffectsMode({ gpu_compositing: 'enabled', rasterization: 'enabled' })).toBe('full');
  expect(rendererEffectsMode({ gpu_compositing: 'enabled_on', rasterization: 'enabled_force' })).toBe('full');
  for (const status of ['disabled_software', 'unavailable_software', 'enabled_software', 'disabled_off', undefined]) {
    expect(rendererEffectsMode({ gpu_compositing: status, rasterization: 'enabled' })).toBe('reduced');
    expect(rendererEffectsMode({ gpu_compositing: 'enabled', rasterization: status })).toBe('reduced');
  }
  expect(rendererEffectsMode({})).toBe('reduced');
});

it('reapplies effects on DOM reload and GPU changes and removes all listeners on window close', async () => {
  const emitter = new EventEmitter(), page = new EventEmitter(), life = new EventEmitter();
  let status = { gpu_compositing: 'disabled_software', rasterization: 'disabled_software' }, destroyed = false;
  const execute = vi.fn(async (source: string) => { void source; });
  const application = { getGPUFeatureStatus: () => status, on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter) };
  const window = { webContents: { on: page.on.bind(page), removeListener: page.removeListener.bind(page), isDestroyed: () => destroyed, executeJavaScript: execute }, once: life.once.bind(life), isDestroyed: () => destroyed };
  bindRendererEffects(application as unknown as Parameters<typeof bindRendererEffects>[0], window as unknown as Parameters<typeof bindRendererEffects>[1]);
  page.emit('dom-ready'); expect(execute.mock.calls[0]?.[0]).toContain('"reduced"');
  status = { gpu_compositing: 'enabled', rasterization: 'enabled' }; emitter.emit('gpu-info-update');
  expect(execute.mock.calls[1]?.[0]).toContain('"full"');
  page.emit('dom-ready'); expect(execute).toHaveBeenCalledTimes(3);
  destroyed = true; emitter.emit('gpu-info-update'); expect(execute).toHaveBeenCalledTimes(3);
  destroyed = false; life.emit('closed'); expect(emitter.listenerCount('gpu-info-update')).toBe(0); expect(page.listenerCount('dom-ready')).toBe(0);
  await Promise.resolve();
});

it('never accesses native window properties or removes native listeners after destruction', () => {
  const emitter = new EventEmitter(), page = new EventEmitter(), life = new EventEmitter(); let destroyed = false;
  const contents = { on: page.on.bind(page), removeListener: vi.fn(), isDestroyed: () => destroyed, executeJavaScript: vi.fn(async () => undefined) };
  const application = { getGPUFeatureStatus: () => ({}), on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter) };
  const window = { get webContents() { if (destroyed) throw Error('Object has been destroyed'); return contents; }, once: life.once.bind(life), isDestroyed: () => destroyed };
  bindRendererEffects(application as unknown as Parameters<typeof bindRendererEffects>[0], window as unknown as Parameters<typeof bindRendererEffects>[1]);
  destroyed = true;
  expect(() => life.emit('closed')).not.toThrow();
  expect(contents.removeListener).not.toHaveBeenCalled(); expect(emitter.listenerCount('gpu-info-update')).toBe(0);
});

it('tolerates navigation destruction without producing an unhandled rejection', async () => {
  const emitter = new EventEmitter(), page = new EventEmitter(), life = new EventEmitter();
  const execute = vi.fn(async () => { throw new Error('Navigation destroyed the old world'); });
  const application = { getGPUFeatureStatus: () => ({}), on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter) };
  const window = { webContents: { on: page.on.bind(page), removeListener: page.removeListener.bind(page), isDestroyed: () => false, executeJavaScript: execute }, once: life.once.bind(life), isDestroyed: () => false };
  const dispose = bindRendererEffects(application as unknown as Parameters<typeof bindRendererEffects>[0], window as unknown as Parameters<typeof bindRendererEffects>[1]);
  page.emit('dom-ready'); await Promise.resolve(); dispose(); expect(execute).toHaveBeenCalledOnce();
});
