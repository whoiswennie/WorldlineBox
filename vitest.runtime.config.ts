import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

const windowsUnsupportedTests = process.platform === 'win32'
  ? [
      // These suites execute a real POSIX shell or Unix confinement backend.
      'packages/shell/bash-local/tests/**/*.spec.ts',
      'packages/shell/bash-sandbox/tests/**/*.spec.ts',
      'packages/shell/tool-bash/tests/**/*.spec.ts',
      'packages/hooks/*/tests/**/*.spec.ts',
      'packages/terminal/terminal-bash/tests/**/*.spec.ts',
      'packages/sandbox/sandbox-local/tests/**/*.spec.ts',
      'packages/subprocess/subprocess/tests/**/*.spec.ts',
      'packages/subprocess/subprocess-local/tests/local.spec.ts',
      'packages/subprocess/subprocess-local/tests/spawn.spec.ts',
    ]
  : []

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  esbuild: {
    target: 'es2023',
    tsconfigRaw: {
      compilerOptions: {
        target: 'ES2023',
      },
    },
  },
  test: {
    include: ['packages/**/tests/**/*.spec.ts', 'packages/**/tests/**/*.spec.tsx', 'apps/**/tests/**/*.spec.ts'],
    exclude: [
      '**/node_modules/**',
      '**/lib/**',
      '**/*.live.spec.ts',
      // Browser component contracts run in their own package-focused lane;
      // this gate is the Host/Agent/CLI runtime boundary.
      '**/*.client.spec.ts',
      '**/*.client.spec.tsx',
      ...windowsUnsupportedTests,
      // These two contracts are enabled with the JSONL persistence plugin.
      'packages/core/agent-loop/tests/config-session-id.spec.ts',
      'packages/core/agent-loop/tests/resume.spec.ts',
      // Repository documentation generators are outside the runtime boundary.
      'packages/core/session/tests/gen-persistence-catalog.spec.ts',
      'packages/core/tools/tests/gen-tool-catalog.spec.ts',
      'packages/core/agent/tests/verify-export-jsdoc.spec.ts',
      'packages/typert/generator/tests/cordis-catalog.spec.ts',
    ],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Process isolation prevents global Cordis/service state from leaking
    // across independently authored package suites.
    pool: 'forks',
  },
})
