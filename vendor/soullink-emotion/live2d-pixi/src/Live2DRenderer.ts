import * as PIXI from "pixi.js";
import type { NativeAnimationDirective } from "@soullink-emotion/engine";
import type { Live2DModelInstance } from "./live2dModel";
import { buildMotionParameters, loadCDIParameterMeta, readCurrentParameters } from "./motionParameters";
import { optimizeCubismScreenDraw } from "./screenDraw";
import type { Live2DMotionParameterInfo, Live2DParamState, Live2DRendererDeps } from "./types";

const frameInterval = 1000 / 60;

/**
 * Renders a Live2D Cubism 4 model into a host element using PIXI v7 and
 * `pixi-live2d-display`. The Cubism Core runtime is supplied by the integrator
 * through `deps.cubismLoader`, keeping this package free of any bundler-specific
 * asset import.
 */
export class Live2DRenderer {
  private app: PIXI.Application;
  private container: HTMLElement;
  private deps: Live2DRendererDeps;
  private model: Live2DModelInstance | null = null;
  private latestParams: Live2DParamState = {};
  private secondaryOffsets: Live2DParamState = {};
  private restorePhysics?: () => void;
  private renderedParams: Live2DParamState = {};
  private renderedValues?: Float32Array;
  private lastNativeAnimToken = -1;
  private suppressedParamIds: Set<string> = new Set();
  private viewScale = 1;
  private viewOffset = { x: 0, y: 0 };
  private minimumResolution = 1;
  private deviceResolution: number;
  private resolution: number;
  private pacedTime = 0;
  private pacedFrames = 0;
  private slowFrames = 0;
  private stableTime = 0;
  private frameWindow?: Window;
  private frameHandle = 0;
  private frameCallback?: (elapsedMs: number) => void;
  private fullBody = false;
  private automaticFraming = false;
  private figureBounds?: PIXI.Rectangle;
  private beforeModelUpdate = () => {
    this.applyParametersNow();
    this.applySecondaryOffsets();
    // Cubism restores saved values after updating geometry, so capture here.
    const core = this.model?.internalModel?.coreModel;
    const values = core?._model?.parameters?.values;
    if (!values) {
      this.renderedParams = readCurrentParameters(core);
      return;
    }
    this.renderedValues ??= new Float32Array(values.length);
    this.renderedValues.set(values);
  };
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, deps: Live2DRendererDeps = {}) {
    this.container = container;
    this.deps = deps;
    this.deviceResolution = this.readDeviceResolution();
    this.resolution = this.preferredResolution;
    window.PIXI = PIXI;

    this.app = new PIXI.Application({
      autoStart: false,
      autoDensity: true,
      resolution: this.resolution,
      // Art edges already come from alpha-filtered textures. For this canvas,
      // multisampling adds a second screen-sized workload to every frame.
      antialias: false,
      backgroundAlpha: 0
    });

    container.appendChild(this.app.view as HTMLCanvasElement);
    this.resizeObserver = new ResizeObserver(() => this.syncViewport());
    this.resizeObserver.observe(container);
    this.syncViewport();
  }

  private readDeviceResolution(): number {
    return Math.min(3, this.container.ownerDocument.defaultView?.devicePixelRatio || 1);
  }

  private get preferredResolution(): number {
    return Math.min(3, Math.max(this.minimumResolution, this.deviceResolution));
  }

  private get resolutionFloor(): number {
    // Drop supersampling first on the pet. Below its physical DPI, the
    // compositor enlarges the canvas and softens details in the artwork.
    return this.minimumResolution > 1 ? Math.max(1, this.deviceResolution) : Math.max(.8, this.preferredResolution * .5);
  }

  /** Resample after a monitor DPI change or a move into another window. */
  syncViewport(minimumResolution = this.minimumResolution): void {
    const deviceResolution = this.readDeviceResolution();
    if (this.minimumResolution !== minimumResolution || this.deviceResolution !== deviceResolution) {
      this.minimumResolution = minimumResolution;
      this.deviceResolution = deviceResolution;
      this.resolution = this.preferredResolution;
      this.pacedTime = this.pacedFrames = this.slowFrames = this.stableTime = 0;
    }
    const { clientWidth: width, clientHeight: height } = this.container;
    const resolution = this.resolution, renderer = this.app.renderer;
    const resized = this.app.screen.width !== width || this.app.screen.height !== height;
    if (!width || !height || renderer.resolution === resolution && !resized) return;
    renderer.resolution = resolution;
    renderer.resize(width, height);
    if (resized) this.fitModel();
  }

  async load(modelUrl: string, options?: { automaticIdle?: boolean; automaticFraming?: boolean; animations?: { Expressions: object[]; Motions: object } }): Promise<Record<string, Live2DMotionParameterInfo>> {
    if (!this.deps.cubismLoader) {
      throw new Error(
        "[Live2DRenderer] No cubismLoader provided. Pass a CubismCoreLoader via the constructor deps " +
          "(e.g. createScriptTagCubismLoader(coreUrl)) so the Cubism Core runtime can be loaded."
      );
    }

    await this.deps.cubismLoader();
    const { Live2DModel } = await import("pixi-live2d-display/cubism4");

    this.removeModel();
    const cdiMeta = await loadCDIParameterMeta(modelUrl);
    let source: string | object = modelUrl;
    if (options?.animations) {
      const response = await fetch(modelUrl);
      if (!response.ok) throw Error('Could not load the Live2D manifest.');
      const manifest = await response.json();
      source = { ...manifest, url: modelUrl, FileReferences: { ...manifest.FileReferences, ...options.animations } };
    }
    const model = await Live2DModel.from(source, {
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: true,
      ticker: this.app.ticker,
    });

    this.model = model as Live2DModelInstance;
    const motionGroups = (this.model as any).internalModel?.motionManager?.groups;
    if (options?.automaticIdle === false && motionGroups) motionGroups.idle = '';
    // Complex rigs can exceed Cubism's 36-mask single-atlas limit. Packing
    // them into one atlas makes unrelated face layers share the same mask.
    const cubism = (this.model as any).internalModel?.renderer;
    const masks = cubism?._clippingManager?._clippingContextListForMask?.length ?? 0;
    if (masks > 36) {
      cubism._clippingManager.release();
      cubism.initialize((this.model as any).internalModel.coreModel, Math.ceil(masks / 32));
    }
    cubism?.setClippingMaskBufferSize?.(1024);
    const internal = this.model.internalModel;
    const pixiRenderer = this.app.renderer;
    if (internal && pixiRenderer && "gl" in pixiRenderer) optimizeCubismScreenDraw(internal, pixiRenderer as PIXI.Renderer);
    const core = internal?.coreModel, ids = core?._model?.parameters?.ids, indexOf = core?.getParameterIndex;
    if (ids && core && indexOf) {
      // Native curves and application inputs resolve the same IDs on every frame.
      const indexes = new Map(ids.map((id, index) => [id, index]));
      core.getParameterIndex = function (id) {
        const known = indexes.get(id);
        if (known !== undefined) return known;
        const index = indexOf.call(this, id);
        indexes.set(id, index);
        return index;
      };
    }
    this.disableInternalEyeBlink();
    const physics = this.model.internalModel?.physics;
    if (physics) {
      const evaluate = physics.evaluate;
      physics.evaluate = (model, deltaSeconds) => {
        // Cubism has already saved this frame's native motion baseline.
        // Give physics the live inputs before its springs are evaluated.
        this.applyParametersNow();
        evaluate.call(physics, model, deltaSeconds);
      };
      this.restorePhysics = () => { physics.evaluate = evaluate; };
    }
    this.model.internalModel?.on?.("beforeModelUpdate", this.beforeModelUpdate);
    this.model.anchor?.set(0.5, 0.52);
    this.automaticFraming = options?.automaticFraming === true;
    this.figureBounds = this.measureFigure();
    this.app.stage.addChild(this.model);
    this.fitModel();
    return buildMotionParameters(this.model, cdiMeta);
  }

  setParameters(params: Live2DParamState) {
    this.latestParams = params;
  }

  /** Offsets applied to the rig's solved pose for this frame. */
  setSecondaryOffsets(offsets: Live2DParamState): void {
    this.secondaryOffsets = offsets;
  }

  /** Last pose used to update model geometry, including native motion and physics. */
  getParameters(): Live2DParamState {
    const ids = this.model?.internalModel?.coreModel?._model?.parameters?.ids, values = this.renderedValues;
    if (ids && values) {
      const result: Live2DParamState = {};
      for (let index = 0; index < ids.length; index++) {
        const value = values[index];
        if (value !== undefined && Number.isFinite(value)) result[ids[index]!] = value;
      }
      return result;
    }
    return { ...this.renderedParams };
  }

  /** Drive the avatar before Pixi advances its model and renders the frame. */
  onFrame(update: (elapsedMs: number) => void): () => void {
    const ticker = this.app.ticker;
    ticker.stop();
    ticker.maxFPS = 0;
    const tick = () => {
      this.adjustResolution(ticker.elapsedMS);
      update(ticker.elapsedMS);
    };
    ticker.add(tick, undefined, PIXI.UPDATE_PRIORITY.HIGH);
    this.frameCallback = update;
    this.syncFrameClock();
    return () => {
      ticker.remove(tick);
      if (this.frameCallback === update) { this.frameCallback = undefined; this.stopFrameClock(); }
    };
  }

  /** Follow the visible pet window rather than the parent window's compositor. */
  syncFrameClock(): void {
    const view = this.container.ownerDocument.defaultView;
    if (!this.frameCallback || view === this.frameWindow) return;
    this.stopFrameClock();
    if (!view || view.closed) return;
    this.frameWindow = view;
    const ticker = this.app.ticker;
    let nextAt: number | undefined;
    const tick = (now: number) => {
      if (!this.frameCallback || this.frameWindow !== view) return;
      this.frameHandle = view.requestAnimationFrame(tick);
      if (nextAt !== undefined && now + .65 < nextAt) return;
      if (nextAt === undefined || now - nextAt > 250) {
        ticker.lastTime = now - frameInterval;
        nextAt = now + frameInterval;
      } else {
        // Preserve phase across 90/144Hz displays and occasional late frames.
        // Dropping overdue frames avoids a burst of catch-up rendering.
        nextAt += frameInterval * (1 + Math.max(0, Math.floor((now + .65 - nextAt) / frameInterval)));
      }
      ticker.update(now);
    };
    this.frameHandle = view.requestAnimationFrame(tick);
  }

  private stopFrameClock(): void {
    if (this.frameWindow && !this.frameWindow.closed) this.frameWindow.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.frameWindow = undefined;
  }

  private adjustResolution(elapsed: number): void {
    // A suspended window or a single busy frame is not a GPU workload sample.
    if (elapsed <= 0) return;
    if (elapsed >= 250) {
      this.pacedTime = this.pacedFrames = this.slowFrames = this.stableTime = 0;
      return;
    }
    this.pacedTime += elapsed;
    this.pacedFrames++;
    if (elapsed > 27) this.slowFrames++;
    if (this.pacedTime < 1_000) return;
    const previous = this.resolution, preferred = this.preferredResolution, step = preferred * .2;
    if (this.slowFrames >= Math.max(3, this.pacedFrames * .10) || this.pacedTime / this.pacedFrames > 22) {
      this.resolution = Math.max(this.resolutionFloor, previous - step);
      this.stableTime = 0;
    } else if (previous < preferred && this.pacedTime / this.pacedFrames <= 20 && this.slowFrames <= this.pacedFrames * .1) {
      this.stableTime += this.pacedTime;
      if (this.stableTime >= 4_000) {
        this.resolution = Math.min(preferred, previous + step);
        this.stableTime = 0;
      }
    } else {
      this.stableTime = 0;
    }
    if (this.resolution !== previous) this.syncViewport();
    this.pacedTime = this.pacedFrames = this.slowFrames = 0;
  }

  get suppressedParameterIds(): ReadonlySet<string> {
    return this.suppressedParamIds;
  }

  async prepareNativeAnimations(expressions: readonly string[], motions: ReadonlyArray<{ group: string; index: number }>): Promise<void> {
    const manager = (this.model as any)?.internalModel?.motionManager;
    const expressionManager = manager?.expressionManager;
    await Promise.allSettled([
      ...motions.map(({ group, index }) => manager?.loadMotion?.(group, index)),
      ...expressions.map(name => {
        const index = expressionManager?.getExpressionIndex?.(name);
        return index >= 0 ? expressionManager.loadExpression?.(index) : undefined;
      }),
    ]);
  }

  clearNativeAnimation(): void {
    this.stopNativeMotion();
    this.applyNativeAnimation(null);
  }

  stopNativeMotion(): void {
    this.model?.internalModel?.motionManager?.stopAllMotions();
  }

  /** Motion values are saved by Cubism between frames, even after its queue stops. */
  restoreMotionParameters(ids: readonly string[]): void {
    const core = this.model?.internalModel?.coreModel;
    const count = core?.getParameterCount?.() ?? 0;
    for (const id of ids) {
      const index = core?.getParameterIndex?.(id) ?? -1;
      if (index < 0 || index >= count) continue;
      const value = core?.getParameterDefaultValue?.(index);
      if (value !== undefined) core?.setParameterValueByIndex?.(index, value, 1);
    }
    core?.saveParameters?.();
  }

  private resetNativeExpression(): void {
    const expressions = this.model?.internalModel?.motionManager?.expressionManager;
    if (!expressions) return;
    expressions.reserveExpressionIndex = -1;
    expressions.stopAllExpressions();
    // resetExpression only updates the queue, leaving Cubism's duplicate check
    // pointed at the old clip. Reset both so the same expression can play again.
    expressions.currentExpression = expressions.defaultExpression;
    expressions.resetExpression();
  }

  applyNativeAnimation(directive: NativeAnimationDirective | null): void {
    this.suppressedParamIds = new Set(directive?.suppressParamIds ?? []);

    if (directive === null) {
      if (this.lastNativeAnimToken !== 0) {
        // Ending a performance restores neutral; never select a random costume.
        this.resetNativeExpression();
        this.lastNativeAnimToken = 0;
      }
      return;
    }

    if (!this.model) return;
    if (directive.token === this.lastNativeAnimToken) return;

    if (directive.expression !== null) {
      this.applyExpression(directive.expression);
    }

    if (directive.motion !== null) {
      this.applyMotion(
        directive.motion.group,
        directive.motion.index ?? 0,
        priorityFor(directive.motion.priority ?? "normal")
      );
    }

    this.lastNativeAnimToken = directive.token;
  }

  setViewScale(scale: number) {
    this.viewScale = Math.min(3, Math.max(0.4, scale));
    this.fitModel();
  }

  /** WorldlineBox integration: reset means neutral, never a random expression. */
  resetPose(): void {
    this.stopNativeMotion();
    this.resetNativeExpression();
    const core = this.model?.internalModel?.coreModel;
    if (core?.getParameterCount && core.setParameterValueByIndex && core.getParameterDefaultValue) for (let index = 0; index < core.getParameterCount(); index++) {
      core.setParameterValueByIndex(index, core.getParameterDefaultValue(index), 1);
    }
    core?.saveParameters?.(); this.latestParams = {}; this.secondaryOffsets = {}; this.suppressedParamIds.clear(); this.lastNativeAnimToken = -1;
  }

  setViewOffset(offset: { x: number; y: number }) {
    this.viewOffset = { ...offset };
    this.fitModel();
  }

  setFullBody(enabled: boolean): void {
    if (this.fullBody === enabled) return;
    this.fullBody = enabled;
    this.fitModel();
  }

  /** Figure bounds in CSS pixels, excluding the model's transparent canvas margins. */
  getFigureBounds(): { x: number; y: number; width: number; height: number } | undefined {
    const model = this.model, bounds = this.figureBounds;
    if (!model || !bounds) return;
    return {
      x: model.x + (bounds.x - model.pivot.x) * model.scale.x,
      y: model.y + (bounds.y - model.pivot.y) * model.scale.y,
      width: bounds.width * model.scale.x,
      height: bounds.height * model.scale.y,
    };
  }

  destroy() {
    this.stopFrameClock();
    this.resizeObserver.disconnect();
    this.removeModel();
    this.app.destroy(true, {
      children: true,
      texture: true,
      baseTexture: true
    });
  }

  private applyExpression(name?: string): void {
    const expression = (this.model as any)?.expression;
    if (typeof expression !== "function") return;

    try {
      const result = name === undefined
        ? expression.call(this.model)
        : expression.call(this.model, name);
      void Promise.resolve(result).catch((cause) => {
        console.warn("[Live2DRenderer] Failed to apply native expression", cause);
      });
    } catch (cause) {
      console.warn("[Live2DRenderer] Failed to apply native expression", cause);
    }
  }

  private applyMotion(group: string, index: number, priority: number): void {
    const motion = (this.model as any)?.motion;
    if (typeof motion !== "function") return;

    try {
      void Promise.resolve(motion.call(this.model, group, index, priority)).catch((cause) => {
        console.warn("[Live2DRenderer] Failed to apply native motion", cause);
      });
    } catch (cause) {
      console.warn("[Live2DRenderer] Failed to apply native motion", cause);
    }
  }

  private removeModel() {
    if (!this.model) return;

    this.restorePhysics?.();
    this.restorePhysics = undefined;
    this.model.internalModel?.off?.("beforeModelUpdate", this.beforeModelUpdate);
    this.app.stage.removeChild(this.model);
    this.model.destroy({
      children: true,
      texture: true,
      baseTexture: true
    });
    this.model = null;
    this.renderedParams = {};
    this.renderedValues = undefined;
    this.secondaryOffsets = {};
    // Reset native animation state so a fresh load re-applies the current directive.
    this.lastNativeAnimToken = -1;
    this.suppressedParamIds = new Set();
  }

  private disableInternalEyeBlink() {
    if (!this.model?.internalModel) return;
    this.model.internalModel.eyeBlink = undefined;
  }

  private fitModel() {
    if (!this.model) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const originalWidth = (this.model.internalModel?.originalWidth ?? this.model.width) || 1;
    const originalHeight = (this.model.internalModel?.originalHeight ?? this.model.height) || 1;
    if (this.automaticFraming || this.fullBody) {
      const bounds = this.figureBounds ?? { x: 0, y: 0, width: originalWidth, height: originalHeight };
      if (this.automaticFraming) {
        // Frame the upper portion for a video portrait. The full frame uses
        // the entire neutral figure. Both leave room around the measured art.
        const framedHeight = bounds.height * (this.fullBody ? 1 : .62);
        const scale = Math.min(width * .9 / bounds.width, height * .88 / framedHeight) * this.viewScale;
        this.model.scale.set(scale);
        this.model.x = width / 2 - (bounds.x + bounds.width / 2 - this.model.pivot.x) * scale + this.viewOffset.x;
        this.model.y = height / 2 - (bounds.y + framedHeight / 2 - this.model.pivot.y) * scale + this.viewOffset.y;
        return;
      }
      const scale = Math.max(0, Math.min((width - 12) / bounds.width, (height - 12) / bounds.height)) * this.viewScale;
      this.model.scale.set(scale);
      this.model.x = width / 2 - (bounds.x + bounds.width / 2 - this.model.pivot.x) * scale + this.viewOffset.x;
      this.model.y = height - 6 - (bounds.y + bounds.height - this.model.pivot.y) * scale + this.viewOffset.y;
      return;
    }
    const scale = Math.min(width / originalWidth, height / originalHeight) * 1.02 * this.viewScale;

    this.model.scale.set(scale);
    this.model.x = width * 0.5 + this.viewOffset.x;
    this.model.y = height * 0.56 + this.viewOffset.y;
  }

  private measureFigure(): PIXI.Rectangle | undefined {
    const internal = this.model?.internalModel, core = internal?.coreModel;
    if (!internal?.getDrawableVertices || !core?.getDrawableCount) return;
    const transform = internal.localTransform;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let index = 0; index < core.getDrawableCount(); index++) {
      if ((core.getDrawableOpacity?.(index) ?? 1) <= .01) continue;
      const vertices = internal.getDrawableVertices(index);
      for (let i = 0; i + 1 < vertices.length; i += 2) {
        const vx = vertices[i]!, vy = vertices[i + 1]!;
        const x = transform ? transform.a * vx + transform.c * vy + transform.tx : vx;
        const y = transform ? transform.b * vx + transform.d * vy + transform.ty : vy;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    if (Number.isFinite(left + top + right + bottom) && right > left && bottom > top) return new PIXI.Rectangle(left, top, right - left, bottom - top);
  }

  private applyParametersNow() {
    const coreModel = this.model?.internalModel?.coreModel;
    if (!coreModel) return;

    const count = coreModel.getParameterCount?.();
    for (const [id, value] of Object.entries(this.latestParams)) {
      if (this.suppressedParamIds.has(id)) continue;

      const index = coreModel.getParameterIndex?.(id);
      if (index !== undefined && (index < 0 || (count !== undefined && index >= count))) {
        this.deps.onMissingParameter?.(id);
        continue;
      }
      if (index !== undefined && coreModel.setParameterValueByIndex) coreModel.setParameterValueByIndex(index, value, 1);
      else coreModel.setParameterValueById?.(id, value, 1);
    }
  }

  private applySecondaryOffsets(): void {
    const core = this.model?.internalModel?.coreModel;
    if (!core?.getParameterIndex || !core.getParameterValueByIndex || !core.setParameterValueByIndex) return;
    const count = core.getParameterCount?.() ?? 0;
    for (const [id, offset] of Object.entries(this.secondaryOffsets)) {
      if (!offset || this.suppressedParamIds.has(id)) continue;
      const index = core.getParameterIndex(id);
      if (index < 0 || index >= count) continue;
      // Cubism clamps the value to the parameter's own range.
      core.setParameterValueByIndex(index, core.getParameterValueByIndex(index) + offset);
    }
  }
}

function priorityFor(priority: NonNullable<NativeAnimationDirective["motion"]>["priority"]): number {
  // pixi-live2d-display declares MotionPriority as NONE=0, IDLE=1, NORMAL=2, FORCE=3.
  if (priority === "idle") return 1;
  if (priority === "force") return 3;
  return 2;
}
