import type { Plugin } from 'vite';

/**
 * Forge 7's preload template still supplies Rollup's inlineDynamicImports.
 * Its defaults are merged after this config is loaded, so migrate the final
 * config in Vite's config hook rather than overriding it with undefined (which
 * mergeConfig ignores). Both options mean the same single-file preload bundle.
 */
export function forgePreloadCodeSplitting(): Plugin {
  return {
    name: 'worldlinebox:forge-preload-code-splitting',
    enforce: 'post',
    config(config) {
      for (const options of [config.build?.rollupOptions, config.build?.rolldownOptions]) {
        const outputs = options?.output;
        for (const output of Array.isArray(outputs) ? outputs : outputs ? [outputs] : []) {
          delete output.inlineDynamicImports;
          output.codeSplitting = false;
        }
      }
    },
  };
}
