// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ model: undefined as unknown, atlases: 1, masks: 0, initialize: vi.fn(), release: vi.fn(), maskSize: vi.fn(), remove: vi.fn(), expression: vi.fn(), motion: vi.fn(), stopExpressions: vi.fn(), neutralExpression: vi.fn() }));
vi.mock('pixi.js', () => ({ Application: class {
  view = document.createElement('canvas');
  stage = { addChild: vi.fn(), removeChild: fixture.remove };
  destroy = vi.fn();
} }));
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: { from: async () => fixture.model } }));
vi.mock('../../vendor/soullink-emotion/live2d-pixi/dist/motionParameters', () => ({
  loadCDIParameterMeta: async () => ({}), buildMotionParameters: () => ({}), readCurrentParameters: () => ({}),
}));
import { Live2DRenderer } from '../../vendor/soullink-emotion/live2d-pixi/dist/Live2DRenderer';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function renderRig(maskCount: number) {
  fixture.masks = maskCount; fixture.atlases = 1;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const manager = { _clippingContextListForMask: Array.from({ length: maskCount }), release: fixture.release };
  const core = {};
  fixture.model = { anchor: { set: vi.fn() }, scale: { set: vi.fn() }, width: 300, height: 600, destroy: vi.fn(), expression: fixture.expression, motion: fixture.motion,
    internalModel: { coreModel: core, on: vi.fn(), off: vi.fn(), motionManager: { expressionManager: { reserveExpressionIndex: -1, stopAllExpressions: fixture.stopExpressions, resetExpression: fixture.neutralExpression } }, renderer: { _clippingManager: manager,
      initialize: fixture.initialize.mockImplementation((_model, atlasCount) => { fixture.atlases = atlasCount; }), setClippingMaskBufferSize: fixture.maskSize } } };
  const renderer = new Live2DRenderer(document.createElement('div'), { cubismLoader: async () => undefined });
  await renderer.load('local.model3.json'); return { renderer, core };
}
it('allocates two independent mask atlases for the real 49-group rig instead of overlapping face masks', async () => {
  const { renderer, core } = await renderRig(49);
  expect(fixture.release).toHaveBeenCalledOnce(); expect(fixture.initialize).toHaveBeenCalledWith(core, 2);
  expect(fixture.maskSize).toHaveBeenCalledWith(1024); renderer.destroy(); expect(fixture.remove).toHaveBeenCalledOnce();
});
it('keeps a compatible single atlas for smaller rigs and preserves the mask resolution', async () => {
  const { renderer } = await renderRig(12);
  expect(fixture.initialize).not.toHaveBeenCalled(); expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.maskSize).toHaveBeenCalledWith(1024); renderer.destroy();
});
it('returns to a neutral expression without ever selecting a random costume or face', async () => {
  const { renderer } = await renderRig(49);
  renderer.applyNativeAnimation(null); renderer.applyNativeAnimation(null);
  expect(fixture.expression).not.toHaveBeenCalled(); expect(fixture.neutralExpression).toHaveBeenCalledOnce();
  renderer.applyNativeAnimation({ token: 4, expression: '脸红', motion: null, suppressParamIds: ['key7'] });
  expect(fixture.expression).toHaveBeenCalledExactlyOnceWith('脸红');
  renderer.applyNativeAnimation(null); expect(fixture.expression).toHaveBeenCalledTimes(1); expect(fixture.neutralExpression).toHaveBeenCalledTimes(2);
  expect(renderer.suppressedParameterIds.size).toBe(0); renderer.destroy();
});
it('changes mouth ownership on an existing token without replaying the selected manual native action', async () => {
  const { renderer } = await renderRig(49);
  const motion = { group: 'Interaction', index: 2, priority: 'force' as const };
  renderer.applyNativeAnimation({ token: 9, expression: '脸红', motion, suppressParamIds: ['key7', 'ParamMouthOpenY'] });
  renderer.applyNativeAnimation({ token: 9, expression: '脸红', motion, suppressParamIds: ['key7'] });
  expect(fixture.motion).toHaveBeenCalledExactlyOnceWith('Interaction', 2, 3); expect(fixture.expression).toHaveBeenCalledTimes(1);
  expect(renderer.suppressedParameterIds.has('key7')).toBe(true); expect(renderer.suppressedParameterIds.has('ParamMouthOpenY')).toBe(false);
  renderer.destroy();
});
