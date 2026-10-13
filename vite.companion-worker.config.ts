import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'src/companions/worker.ts', formats: ['cjs'], fileName: () => 'companion_worker.js' },
    rollupOptions: { external: ['better-sqlite3'] },
  },
});
