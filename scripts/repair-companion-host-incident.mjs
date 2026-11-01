import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'vite';

// No automatic library discovery and no default writer. The compiled entry
// accepts only a reviewed fixed domain manifest; it is not a SQL console.
const require = createRequire(import.meta.url), output = path.resolve('artifacts/host-incident-repair-cli');
await build({ configFile: false, logLevel: 'warn', build: { ssr: path.resolve('src/main/companions/host-incident-repair-cli.ts'),
  outDir: output, emptyOutDir: false, target: 'node24', minify: false,
  rollupOptions: { external: ['electron', 'better-sqlite3', 'koffi', 'libarchive-wasm', '7zip-bin', 'sharp'], output: { format: 'cjs', entryFileNames: 'repair.cjs' } } } });
const child = spawn(require('electron'), [path.join(output, 'repair.cjs'), ...process.argv.slice(2)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
await new Promise(resolve => child.once('exit', code => { process.exitCode = code ?? 1; resolve(); }));
