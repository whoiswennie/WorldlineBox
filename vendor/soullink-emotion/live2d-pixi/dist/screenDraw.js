/** Pixi resets its state around the single model on our dedicated canvas.
 * Cubism knows the framebuffer is the screen, so its mask passes can restore
 * it without synchronizing with the GPU. Render textures use the SDK's path.
 */
export function optimizeCubismScreenDraw(model, renderer) {
    const draw = model.draw, cubism = model.renderer;
    const saveProfile = cubism?.saveProfile, restoreProfile = cubism?.restoreProfile;
    const gl = renderer?.gl;
    if (!draw || !cubism || !saveProfile || !restoreProfile || !gl || !renderer.renderTexture)
        return;
    const readParameter = (parameter) => parameter === gl.FRAMEBUFFER_BINDING ? null : gl.getParameter(parameter);
    const boundMethods = new Map();
    const screenContext = new Proxy(gl, {
        get(target, property) {
            if (property === "getParameter")
                return readParameter;
            if (boundMethods.has(property))
                return boundMethods.get(property);
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function")
                return value;
            const method = value.bind(target);
            boundMethods.set(property, method);
            return method;
        }
    });
    const skipProfile = () => undefined;
    model.draw = function (context) {
        if (context !== gl || renderer.renderTexture.current !== null) {
            draw.call(this, context);
            return;
        }
        cubism.saveProfile = cubism.restoreProfile = skipProfile;
        try {
            draw.call(this, screenContext);
        }
        finally {
            cubism.saveProfile = saveProfile;
            cubism.restoreProfile = restoreProfile;
        }
    };
}
