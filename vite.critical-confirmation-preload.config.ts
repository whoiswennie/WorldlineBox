import { defineConfig } from 'vite';
import { forgePreloadCodeSplitting } from './scripts/vite-forge-preload';

export default defineConfig({
  plugins: [forgePreloadCodeSplitting()],
  build: {
    lib: {
      entry: 'src/preload/critical-confirmation.ts',
      formats: ['cjs'],
      fileName: () => 'critical-confirmation.js',
    },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
