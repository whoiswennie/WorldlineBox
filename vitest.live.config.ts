import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    target: 'es2023',
    tsconfigRaw: { compilerOptions: { target: 'ES2023' } },
  },
  test: {
    include: ['apps/cli/tests/**/*.live.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
  },
})
