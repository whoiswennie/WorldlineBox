import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  esbuild: {
    target: 'es2023',
    jsx: 'automatic',
    tsconfigRaw: { compilerOptions: { target: 'ES2023' } },
  },
  test: {
    include: ['packages/**/*.client.spec.{ts,tsx}'],
    setupFiles: ['./vitest.client.setup.ts'],
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
