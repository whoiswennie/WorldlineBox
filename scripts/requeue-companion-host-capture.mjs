import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'vite';

// Explicit offline tool. Default is read-only plan; no automatic library lookup.
const require = createRequire(import.meta.url), output = path.resolve('artifacts/host-capture-requeue-cli');
await build({ configFile: false, logLevel: 'warn', build: { ssr: path.resolve('src/main/companions/host-capture-requeue-cli.ts'), outDir: output,
  emptyOutDir: false, target: 'node24', minify: false, rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'requeue.cjs' } } } });
const child = spawn(require('electron'), [path.join(output, 'requeue.cjs'), ...process.argv.slice(2)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
await new Promise(resolve => child.once('exit', code => { process.exitCode = code ?? 1; resolve(); }));
