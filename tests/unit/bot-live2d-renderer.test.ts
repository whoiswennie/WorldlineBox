// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ model: undefined as unknown, atlases: 1, masks: 0, initialize: vi.fn(), release: vi.fn(), maskSize: vi.fn(), remove: vi.fn(), expression: vi.fn(), motion: vi.fn(), stopExpressions: vi.fn(), neutralExpression: vi.fn() }));
vi.mock('pixi.js', () => ({ Application: class {
  view = document.createElement('canvas');
  stage = { addChild: vi.fn(), removeChild: fixture.remove };
  ticker = { elapsedMS: 16, maxFPS: 0, lastTime: 0, add: vi.fn(), remove: vi.fn(), stop: vi.fn(), update: vi.fn() };
  screen = { width: 0, height: 0 };
  renderer = { resolution: 1, resize: (width: number, height: number) => Object.assign(this.screen, { width, height }) };
  destroy = vi.fn();
}, UPDATE_PRIORITY: { HIGH: 25 } }));
vi.mock('pixi-live2d-display/cubism4', () => ({ Live2DModel: { from: async () => fixture.model } }));
vi.mock('../../vendor/soullink-emotion/live2d-pixi/dist/motionParameters', () => ({
  loadCDIParameterMeta: async () => ({}), buildMotionParameters: () => ({}), readCurrentParameters: () => ({}),
}));
import { Live2DRenderer } from '../../vendor/soullink-emotion/live2d-pixi/dist/Live2DRenderer';
import { optimizeCubismScreenDraw } from '../../vendor/soullink-emotion/live2d-pixi/dist/screenDraw';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function renderRig(maskCount: number) {
  fixture.masks = maskCount; fixture.atlases = 1;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const manager = { _clippingContextListForMask: Array.from({ length: maskCount }), release: fixture.release };
  const pose: Record<string, number> = { ParamAngleX: 0, FrontHairX1: 0 };
  const ids = Object.keys(pose);
  const core = {
    getParameterIndex: (id: string) => ids.indexOf(id), getParameterCount: () => ids.length,
    setParameterValueById: (id: string, value: number) => { pose[id] = value; },
    getParameterValueByIndex: (index: number) => pose[ids[index]!]!,
    setParameterValueByIndex: (index: number, value: number) => { pose[ids[index]!] = value; },
  };
  const evaluate = vi.fn(() => { pose.FrontHairX1 = pose.ParamAngleX! / 30; pose.ParamAngleX = 0; });
  const physics = { evaluate };
  const on = vi.fn();
  const expressionManager = { currentExpression: {}, defaultExpression: {}, reserveExpressionIndex: -1,
    stopAllExpressions: fixture.stopExpressions, resetExpression: fixture.neutralExpression };
  fixture.model = { anchor: { set: vi.fn() }, scale: { set: vi.fn() }, width: 300, height: 600, destroy: vi.fn(), expression: fixture.expression, motion: fixture.motion,
    internalModel: { coreModel: core, physics, on, off: vi.fn(), motionManager: { stopAllMotions: vi.fn(), expressionManager }, renderer: { _clippingManager: manager,
      initialize: fixture.initialize.mockImplementation((_model, atlasCount) => { fixture.atlases = atlasCount; }), setClippingMaskBufferSize: fixture.maskSize } } };
  const renderer = new Live2DRenderer(document.createElement('div'), { cubismLoader: async () => undefined });
  await renderer.load('local.model3.json');
  return { renderer, core, expressionManager, pose, physics, evaluate, beforeModelUpdate: on.mock.calls[0]![1] as () => void };
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
  const { renderer, expressionManager } = await renderRig(49);
  const previous = {};
  expressionManager.currentExpression = previous;
  expressionManager.reserveExpressionIndex = 7;
  renderer.applyNativeAnimation(null); renderer.applyNativeAnimation(null);
  expect(fixture.expression).not.toHaveBeenCalled(); expect(fixture.neutralExpression).toHaveBeenCalledOnce();
  expect(expressionManager.currentExpression).toBe(expressionManager.defaultExpression);
  expect(expressionManager.reserveExpressionIndex).toBe(-1);
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

it('feeds live inputs to physics and applies secondary motion over the solved pose, respecting native ownership', async () => {
  const { renderer, physics, evaluate, beforeModelUpdate, pose } = await renderRig(12);
  renderer.setParameters({ ParamAngleX: 15 });
  renderer.setSecondaryOffsets({ FrontHairX1: .125 });
  physics.evaluate(); beforeModelUpdate();
  expect(pose).toEqual({ ParamAngleX: 15, FrontHairX1: .625 });
  renderer.applyNativeAnimation({ token: 1, expression: null, motion: null, suppressParamIds: ['ParamAngleX', 'FrontHairX1'] });
  pose.ParamAngleX = 6;
  physics.evaluate(); beforeModelUpdate();
  expect(pose).toEqual({ ParamAngleX: 0, FrontHairX1: .2 });
  renderer.destroy();
  expect(physics.evaluate).toBe(evaluate);
});

it('avoids synchronous framebuffer reads on the dedicated canvas and keeps the SDK path for render textures', () => {
  const framebuffer = {}, gl = { FRAMEBUFFER_BINDING: 36006, getParameter: vi.fn((_parameter: number) => framebuffer) };
  const saveProfile = vi.fn(), restoreProfile = vi.fn();
  const cubism = { saveProfile, restoreProfile };
  const renderTexture = { current: null as object | null };
  const draw = vi.fn((context: typeof gl) => {
    cubism.saveProfile();
    const bound = context.getParameter(context.FRAMEBUFFER_BINDING);
    cubism.restoreProfile();
    return bound;
  });
  const model = { draw, renderer: cubism };
  optimizeCubismScreenDraw(model as never, { gl, renderTexture } as never);
  for (let frame = 0; frame < 100; frame++) model.draw(gl);
  expect(gl.getParameter).not.toHaveBeenCalled();
  expect(saveProfile).not.toHaveBeenCalled();
  expect(restoreProfile).not.toHaveBeenCalled();
  expect(draw.mock.results.every(result => result.value === null)).toBe(true);
  renderTexture.current = {};
  model.draw(gl);
  expect(gl.getParameter).toHaveBeenCalledOnce();
  expect(saveProfile).toHaveBeenCalledOnce();
  expect(restoreProfile).toHaveBeenCalledOnce();
  expect(draw.mock.results.at(-1)?.value).toBe(framebuffer);
});

it('uses one bounded ticker, protects physical DPI and restores detail after sustained recovery', async () => {
  vi.stubGlobal('devicePixelRatio', 1.5);
  const { renderer } = await renderRig(12);
  const app = Reflect.get(renderer, 'app') as {
    ticker: { elapsedMS: number; maxFPS: number; add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
    renderer: { resolution: number };
  };
  const host = Reflect.get(renderer, 'container') as HTMLElement;
  Object.defineProperties(host, { clientWidth: { value: 470 }, clientHeight: { value: 610 } });
  renderer.syncViewport(2);
  const update = vi.fn();
  const remove = renderer.onFrame(update);
  const tick = app.ticker.add.mock.calls[0]![0] as () => void;
  expect(app.ticker.maxFPS).toBe(0);
  expect(app.ticker.add).toHaveBeenCalledExactlyOnceWith(tick, undefined, 25);
  for (let frame = 0; frame < 130; frame++) tick();
  expect(app.renderer.resolution).toBe(2);
  app.ticker.elapsedMS = 1200; tick();
  expect(app.renderer.resolution).toBe(2);
  app.ticker.elapsedMS = 48;
  for (let frame = 0; frame < 24; frame++) tick();
  expect(app.renderer.resolution).toBe(1.6);
  for (let frame = 0; frame < 150; frame++) tick();
  expect(app.renderer.resolution).toBe(1.5);
  expect(update).toHaveBeenLastCalledWith(48);
  app.ticker.elapsedMS = 500; tick();
  app.ticker.elapsedMS = 16;
  for (let frame = 0; frame < 150; frame++) tick();
  expect(app.renderer.resolution).toBe(1.5);
  for (let frame = 0; frame < 140; frame++) tick();
  expect(app.renderer.resolution).toBe(1.9);
  for (let frame = 0; frame < 260; frame++) tick();
  expect(app.renderer.resolution).toBe(2);
  app.ticker.elapsedMS = 48;
  for (let frame = 0; frame < 45; frame++) tick();
  expect(app.renderer.resolution).toBe(1.5);
  vi.stubGlobal('devicePixelRatio', 1.75);
  renderer.syncViewport(2);
  expect(app.renderer.resolution).toBe(2);
  remove();
  expect(app.ticker.remove).toHaveBeenCalledExactlyOnceWith(tick);
  renderer.destroy();
});

it.each([60, 90, 120, 144, 165, 240])('paces at 60 fps on a %i Hz display without catch-up frames', async refresh => {
  const { renderer } = await renderRig(12);
  const ticker = Reflect.get(renderer, 'app').ticker as { update: ReturnType<typeof vi.fn> };
  let pending: FrameRequestCallback | undefined;
  const schedule = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { pending = callback; return 1; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { pending = undefined; });
  try {
    const detach = renderer.onFrame(() => undefined);
    for (let frame = 0; frame < refresh * 3; frame++) pending?.(frame * 1000 / refresh);
    expect(ticker.update).toHaveBeenCalledTimes(180);
    pending?.(6000); expect(ticker.update).toHaveBeenCalledTimes(181);
    detach(); expect(pending).toBeUndefined();
  } finally { renderer.destroy(); schedule.mockRestore(); cancel.mockRestore(); }
});
