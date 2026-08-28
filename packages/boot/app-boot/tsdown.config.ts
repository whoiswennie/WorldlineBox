import { defineConfig } from 'tsdown'

/**
 * Embed Include while keeping Loader external so the built include tree and
 * app host bind to one Loader peer.
 */
export default defineConfig(
  ['index', 'invariant', 'profile'].map(entry => ({
    entry: [`lib/types/${entry}.js`],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
    deps: {
      alwaysBundle: ['@deepseek-ai/cordis-plugin-include'],
    },
  })),
)
