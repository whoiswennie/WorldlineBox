import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/index.ts',
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: ['better-sqlite3', 'koffi', 'libarchive-wasm', '7zip-bin', 'sharp', 'node-edge-tts', 'node-edge-tts/dist/drm', 'ws', 'ssh2'],
    },
  },
});
