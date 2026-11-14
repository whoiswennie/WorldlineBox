import * as PIXI from "pixi.js";
import type { NativeAnimationDirective } from "@soullink-emotion/engine";
import type { Live2DModelInstance } from "./live2dModel";
import { buildMotionParameters, loadCDIParameterMeta, readCurrentParameters } from "./motionParameters";
import type { Live2DMotionParameterInfo, Live2DParamState, Live2DRendererDeps } from "./types";

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
  private renderedParams: Live2DParamState = {};
  private lastNativeAnimToken = -1;
  private suppressedParamIds: Set<string> = new Set();
  private viewScale = 1;
  private viewOffset = { x: 0, y: 0 };
  private minimumResolution = 1;
  private fullBody = false;
  private figureBounds?: PIXI.Rectangle;
  private beforeModelUpdate = () => {
    this.applyParametersNow();
    // Cubism restores saved values after updating geometry, so capture here.
    this.renderedParams = readCurrentParameters(this.model?.internalModel?.coreModel);
  };
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, deps: Live2DRendererDeps = {}) {
    this.container = container;
    this.deps = deps;
    window.PIXI = PIXI;

    this.app = new PIXI.Application({
      autoDensity: true,
      resolution: this.displayResolution(),
      antialias: true,
      backgroundAlpha: 0
    });

    container.appendChild(this.app.view as HTMLCanvasElement);
    this.resizeObserver = new ResizeObserver(() => this.syncViewport());
    this.resizeObserver.observe(container);
    this.syncViewport();
  }

  private displayResolution(): number {
    return Math.min(3, Math.max(this.minimumResolution, this.container.ownerDocument.defaultView?.devicePixelRatio || 1));
  }

  /** Resample after a monitor DPI change or a move into another window. */
  syncViewport(minimumResolution = this.minimumResolution): void {
    this.minimumResolution = minimumResolution;
    const { clientWidth: width, clientHeight: height } = this.container;
    const resolution = this.displayResolution(), renderer = this.app.renderer;
    if (!width || !height || renderer.resolution === resolution && this.app.screen.width === width && this.app.screen.height === height) return;
    renderer.resolution = resolution;
    renderer.resize(width, height);
    this.fitModel();
  }

  async load(modelUrl: string, options?: { automaticIdle?: boolean; animations?: { Expressions: object[]; Motions: object } }): Promise<Record<string, Live2DMotionParameterInfo>> {
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
    this.disableInternalEyeBlink();
    this.model.internalModel?.on?.("beforeModelUpdate", this.beforeModelUpdate);
    this.model.anchor?.set(0.5, 0.52);
    this.figureBounds = this.measureFigure();
    this.app.stage.addChild(this.model);
    this.fitModel();
    return buildMotionParameters(this.model, cdiMeta);
  }

  setParameters(params: Live2DParamState) {
    this.latestParams = params;
  }

  /** Last pose used to update model geometry, including native motion and physics. */
  getParameters(): Live2DParamState {
    return { ...this.renderedParams };
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
    core?.saveParameters?.(); this.latestParams = {}; this.suppressedParamIds.clear(); this.lastNativeAnimToken = -1;
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

    this.model.internalModel?.off?.("beforeModelUpdate", this.beforeModelUpdate);
    this.app.stage.removeChild(this.model);
    this.model.destroy({
      children: true,
      texture: true,
      baseTexture: true
    });
    this.model = null;
    this.renderedParams = {};
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
    if (this.fullBody) {
      const bounds = this.figureBounds ?? new PIXI.Rectangle(0, 0, originalWidth, originalHeight);
      const scale = Math.max(0, Math.min((width - 12) / bounds.width, (height - 12) / bounds.height)) * this.viewScale;
      this.model.scale.set(scale);
      this.model.x = width / 2 - (bounds.x + bounds.width / 2 - this.model.pivot.x) * scale + this.viewOffset.x;
      this.model.y = height - 6 - (bounds.bottom - this.model.pivot.y) * scale + this.viewOffset.y;
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
    if (!coreModel?.setParameterValueById) return;

    for (const [id, value] of Object.entries(this.latestParams)) {
      if (this.suppressedParamIds.has(id)) continue;

      if (coreModel.getParameterIndex && coreModel.getParameterIndex(id) < 0) {
        this.deps.onMissingParameter?.(id);
        continue;
      }
      coreModel.setParameterValueById(id, value, 1);
    }
  }
}

function priorityFor(priority: NonNullable<NativeAnimationDirective["motion"]>["priority"]): number {
  // pixi-live2d-display declares MotionPriority as NONE=0, IDLE=1, NORMAL=2, FORCE=3.
  if (priority === "idle") return 1;
  if (priority === "force") return 3;
  return 2;
}
