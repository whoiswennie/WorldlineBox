// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('checks a single detached 1x1 WebGL2 canvas, draws nothing and immediately releases its context', async () => {
  const loseContext = vi.fn();
  const gl = { isContextLost: vi.fn(() => false), getContextAttributes: vi.fn(() => ({ alpha: false })), getExtension: vi.fn(() => ({ loseContext })) };
  const create = document.createElement.bind(document), canvas = create('canvas'), remove = vi.spyOn(canvas, 'remove');
  const getContext = vi.spyOn(canvas, 'getContext').mockReturnValue(gl as unknown as WebGL2RenderingContext);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => tag === 'canvas' ? canvas : create(tag)) as typeof document.createElement);
  const { checkWorldGraphicsCapability, getWorldGraphicsCapability, subscribeWorldGraphicsCapability } = await import('../../src/renderer/device-capabilities/world-graphics-probe');
  expect(getWorldGraphicsCapability()).toBeUndefined();
  const changed = vi.fn(), unsubscribe = subscribeWorldGraphicsCapability(changed);
  const result = checkWorldGraphicsCapability({ totalMemoryBytes: 8 * 1024 ** 3 });
  expect(result).toMatchObject({ status: 'available', webgl2: true, memorySource: 'system' });
  expect(getContext).toHaveBeenCalledOnce(); expect(getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({ antialias: true, preserveDrawingBuffer: false }));
  expect(canvas.width).toBe(1); expect(canvas.height).toBe(1); expect(canvas.isConnected).toBe(false);
  expect(gl.getExtension).toHaveBeenCalledWith('WEBGL_lose_context'); expect(loseContext).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce(); expect(getWorldGraphicsCapability()).toBe(result);
  unsubscribe(); checkWorldGraphicsCapability(); expect(changed).toHaveBeenCalledOnce();
});

it('fails closed for a null/lost/throwing context, while a user-requested recheck can recover', async () => {
  const canvas = document.createElement('canvas'), create = document.createElement.bind(document);
  const getContext = vi.spyOn(canvas, 'getContext').mockReturnValue(null);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => tag === 'canvas' ? canvas : create(tag)) as typeof document.createElement);
  const { checkWorldGraphicsCapability, markWorldGraphicsUnavailable, getWorldGraphicsCapability } = await import('../../src/renderer/device-capabilities/world-graphics-probe');
  expect(checkWorldGraphicsCapability()).toMatchObject({ status: 'unavailable', reasonCode: 'webgl2_unavailable' });
  getContext.mockImplementationOnce(() => { throw new Error('Driver unavailable'); });
  expect(checkWorldGraphicsCapability()).toMatchObject({ status: 'unavailable', reasonCode: 'probe_failed' });
  const gl: { isContextLost(): boolean; getContextAttributes(): WebGLContextAttributes | null; getExtension(): null } = { isContextLost: () => true, getContextAttributes: () => null, getExtension: () => null };
  getContext.mockReturnValue(gl as unknown as WebGL2RenderingContext);
  expect(checkWorldGraphicsCapability()).toMatchObject({ status: 'unavailable', reasonCode: 'context_lost' });
  gl.isContextLost = () => false; gl.getContextAttributes = () => ({ alpha: false });
  expect(checkWorldGraphicsCapability()).toHaveProperty('status', 'available');
  markWorldGraphicsUnavailable('context_lost', '真实场景发生上下文中断。');
  expect(getWorldGraphicsCapability()).toMatchObject({ status: 'unavailable', reasonCode: 'context_lost', webgl2: true });
});
