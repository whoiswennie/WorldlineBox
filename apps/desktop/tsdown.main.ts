import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { main: 'src/main.ts' },
    cwd: import.meta.dirname,
    outDir: 'lib',
    clean: false,
    dts: false,
    format: 'esm',
    platform: 'node',
    deps: {
      neverBundle: ['electron'],
      alwaysBundle: id => id === 'electron' ? undefined : true,
    },
    sourcemap: true,
  },
  {
    entry: { preload: 'src/preload.ts' },
    cwd: import.meta.dirname,
    outDir: 'lib',
    clean: false,
    dts: false,
    format: 'cjs',
    platform: 'node',
    deps: { neverBundle: ['electron'] },
    sourcemap: true,
  },
])
