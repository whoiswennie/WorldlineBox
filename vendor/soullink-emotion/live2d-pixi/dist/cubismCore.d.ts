import type { CubismCoreLoader } from "./types";
/**
 * Builds a {@link CubismCoreLoader} that injects the Live2D Cubism Core runtime
 * via a `<script>` tag pointing at `coreUrl`. The loader resolves once
 * `window.Live2DCubismCore` is present, and the underlying script is injected
 * at most once regardless of how many times the loader is invoked.
 *
 * The URL is supplied by the integrator (e.g. resolved through a bundler asset
 * import) so this package carries no bundler-specific import of the core asset.
 */
export declare function createScriptTagCubismLoader(coreUrl: string): CubismCoreLoader;
