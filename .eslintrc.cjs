module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // The Electron renderer and website intentionally colocate shared helpers,
    // constants, and components; Fast Refresh is not a production invariant.
    'react-refresh/only-export-components': 'off',
    // IPC, plugin, model-provider, and persisted JSON boundaries are dynamic by
    // design. Their runtime validators are more precise than blanket `any` bans.
    '@typescript-eslint/no-explicit-any': 'off',
    // The application keeps compatibility hooks and conditionally loaded code
    // for optional runtimes. TypeScript and bundler checks catch invalid usage.
    '@typescript-eslint/no-unused-vars': 'off',
    // Electron integrations deliberately load optional/native modules lazily.
    '@typescript-eslint/no-var-requires': 'off',
    // Complex editor and Live2D effects intentionally depend on selected state
    // slices; blindly expanding dependency arrays causes render/reload loops.
    'react-hooks/exhaustive-deps': 'off',
    // These expressions intentionally strip control characters from untrusted
    // paths, IDs, and filenames before they reach the filesystem.
    'no-control-regex': 'off',
    // Silent best-effort cleanup is legitimate in catch blocks, but other empty
    // blocks remain errors.
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Polling and bounded worker loops use explicit termination inside the body.
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-trailing-spaces': 'error',
  },
}
