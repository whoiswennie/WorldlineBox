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
      'node_modules/**',
      // Pinned upstream sources are hash-verified and intentionally kept byte-for-byte.
      'vendor/vcp-memory/**',
      // Emscripten-generated glue (acquired by scripts/build-ufbx-wasm.mjs).
      'resources/ufbx/**',
      'resources/portable-tools/win32-x64/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'tests/node/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended,
  { files: ['src/main/vcp-memory/**/*.cjs', 'scripts/**/*.cjs'], languageOptions: { globals: globals.node, sourceType: 'commonjs' },
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
