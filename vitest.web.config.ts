import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  // Web E2E fixtures boot the real Host composition and therefore import
  // workspace packages directly. Resolve those imports through the same
  // source aliases as the runtime and client Vitest lanes instead of relying
  // on whichever packages happen to be linked under apps/web/node_modules.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  esbuild: {
    target: 'es2023',
    tsconfigRaw: { compilerOptions: { target: 'ES2023' } },
  },
  test: {
    include: ['apps/web/tests/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each file can own a Host process and Chromium instance. Bounding the
    // file pool prevents Windows from exhausting VirtualAlloc before those
    // fixtures reach their teardown paths.
    maxWorkers: 4,
    sequence: { concurrent: false },
  },
})
