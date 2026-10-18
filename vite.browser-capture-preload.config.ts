import { defineConfig } from 'vite';
import { forgePreloadCodeSplitting } from './scripts/vite-forge-preload';

export default defineConfig({
  plugins: [forgePreloadCodeSplitting()],
  build: {
    lib: {
      entry: 'src/preload/browser-capture.ts',
      formats: ['cjs'],
      fileName: () => 'browser-capture.js',
    },
    // Sandboxed preloads cannot load additional local CommonJS chunks.
    rolldownOptions: { external: ['electron'], output: { codeSplitting: false } },
  },
});
