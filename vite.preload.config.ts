import { defineConfig } from 'vite';
import { forgePreloadCodeSplitting } from './scripts/vite-forge-preload';

export default defineConfig({
  plugins: [forgePreloadCodeSplitting()],
  build: {
    lib: {
      entry: 'src/preload/index.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
