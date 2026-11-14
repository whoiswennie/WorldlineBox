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
    private minimumResolution;
    private fullBody;
    private figureBounds?;
    private beforeModelUpdate;
    private resizeObserver;
    constructor(container: HTMLElement, deps?: Live2DRendererDeps);
    private displayResolution;
    /** Resample after a monitor DPI change or a move into another window. */
    syncViewport(minimumResolution?: number): void;
    load(modelUrl: string, options?: {
        automaticIdle?: boolean;
        animations?: {
            Expressions: object[];
            Motions: object;
        };
    }): Promise<Record<string, Live2DMotionParameterInfo>>;
    setParameters(params: Live2DParamState): void;
    /** Last pose used to update model geometry, including native motion and physics. */
    getParameters(): Live2DParamState;
    get suppressedParameterIds(): ReadonlySet<string>;
    prepareNativeAnimations(expressions: readonly string[], motions: ReadonlyArray<{
        group: string;
        index: number;
    }>): Promise<void>;
    clearNativeAnimation(): void;
    stopNativeMotion(): void;
    /** Motion values are saved by Cubism between frames, even after its queue stops. */
    restoreMotionParameters(ids: readonly string[]): void;
    private resetNativeExpression;
    applyNativeAnimation(directive: NativeAnimationDirective | null): void;
    setViewScale(scale: number): void;
    /** WorldlineBox integration: reset means neutral, never a random expression. */
    resetPose(): void;
    setViewOffset(offset: {
        x: number;
        y: number;
    }): void;
    setFullBody(enabled: boolean): void;
    /** Figure bounds in CSS pixels, excluding the model's transparent canvas margins. */
    getFigureBounds(): {
        x: number;
        y: number;
        width: number;
        height: number;
    } | undefined;
    destroy(): void;
    private applyExpression;
    private applyMotion;
    private removeModel;
    private disableInternalEyeBlink;
    private fitModel;
    private measureFigure;
    private applyParametersNow;
}
