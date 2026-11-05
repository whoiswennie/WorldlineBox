import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.vite/**',
      '.claude/**',
      '.worktrees/**',
      '.media-build/**',
      '.tools/**',
      'artifacts/**',
      'dist/**',
      'out/**',
      'coverage/**',
      // Electron/Playwright-generated traces, reports, and runtime fixtures.
      'test-results/**',
      'node_modules/**',
      // Pinned upstream sources are hash-verified and intentionally kept byte-for-byte.
      'vendor/vcp-memory/**',
      'resources/vcp-memory/**',
      // Vendored SoulLink SDK keeps its upstream style; compile and integration
      // tests validate the local adapters instead of rewriting third-party code.
      'vendor/soullink-emotion/**',
      // Upstream-generated Cubism Core is shipped with its original license header.
      'public/companion-call/live2dcubismcore.min.js',
      // Emscripten-generated glue (acquired by scripts/build-ufbx-wasm.mjs).
      'resources/ufbx/**',
      'resources/portable-tools/win32-x64/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'tests/node/**/*.mjs', 'resources/dsh-bridge/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended,
  { files: ['src/main/vcp-memory/**/*.cjs', 'resources/speech-runtime/**/*.cjs', 'scripts/**/*.cjs', 'tests/fixtures/bot-memory-fs-probe.cjs'], languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-redeclare': ['error', { builtinGlobals: false }] } },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
