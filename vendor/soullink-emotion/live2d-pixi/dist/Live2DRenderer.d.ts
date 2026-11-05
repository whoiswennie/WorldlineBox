import type { NativeAnimationDirective } from "@soullink-emotion/engine";
import type { Live2DMotionParameterInfo, Live2DParamState, Live2DRendererDeps } from "./types";
/**
 * Renders a Live2D Cubism 4 model into a host element using PIXI v7 and
 * `pixi-live2d-display`. The Cubism Core runtime is supplied by the integrator
 * through `deps.cubismLoader`, keeping this package free of any bundler-specific
 * asset import.
 */
export declare class Live2DRenderer {
    private app;
    private container;
    private deps;
    private model;
    private latestParams;
    private renderedParams;
    private lastNativeAnimToken;
    private suppressedParamIds;
    private viewScale;
    private viewOffset;
    private beforeModelUpdate;
    private resizeObserver;
    constructor(container: HTMLElement, deps?: Live2DRendererDeps);
    load(modelUrl: string): Promise<Record<string, Live2DMotionParameterInfo>>;
    setParameters(params: Live2DParamState): void;
    /** Last pose used to update model geometry, including native motion and physics. */
    getParameters(): Live2DParamState;
    get suppressedParameterIds(): ReadonlySet<string>;
    applyNativeAnimation(directive: NativeAnimationDirective | null): void;
    setViewScale(scale: number): void;
    /** WorldlineBox integration: reset means neutral, never a random expression. */
    resetPose(): void;
    setViewOffset(offset: {
        x: number;
        y: number;
    }): void;
    destroy(): void;
    private applyExpression;
    private applyMotion;
    private removeModel;
    private disableInternalEyeBlink;
    private fitModel;
    private applyParametersNow;
}
