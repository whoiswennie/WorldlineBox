import type { Renderer } from "pixi.js";
interface CubismScreenDrawable {
    draw?: (gl: WebGLRenderingContext) => void;
    renderer?: {
        saveProfile?: () => void;
        restoreProfile?: () => void;
    };
}
/** Pixi resets its state around the single model on our dedicated canvas.
 * Cubism knows the framebuffer is the screen, so its mask passes can restore
 * it without synchronizing with the GPU. Render textures use the SDK's path.
 */
export declare function optimizeCubismScreenDraw(model: CubismScreenDrawable, renderer: Renderer): void;
export {};
